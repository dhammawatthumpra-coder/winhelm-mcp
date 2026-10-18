import crypto from "node:crypto";
import {
  consumeDecisionCapability,
  type ApprovalDecisionVerb,
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
 * winhelm-approval:decide?jobId=job_...&decision=approved&token=...
 */
export function parseApprovalProtocolUri(
  uri: string
): {
  jobId?: string;
  decision?: "approved" | "denied";
  token?: string;
  journalPath?: string;
} {
  try {
    const normalized = uri.replace(/^winhelm-approval:\/?\/?/i, "http://local/");
    const parsed = new URL(normalized);
    const jobId = parsed.searchParams.get("jobId") || undefined;
    const rawDecision = parsed.searchParams.get("decision");
    const decision =
      rawDecision === "approved" || rawDecision === "denied"
        ? rawDecision
        : undefined;
    const token = parsed.searchParams.get("token") || undefined;
    const journalPath = parsed.searchParams.get("journal") || undefined;
    return { jobId, decision, token, journalPath };
  } catch {
    return {};
  }
}

/**
 * Executes a native approval decision (approve or deny) through the verified
 * decision capability channel, enforcing cryptographic proof-of-possession
 * and authoritative job binding.
 */
export async function executeNativeDecision(
  jobId: string,
  decision: "approved" | "denied",
  token: string | undefined,
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

  if (!token || typeof token !== "string" || !token.trim()) {
    return {
      ok: false,
      code: "MISSING_ACTIVATION_TOKEN",
      message: "An activation token is required for native approval decisions.",
      jobId: id,
    };
  }

  const journalPath = options.journalPath ?? defaultApprovalJournalPath();
  const channel = options.channel ?? "native_ux";

  // 1. Atomically consume decision capability and verify proof-of-possession
  const consumed = consumeDecisionCapability(id, token, decision, journalPath);
  if (!consumed.ok) {
    const errorMessages: Record<string, string> = {
      NOT_FOUND: "Approval job decision capability not found.",
      EXPIRED: "Approval job has expired and can no longer be decided.",
      ALREADY_CONSUMED: "This approval job has already been decided.",
      INVALID_ARGUMENT: "Invalid jobId or decision parameter.",
      MISSING_ACTIVATION_TOKEN: "An activation token is required.",
      DECISION_NOT_ALLOWED: "Decision verb is not permitted for this capability.",
      INVALID_CAPABILITY_TOKEN:
        "Invalid activation token; proof-of-possession verification failed.",
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

  // 2. Local Engine Authority Path
  if (engine.ownsJob(id)) {
    const localJob = engine.get(id);
    if (!localJob) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Authoritative local approval job not found.",
        jobId: id,
      };
    }

    // Verify authoritative local job binding
    if (
      localJob.fingerprint !== capability.fingerprint ||
      localJob.createdAt !== capability.createdAt
    ) {
      return {
        ok: false,
        code: "BINDING_MISMATCH",
        message: "Capability does not match authoritative local job identity.",
        jobId: id,
      };
    }

    if (localJob.state !== "awaiting_approval") {
      return {
        ok: false,
        code: "CONFLICT",
        state: localJob.state,
        message: `Job is no longer awaiting approval (current state: ${localJob.state}).`,
        jobId: id,
      };
    }

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
    // 3. Cross-Process Coordination Authority Path (DEF-02)
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

    // Check owning process liveness
    if (!isProcessAlive(capability.pid)) {
      return {
        ok: false,
        code: "OWNER_UNAVAILABLE",
        message:
          "The WinHelm instance that owns this job is no longer running; the action cannot be executed.",
        jobId: id,
      };
    }

    // Check same-PID orphan across restart
    if (capability.pid === process.pid) {
      return {
        ok: false,
        code: "OWNER_UNAVAILABLE",
        message:
          "The job executor was lost across instance restart; the action cannot be executed.",
        jobId: id,
      };
    }

    // Read and verify authoritative cross-process mirror request
    const mirror = readRequest(id, journalPath);
    if (!mirror) {
      return {
        ok: false,
        code: "OWNER_UNAVAILABLE",
        message:
          "Authoritative cross-process mirror request not found; owning instance unavailable.",
        jobId: id,
      };
    }

    if (
      mirror.job.fingerprint !== capability.fingerprint ||
      mirror.instanceId !== capability.instanceId ||
      mirror.pid !== capability.pid ||
      mirror.job.createdAt !== capability.createdAt
    ) {
      return {
        ok: false,
        code: "BINDING_MISMATCH",
        message:
          "Capability does not match authoritative cross-process mirror binding.",
        jobId: id,
      };
    }

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
        message:
          "Timed out waiting for the owning WinHelm process to execute the decision.",
        jobId: id,
      };
    }
    finalState = outcome.state;
  }

  // 4. Audit logging (CRITICAL: Record only truncated token hash fingerprint, NEVER raw token)
  try {
    const tokenFingerprint = crypto
      .createHash("sha256")
      .update(token, "utf8")
      .digest("hex")
      .slice(0, 12);

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
        tokenFingerprint,
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
