import type { ApprovalMode } from "../config/schema-v2.js";
import {
  getToolRiskClass,
  type ToolRiskClass,
} from "./risk.js";

export type ApprovalModeDecision = "allow" | "ask";

export interface ApprovalModeEvaluationContext {
  explicitConfirmationFloor?: boolean;
  mandatoryConfirmation?: boolean;
  terminalExecution?: "safe-adapter" | "direct";
  riskClassOverride?: ToolRiskClass;
}

export interface ApprovalModeEvaluationResult {
  decision: ApprovalModeDecision;
  code:
    | "APPROVAL_MODE_AUTO"
    | "APPROVAL_MODE_ASK"
    | "EXPLICIT_CONFIRMATION_FLOOR"
    | "MANDATORY_CONFIRMATION";
  reason: string;
  riskClass: ToolRiskClass;
}

/**
 * Approval Mode is evaluated only after the capability/security layer has
 * already established that the action is permitted. It can add prompting but
 * can never turn a denied capability into an allowed one.
 */
export function evaluateApprovalMode(
  toolName: string,
  mode: ApprovalMode,
  context: ApprovalModeEvaluationContext = {}
): ApprovalModeEvaluationResult {
  const riskClass =
    context.riskClassOverride ?? getToolRiskClass(toolName);

  if (context.explicitConfirmationFloor) {
    return {
      decision: "ask",
      code: "EXPLICIT_CONFIRMATION_FLOOR",
      reason:
        "This capability has an explicit confirmation floor that Approval Mode cannot bypass.",
      riskClass,
    };
  }

  if (context.mandatoryConfirmation) {
    return {
      decision: "ask",
      code: "MANDATORY_CONFIRMATION",
      reason:
        "This high-impact action requires explicit human confirmation in every Approval Mode.",
      riskClass,
    };
  }

  if (riskClass === "R0") {
    return {
      decision: "allow",
      code: "APPROVAL_MODE_AUTO",
      reason: "Read-only/recovery actions run automatically in every Approval Mode.",
      riskClass,
    };
  }

  if (mode === "manual") {
    return {
      decision: "ask",
      code: "APPROVAL_MODE_ASK",
      reason: "Manual Approval Mode requires confirmation for permitted state-changing actions.",
      riskClass,
    };
  }

  if (mode === "trusted") {
    return {
      decision: "allow",
      code: "APPROVAL_MODE_AUTO",
      reason: "Trusted Approval Mode permits this capability without a routine prompt.",
      riskClass,
    };
  }

  // Smart is risk-sensitive. R1 local mutation and the constrained safe-command
  // adapter are automatic; network, desktop/user-data, host control, and direct
  // execution remain approval-gated.
  if (
    riskClass === "R1" ||
    (riskClass === "R5" && context.terminalExecution === "safe-adapter")
  ) {
    return {
      decision: "allow",
      code: "APPROVAL_MODE_AUTO",
      reason: "Smart Approval Mode permits this bounded action automatically.",
      riskClass,
    };
  }

  return {
    decision: "ask",
    code: "APPROVAL_MODE_ASK",
    reason: "Smart Approval Mode requires confirmation for this risk class.",
    riskClass,
  };
}

export function approvalModeProtectionRank(mode: ApprovalMode): number {
  switch (mode) {
    case "manual":
      return 0;
    case "smart":
      return 1;
    case "trusted":
      return 2;
  }
}
