import type { TerminalMode, ToolPolicy } from "../config/schema-v2.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionDecisionResult {
  decision: PermissionDecision;
  code: "POLICY_AUTO" | "POLICY_ASK" | "POLICY_OFF" | "TERMINAL_SAFE";
  reason: string;
}

/**
 * Pure call-time policy primitive for schema-v2.
 * Missing policy is fail-closed.
 */
export function evaluateToolPolicy(policy: ToolPolicy | undefined): PermissionDecisionResult {
  switch (policy) {
    case "auto":
      return {
        decision: "allow",
        code: "POLICY_AUTO",
        reason: "Tool policy permits automatic execution.",
      };
    case "ask":
      return {
        decision: "ask",
        code: "POLICY_ASK",
        reason: "Tool policy requires human approval.",
      };
    case "off":
    default:
      return {
        decision: "deny",
        code: "POLICY_OFF",
        reason: "Tool policy is disabled or missing.",
      };
  }
}

/**
 * Terminal permission primitive. "safe" means execution may proceed only
 * through the future safe-command adapter; this function does not itself
 * authorize an arbitrary command.
 */
export function evaluateTerminalMode(mode: TerminalMode): PermissionDecisionResult {
  switch (mode) {
    case "ask":
      return {
        decision: "ask",
        code: "POLICY_ASK",
        reason: "Terminal mode requires human approval.",
      };
    case "full":
      return {
        decision: "allow",
        code: "POLICY_AUTO",
        reason: "Terminal mode permits execution subject to runtime safety gates.",
      };
    case "dangerous":
      return {
        decision: "deny",
        code: "POLICY_OFF",
        reason:
          "Dangerous terminal mode is reserved for WinHelm v1.4 and is not executable in the v1.3 permission runtime.",
      };
    case "safe":
      return {
        decision: "allow",
        code: "TERMINAL_SAFE",
        reason: "Terminal mode permits only the safe-command adapter.",
      };
    case "off":
    default:
      return {
        decision: "deny",
        code: "POLICY_OFF",
        reason: "Terminal execution is disabled.",
      };
  }
}
