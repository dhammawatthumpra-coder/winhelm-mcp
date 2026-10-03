import { getToolRiskPresentation } from "../permissions/risk.js";
import { auditLogger, type AuditEvent } from "../utils/audit-logger.js";
import type { ApprovalJob } from "./approval-engine.js";

export type ApprovalDecision =
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export interface ApprovalDecisionContext {
  /** Local channel that produced the decision: dashboard, cli or system. */
  channel?: string;
  ip?: string;
  authType?: AuditEvent["actor"]["authType"];
}

/**
 * Baseline 8.3 requires approval, denial and expiry to be auditable with the
 * decision latency (also the T6 approval-fatigue measurement). Only metadata is
 * recorded: never the tool arguments, which may carry secrets.
 */
export function logApprovalDecision(
  job: ApprovalJob,
  decision: ApprovalDecision,
  context: ApprovalDecisionContext = {}
): void {
  const channel = context.channel ?? "unknown";
  const latencyMs = Math.max(0, (job.updatedAt || job.createdAt) - job.createdAt);

  auditLogger.log({
    event: "APPROVAL_DECISION",
    severity: decision === "approved" ? "INFO" : "WARN",
    actor: {
      ...(context.ip ? { ip: context.ip } : {}),
      authType: context.authType ?? "none",
      sessionId: job.sessionId,
    },
    action: `${channel} ${decision}`,
    resource: job.tool,
    outcome: decision === "approved" ? "ALLOWED" : "DENIED",
    details: {
      jobId: job.id,
      tool: job.tool,
      decision,
      channel,
      latencyMs,
      riskClass: getToolRiskPresentation(job.tool).class,
      executionCount: job.executionCount,
    },
  });
}
