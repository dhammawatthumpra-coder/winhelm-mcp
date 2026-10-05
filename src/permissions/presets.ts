import { PROFILES, type ToolProfile } from "../config/profiles.js";
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type ApprovalMode,
  type FolderPermission,
  type FolderPermissionMode,
  type ProfilePreset,
  type SchemaV2PermissionConfig,
  type ToolPolicy,
} from "../config/schema-v2.js";
import { ALL_TOOL_NAMES, SPEC_34_TIER_A_TOOL_NAMES } from "../tools/registry.js";

export const R0_TOOLS = new Set([
  "file_read",
  "file_list",
  "file_search",
  "file_search_ripgrep",
  "file_tail",
  "file_hash",
  "file_preview",
  "system_info",
  "gpu_info",
  "network_info",
  "port_check",
  "process_list",
  "service_list",
  "service_status",
  "eventlog_query",
  "terminal_task_list",
  "terminal_task_logs",
  // Spec 3.4 Tier A read-only projections and inspection/verification tools.
  "file_inspect_batch",
  "session_current",
  "session_audit_search",
  "file_provenance_lookup",
]);

export const R1_TOOLS = new Set([
  "file_write",
  "file_edit",
  "file_copy",
  "file_move",
  "file_delete_safe",
  "archive_zip",
  "archive_unzip",
  "pdf_generate",
  "notification_send",
  // Spec 3.4 Tier A governed mutation primitives.
  "file_write_atomic",
  "file_create_exclusive",
]);

export const R2_TOOLS = new Set(["http_ping", "http_request"]);
export const R3_TOOLS = new Set([
  "clipboard_get",
  "clipboard_set",
  "screen_capture",
  "system_open",
]);
export const R4_TOOLS = new Set(["process_kill", "service_control"]);
export const R5_TOOLS = new Set([
  "terminal_run",
  "terminal_task_start",
  "terminal_task_send",
  "terminal_task_kill",
  "command_run",
]);

const POLICY_CONTROLLED_CURRENT_TOOLS = [
  ...ALL_TOOL_NAMES.filter((name) => !R5_TOOLS.has(name)),
  // Spec 3.4 Tier A tools receive their Spec section 5 preset policies
  // (R0 inspection/projection -> auto; R1 mutation -> off/auto per profile).
  ...SPEC_34_TIER_A_TOOL_NAMES,
];

export interface PresetBuildOptions {
  folders?: string[];
  now?: string;
  approvalMode?: ApprovalMode;
}

function folderModeForPreset(preset: ProfilePreset): FolderPermissionMode {
  return preset === "safe" ? "read" : "readwrite";
}

function terminalModeForPreset(
  preset: ProfilePreset
): SchemaV2PermissionConfig["terminal"]["mode"] {
  if (preset === "safe") return "off";
  if (preset === "balanced" || preset === "power" || preset === "full") return "full";
  return "ask";
}

export function productProfileAllowsTool(
  preset: ProfilePreset | null | undefined,
  toolName: string
): boolean | undefined {
  if (preset !== "safe" && preset !== "balanced" && preset !== "power") {
    return undefined;
  }

  const recovery =
    toolName === "winhelm_status" || toolName === "winhelm_job_status";
  if (recovery || R0_TOOLS.has(toolName)) return true;
  if (preset === "safe") return false;

  if (
    R1_TOOLS.has(toolName) ||
    R2_TOOLS.has(toolName) ||
    R3_TOOLS.has(toolName) ||
    R5_TOOLS.has(toolName)
  ) {
    return true;
  }

  if (R4_TOOLS.has(toolName)) {
    return preset === "power";
  }

  return false;
}

function productPolicy(preset: "safe" | "balanced" | "power"): Record<string, ToolPolicy> {
  const result: Record<string, ToolPolicy> = {};

  for (const tool of POLICY_CONTROLLED_CURRENT_TOOLS) {
    if (preset === "safe") {
      result[tool] = R0_TOOLS.has(tool) ? "auto" : "off";
      continue;
    }

    if (
      R0_TOOLS.has(tool) ||
      R1_TOOLS.has(tool) ||
      R2_TOOLS.has(tool) ||
      R3_TOOLS.has(tool)
    ) {
      result[tool] = "auto";
    } else if (R4_TOOLS.has(tool)) {
      result[tool] = preset === "power" ? "auto" : "off";
    } else {
      result[tool] = "off";
    }
  }

  // Recovery tools are future schema-v2 additions and remain auto regardless
  // of product preset. They are harmless keys until the tools are registered.
  result.winhelm_status = "auto";
  result.winhelm_job_status = "auto";

  return result;
}

function legacyNamedPolicy(
  preset: Exclude<ProfilePreset, "safe" | "balanced" | "power">
): Record<string, ToolPolicy> {
  const profile = PROFILES[preset as ToolProfile];
  const membership = new Set(profile.tools);
  const result: Record<string, ToolPolicy> = {};

  for (const tool of POLICY_CONTROLLED_CURRENT_TOOLS) {
    if (!membership.has(tool)) {
      result[tool] = "off";
      continue;
    }

    if (R2_TOOLS.has(tool) || R3_TOOLS.has(tool) || R4_TOOLS.has(tool)) {
      result[tool] = "ask";
    } else {
      result[tool] = "auto";
    }
  }

  result.winhelm_status = "auto";
  result.winhelm_job_status = "auto";
  return result;
}

export function buildToolPolicyForPreset(
  preset: ProfilePreset
): Record<string, ToolPolicy> {
  if (preset === "safe" || preset === "balanced" || preset === "power") {
    return productPolicy(preset);
  }
  return legacyNamedPolicy(preset);
}

function buildFolders(
  preset: ProfilePreset,
  paths: string[]
): FolderPermission[] {
  const permission = folderModeForPreset(preset);
  return paths.map((folderPath) => ({
    path: folderPath,
    permission,
  }));
}

export function buildPresetConfig(
  preset: ProfilePreset,
  options: PresetBuildOptions = {}
): SchemaV2PermissionConfig {
  const folders = buildFolders(preset, options.folders ?? []);
  const terminal = { mode: terminalModeForPreset(preset) };
  const toolPolicy = buildToolPolicyForPreset(preset);
  const appliedAt = options.now ?? new Date().toISOString();
  const productPreset =
    preset === "safe" || preset === "balanced" || preset === "power";
  const approvalMode =
    options.approvalMode ?? (productPreset ? "smart" : undefined);

  return {
    schemaVersion: 2,
    profilePreset: preset,
    folders,
    terminal,
    toolPolicy,
    approval: {
      ...(approvalMode ? { mode: approvalMode } : {}),
      channels: [...DEFAULT_APPROVAL_CONFIG.channels],
      blockHoldMs: DEFAULT_APPROVAL_CONFIG.blockHoldMs,
      jobTtlMs: DEFAULT_APPROVAL_CONFIG.jobTtlMs,
      maxPending: DEFAULT_APPROVAL_CONFIG.maxPending,
    },
    network: { ...DEFAULT_NETWORK_CONFIG },
    profileState: {
      preset,
      appliedAt,
      appliedSnapshot: {
        folders: folders.map((folder) => ({ ...folder })),
        terminal: { ...terminal },
        toolPolicy: { ...toolPolicy },
      },
    },
  };
}
