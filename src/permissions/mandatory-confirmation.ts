import type { ApprovalMode } from "../config/schema-v2.js";
import type { ProcessOwnershipLookup } from "./process-kill.js";
import { processKillNeedsExternalApproval } from "./process-kill.js";
import { getToolRiskClass } from "./risk.js";

export interface MandatoryConfirmationResult {
  required: boolean;
  code?: "EXTERNAL_PROCESS_TERMINATION" | "HOST_SYSTEM_MUTATION";
  reason?: string;
}

/**
 * Runtime classifier for tool calls whose concrete target determines whether
 * the product security floor requires confirmation. Existing external
 * process-kill protection remains active for legacy schema-v2 configs too.
 */
export function classifyToolMandatoryConfirmation(
  toolName: string,
  args: Record<string, unknown>,
  ownership: ProcessOwnershipLookup,
  approvalMode: ApprovalMode | undefined
): MandatoryConfirmationResult {
  if (
    toolName === "process_kill" &&
    processKillNeedsExternalApproval(args, ownership)
  ) {
    return {
      required: true,
      code: "EXTERNAL_PROCESS_TERMINATION",
      reason:
        "Terminating a process not proven to be one concrete WinHelm-owned PID requires explicit approval.",
    };
  }

  // Absence of approval.mode is the frozen v1.3 compatibility path. Do not add
  // new confirmation requirements there except the pre-existing process rule.
  if (!approvalMode) {
    return { required: false };
  }

  if (toolName !== "process_kill" && getToolRiskClass(toolName) === "R4") {
    return {
      required: true,
      code: "HOST_SYSTEM_MUTATION",
      reason:
        "Host/system mutation requires explicit human confirmation in every Approval Mode.",
    };
  }

  return { required: false };
}
