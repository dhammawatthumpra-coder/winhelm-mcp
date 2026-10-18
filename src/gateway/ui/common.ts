/**
 * WinHelm v1.4.1 Product Shell — Common Helpers and Types
 */

/**
 * Escape HTML special characters to prevent Cross-Site Scripting (XSS).
 */
export function escapeHtml(str: any): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type NativeApprovalIntegrationStatus =
  | "ready"
  | "needs_repair"
  | "unavailable"
  | "unknown";

export type DynamicInternalPortsMode =
  | "automatic"
  | "fixed"
  | "unavailable"
  | "unknown";

export interface DynamicEndpointInfo {
  service: string;
  url: string;
  status: string;
}

export interface DynamicInternalPortsStatus {
  mode: DynamicInternalPortsMode;
  endpoints?: DynamicEndpointInfo[];
}

export type SetupAssistantIntegrationStatus =
  | "installed_ready"
  | "needs_attention"
  | "unavailable"
  | "unknown";

export interface CrossTrancheAdapters {
  nativeApproval?: NativeApprovalIntegrationStatus;
  dynamicPorts?: DynamicInternalPortsStatus;
  setupAssistant?: SetupAssistantIntegrationStatus;
}

export interface ShellRenderContext {
  activeProfile: string;
  schemaMode: "legacy" | "v2" | "invalid";
  preset: string;
  displayProfile?: string;
  isModified: boolean;
  terminalMode: string;
  approvalMode: string;
  focusJobId: string;
  locale: string;
  messages: Record<string, string>;
  clientScriptMessages: string;
  adapters?: CrossTrancheAdapters;
}
