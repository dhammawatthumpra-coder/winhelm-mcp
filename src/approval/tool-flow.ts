import type { ApprovalConfig } from "../config/schema-v2.js";
import { translate as t } from "../i18n/messages.js";
import {
  ApprovalEngine,
  ApprovalEngineError,
  type ApprovalJob,
} from "./approval-engine.js";

export interface ApprovalFlowContext {
  sessionId?: string;
  requestId?: string | number;
  signal?: AbortSignal;
}

export interface ApprovalFlowInput<T = any> {
  engine: ApprovalEngine;
  tool: string;
  args: Record<string, unknown>;
  /** Original caller args when `args` carries added display metadata. */
  fingerprintArgs?: Record<string, unknown>;
  approval: ApprovalConfig;
  context: ApprovalFlowContext;
  execute: () => Promise<T>;
}

function structuredError(
  code: string,
  message: string,
  userAction?: string,
  details?: Record<string, unknown>
): any {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code,
            message,
            ...(userAction ? { userAction } : {}),
            ...(details ? { details } : {}),
          },
        }),
      },
    ],
  };
}

function receipt(job: ApprovalJob, now = Date.now()): any {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "awaiting_approval",
          jobId: job.id,
          expiresInSeconds: Math.max(
            0,
            Math.ceil((job.expiresAt - now) / 1000)
          ),
          message:
            "Waiting for the user to approve in WinHelm. After approval, call winhelm_job_status with this jobId. Do not re-run the original tool.",
        }),
      },
    ],
  };
}

function terminalResult(job: ApprovalJob): any {
  switch (job.state) {
    case "completed":
      return job.result;
    case "failed":
      return structuredError(
        "INTERNAL_ERROR",
        job.error || "Approved action failed.",
        t("action.approval.review_before_retry"),
        { jobId: job.id }
      );
    case "denied":
      return structuredError(
        "PERMISSION_DENIED",
        "The user denied this WinHelm action.",
        t("action.approval.denied"),
        { jobId: job.id }
      );
    case "expired":
      return structuredError(
        "APPROVAL_EXPIRED",
        "The WinHelm approval request expired before it was approved.",
        t("action.approval.expired"),
        { jobId: job.id }
      );
    case "cancelled":
      return structuredError(
        "CANCELLED",
        "The WinHelm approval request was cancelled.",
        t("action.approval.cancelled"),
        { jobId: job.id }
      );
    case "unknown":
      return structuredError(
        "APPROVAL_UNKNOWN",
        job.error ||
          "The outcome of this WinHelm action is indeterminate; it was not re-run.",
        t("action.approval.review_before_retry"),
        { jobId: job.id }
      );
    default:
      return structuredError(
        "CONFLICT",
        `Approval job is not terminal (state: ${job.state}).`,
        t("action.approval.use_status"),
        { jobId: job.id, state: job.state }
      );
  }
}

export async function runToolWithHybridApproval<T = any>(
  input: ApprovalFlowInput<T>
): Promise<any> {
  const sessionId =
    input.context.sessionId ?? `local-process-${process.pid}`;

  let requested;
  try {
    requested = input.engine.request<T>({
      tool: input.tool,
      args: input.args,
      fingerprintArgs: input.fingerprintArgs,
      sessionId,
      requestId: input.context.requestId,
      ttlMs: input.approval.jobTtlMs,
      maxPending: input.approval.maxPending,
      execute: input.execute,
    });
  } catch (err) {
    if (err instanceof ApprovalEngineError) {
      return structuredError(
        err.code,
        err.message,
        t("action.approval.resolve_pending")
      );
    }
    throw err;
  }

  if (requested.kind === "recent_equivalent") {
    const job = requested.job;

    // Session-bound recovery may return the already-completed result without
    // executing again. A retry from another/new session is fail-closed.
    if (job.sessionId === sessionId) {
      if (job.state === "completed") return job.result;
      if (
        job.state === "denied" ||
        job.state === "expired" ||
        job.state === "cancelled" ||
        job.state === "failed" ||
        job.state === "unknown"
      ) {
        return terminalResult(job);
      }
      return structuredError(
        "CONFLICT",
        "An equivalent WinHelm action is already in progress.",
        t("action.approval.use_status"),
        { jobId: job.id, state: job.state }
      );
    }

    return structuredError(
      "CONFLICT",
      "A recent equivalent WinHelm action exists in another session. The retry was blocked to prevent duplicate side effects.",
      t("action.approval.review_recent"),
      { state: job.state }
    );
  }

  const outcome = await input.engine.waitForTerminalOrReceipt<T>(
    requested.job.id,
    input.approval.blockHoldMs,
    input.context.signal
  );

  if (outcome.kind === "receipt") {
    return receipt(outcome.job);
  }

  return terminalResult(outcome.job);
}

export function formatApprovalJobStatus(
  job: ApprovalJob | undefined
): any {
  if (!job) {
    return structuredError(
      "NOT_FOUND",
      "Approval job was not found for this MCP session.",
      t("action.job.check_id")
    );
  }

  const base = {
    status: job.state,
    jobId: job.id,
    tool: job.tool,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    executionCount: job.executionCount,
  };

  if (job.state === "completed") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...base, result: job.result }),
        },
      ],
    };
  }

  if (job.state === "failed") {
    return structuredError(
      "INTERNAL_ERROR",
      job.error || "Approved action failed.",
      t("action.job.review"),
      base
    );
  }

  // A restarted WinHelm cannot know whether an interrupted action ran. Report
  // it as indeterminate so the caller does not silently re-run a side effect.
  if (job.state === "unknown") {
    return structuredError(
      "APPROVAL_UNKNOWN",
      job.error ||
        "The outcome of this WinHelm action is indeterminate; it was not re-run.",
      t("action.approval.review_before_retry"),
      base
    );
  }

  return {
    content: [{ type: "text", text: JSON.stringify(base) }],
  };
}
