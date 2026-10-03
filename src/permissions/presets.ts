import { PROFILES, type ToolProfile } from "../config/profiles.js";
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type FolderPermission,
  type FolderPermissionMode,
  type ProfilePreset,
  type SchemaV2PermissionConfig,
  type ToolPolicy,
} from "../config/schema-v2.js";
import { ALL_TOOL_NAMES } from "../tools/registry.js";

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
]);

const POLICY_CONTROLLED_CURRENT_TOOLS = ALL_TOOL_NAMES.filter(
  (name) => !R5_TOOLS.has(name)
);

export interface PresetBuildOptions {
  folders?: string[];
  now?: string;
}

function folderModeForPreset(preset: ProfilePreset): FolderPermissionMode {
  return preset === "safe" ? "read" : "readwrite";
}

function terminalModeForPreset(
  preset: ProfilePreset
): SchemaV2PermissionConfig["terminal"]["mode"] {
  if (preset === "safe") return "off";
  if (preset === "power" || preset === "full") return "full";
  return "ask";
}

function productPolicy(preset: "safe" | "balanced" | "power"): Record<string, ToolPolicy> {
  const result: Record<string, ToolPolicy> = {};

  for (const tool of POLICY_CONTROLLED_CURRENT_TOOLS) {
    if (preset === "safe") {
      // Safe excludes background task introspection per Appendix A even though
      // those tools are read-only.
      if (tool === "terminal_task_list" || tool === "terminal_task_logs") {
        result[tool] = "off";
      } else {
        result[tool] = R0_TOOLS.has(tool) ? "auto" : "off";
      }
      continue;
    }

    if (R0_TOOLS.has(tool) || R1_TOOLS.has(tool)) {
      result[tool] = "auto";
    } else if (R2_TOOLS.has(tool)) {
      result[tool] = preset === "power" ? "auto" : "ask";
    } else if (R3_TOOLS.has(tool) || R4_TOOLS.has(tool)) {
      result[tool] = "ask";
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

  return {
    schemaVersion: 2,
    profilePreset: preset,
    folders,
    terminal,
    toolPolicy,
    approval: {
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
