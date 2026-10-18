import {
  consumeDecisionCapability,
} from "./decision-capability.js";
import {
  getApprovalEngine,
} from "./runtime.js";
import {
  isProcessAlive,
  readRequest,
  waitForCrossProcessOutcome,
  writeDecision,
} from "./cross-process.js";
import { defaultApprovalJournalPath } from "./journal.js";
import { sendNotification } from "../engine/system.js";
import { auditLogger } from "../utils/audit-logger.js";

export interface NativeDecisionResult {
  ok: boolean;
  code?: string;
  state?: string;
  message?: string;
  jobId: string;
}

export interface NativeDecisionOptions {
  channel?: string;
  journalPath?: string;
  notifyOutcome?: boolean;
}

function safeJobId(jobId: string): string | null {
  return /^job_[A-Za-z0-9_-]+$/.test(jobId) ? jobId : null;
}

/**
 * Parses a custom URI protocol string formatted as:
 * winhelm-approval:decide?jobId=job_...&decision=approved
 */
export function parseApprovalProtocolUri(
  uri: string
): { jobId?: string; decision?: "approved" | "denied" } {
  try {
    const normalized = uri.replace(/^winhelm-approval:\/?\/?/i, "http://local/");
    const parsed = new URL(normalized);
    const jobId = parsed.searchParams.get("jobId") || undefined;
    const rawDecision = parsed.searchParams.get("decision");
    const decision =
      rawDecision === "approved" || rawDecision === "denied"
        ? rawDecision
        : undefined;
    return { jobId, decision };
  } catch {
    return {};
  }
}

/**
 * Executes a native approval decision (approve or deny) through the verified
 * decision capability channel without requiring terminal interaction or full AdminAuth.
 */
export async function executeNativeDecision(
  jobId: string,
  decision: "approved" | "denied",
  options: NativeDecisionOptions = {}
): Promise<NativeDecisionResult> {
  const id = safeJobId(jobId);
  if (!id) {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "Invalid jobId format.",
      jobId,
    };
  }

  if (decision !== "approved" && decision !== "denied") {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "Decision must be 'approved' or 'denied'.",
      jobId: id,
    };
  }

  const journalPath = options.journalPath ?? defaultApprovalJournalPath();
  const channel = options.channel ?? "native_ux";

  // 1. Consume decision capability (single-use, bounded expiry)
  const consumed = consumeDecisionCapability(id, journalPath);
  if (!consumed.ok) {
    const errorMessages: Record<string, string> = {
      NOT_FOUND: "Approval job decision capability not found.",
      EXPIRED: "Approval job has expired and can no longer be decided.",
      ALREADY_CONSUMED: "This approval job has already been decided.",
      INVALID_ARGUMENT: "Invalid jobId parameter.",
    };

    return {
      ok: false,
      code: consumed.code,
      message: errorMessages[consumed.code] || "Capability consumption failed.",
      jobId: id,
    };
  }

  const capability = consumed.capability;
  const engine = getApprovalEngine();

  let finalState: string | undefined;

  // 2. Check if local engine owns the job
  if (engine.ownsJob(id)) {
    const outcome =
      decision === "approved"
        ? engine.approve(id, channel)
        : engine.deny(id, channel);

    if (!outcome.ok) {
      return {
        ok: false,
        code: outcome.code,
        state: outcome.job?.state,
        message:
          outcome.code === "CONFLICT"
            ? `Job is no longer awaiting approval (current state: ${outcome.job?.state}).`
            : "Approval transition failed.",
        jobId: id,
      };
    }

    finalState = outcome.job.state;
  } else {
    // If the local engine has this job in memory (e.g. restored from restart as "unknown"),
    // check its state. If not awaiting_approval, fail with CONFLICT.
    const localJob = engine.get(id);
    if (localJob && localJob.state !== "awaiting_approval") {
      return {
        ok: false,
        code: "CONFLICT",
        state: localJob.state,
        message: `Job is in '${localJob.state}' state and cannot be decided.`,
        jobId: id,
      };
    }

    // 3. Cross-process routing: check owner liveness
    if (!isProcessAlive(capability.pid)) {
      return {
        ok: false,
        code: "OWNER_UNAVAILABLE",
        message:
          "The WinHelm instance that owns this job is no longer running; the action cannot be executed.",
        jobId: id,
      };
    }

    // If capability was issued by the current process but the current engine does not own it,
    // the job executor was lost across instance restart or reset.
    if (capability.pid === process.pid) {
      return {
        ok: false,
        code: "OWNER_UNAVAILABLE",
        message:
          "The job executor was lost across instance restart; the action cannot be executed.",
        jobId: id,
      };
    }

    const mirror = readRequest(id, journalPath);
    if (mirror) {
      if (mirror.job.state !== "awaiting_approval") {
        return {
          ok: false,
          code: "CONFLICT",
          state: mirror.job.state,
          message: `Job is already in '${mirror.job.state}' state.`,
          jobId: id,
        };
      }
      if (Date.now() >= mirror.job.expiresAt) {
        return {
          ok: false,
          code: "EXPIRED",
          message: "Approval job has expired.",
          jobId: id,
        };
      }
    }

    // Write cross-process decision file
    const written = writeDecision(id, decision, channel, journalPath);
    if (!written.ok) {
      return {
        ok: false,
        code: "ALREADY_DECIDED",
        message: `This approval job was already decided (${written.existing}).`,
        jobId: id,
      };
    }

    // Wait for owning process to consume and execute
    const outcome = await waitForCrossProcessOutcome(id, 12000, journalPath);
    if (!outcome || outcome.state === "awaiting_approval") {
      return {
        ok: false,
        code: "TIMEOUT",
        message: "Timed out waiting for the owning WinHelm process to execute the decision.",
        jobId: id,
      };
    }
    finalState = outcome.state;
  }

  // 4. Audit logging
  try {
    auditLogger.log({
      event: decision === "approved" ? "APPROVAL_APPROVED" : "APPROVAL_DENIED",
      severity: "INFO",
      actor: { authType: "none" },
      action: `${decision.toUpperCase()} ${id}`,
      outcome: decision === "approved" ? "ALLOWED" : "DENIED",
      details: {
        jobId: id,
        authType: "local_capability",
        channel,
        decision,
        state: finalState,
        fingerprint: capability.fingerprint,
      },
    });
  } catch {
    // Audit write failure must not block decision response
  }

  // 5. User feedback notification (optional, best effort)
  if (options.notifyOutcome) {
    try {
      const verb = decision === "approved" ? "Approved" : "Denied";
      void sendNotification(
        `WinHelm Action ${verb}`,
        `Approval for ${id} has been recorded (${finalState}).`,
        false
      );
    } catch {
      // Best effort feedback
    }
  }

  return {
    ok: true,
    state: finalState,
    jobId: id,
    message:
      finalState === "pending"
        ? "Decision recorded; awaiting owner execution."
        : `Action ${decision} (${finalState}).`,
  };
}
