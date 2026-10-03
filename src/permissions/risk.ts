import {
  R0_TOOLS,
  R1_TOOLS,
  R2_TOOLS,
  R3_TOOLS,
  R4_TOOLS,
  R5_TOOLS,
} from "./presets.js";
import { isRecoveryToolName } from "../tools/registry.js";

export type ToolRiskClass = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

export interface ToolRiskPresentation {
  class: ToolRiskClass;
  level: "low" | "medium" | "elevated" | "high";
  label: string;
  description: string;
}

const PRESENTATION: Record<ToolRiskClass, Omit<ToolRiskPresentation, "class">> = {
  R0: {
    level: "low",
    label: "Read-only",
    description: "Reads or inspects information without intentionally changing the system.",
  },
  R1: {
    level: "medium",
    label: "Local change",
    description: "May create, edit, move, delete, or otherwise change local data or local UI state.",
  },
  R2: {
    level: "elevated",
    label: "Network access",
    description: "May contact an external network endpoint and exchange data outside this computer.",
  },
  R3: {
    level: "elevated",
    label: "Desktop / user data",
    description: "May read or change desktop-facing data, capture the screen, or open a target.",
  },
  R4: {
    level: "high",
    label: "System control",
    description: "May terminate processes or control Windows services.",
  },
  R5: {
    level: "high",
    label: "Command execution",
    description: "Runs a program or command on your computer.",
  },
};

const DESKTOP_DISCLOSURES: Partial<Record<string, string>> = {
  clipboard_get:
    "The current clipboard text will be returned to the AI.",
  screen_capture:
    "A screenshot of the current desktop will be returned to the AI.",
  clipboard_set:
    "AI-provided text will replace the Windows clipboard; existing clipboard content is not returned by this tool.",
  system_open:
    "Windows will open the requested target; this tool does not automatically return the opened file contents to the AI.",
};

export function getToolRiskClass(toolName: string): ToolRiskClass {
  if (isRecoveryToolName(toolName) || R0_TOOLS.has(toolName)) return "R0";
  if (R1_TOOLS.has(toolName)) return "R1";
  if (R2_TOOLS.has(toolName)) return "R2";
  if (R3_TOOLS.has(toolName)) return "R3";
  if (R4_TOOLS.has(toolName)) return "R4";
  if (R5_TOOLS.has(toolName)) return "R5";

  // Unknown tools fail toward the command-execution presentation rather than
  // being rendered as low-risk. This is UI metadata only, never authorization.
  return "R5";
}

export function getToolRiskPresentation(
  toolName: string
): ToolRiskPresentation {
  const riskClass = getToolRiskClass(toolName);
  return {
    class: riskClass,
    ...PRESENTATION[riskClass],
  };
}

export function getDesktopDataDisclosure(
  toolName: string
): string | undefined {
  return DESKTOP_DISCLOSURES[toolName];
}
