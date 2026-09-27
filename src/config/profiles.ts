/**
 * WinHelm Tool Profiles
 * Allows AI agents to load only required tools to optimize context window and tokens
 */

export type ToolProfile = "full" | "core" | "dev" | "sysadmin" | "minimal" | "custom";

export interface ProfileDefinition {
  name: string;
  description: string;
  tools: string[];
  includesResource: boolean;
}

export const PROFILES: Record<ToolProfile, ProfileDefinition> = {
  minimal: {
    name: "Minimal",
    description: "6 essential tools for small models (Claude Haiku, Llama 8B, local LLMs) with ~85% token reduction",
    tools: [
      "terminal_run",
      "file_read",
      "file_write",
      "file_list",
      "file_search",
      "system_info",
    ],
    includesResource: false,
  },
  core: {
    name: "Core",
    description: "15 essential tools for daily coding and file operations",
    tools: [
      "terminal_run",
      "file_read",
      "file_write",
      "file_edit",
      "file_list",
      "file_search",
      "file_copy",
      "file_move",
      "file_tail",
      "file_hash",
      "file_delete_safe",
      "system_info",
      "gpu_info",
      "process_list",
      "port_check",
    ],
    includesResource: false,
  },
  dev: {
    name: "Developer",
    description: "28 tools for software engineering, background tasks, ripgrep, archives, HTTP API testing, PDF reports, and previews",
    tools: [
      "terminal_run",
      "file_read",
      "file_write",
      "file_edit",
      "file_list",
      "file_search",
      "file_copy",
      "file_move",
      "file_tail",
      "file_hash",
      "file_delete_safe",
      "system_info",
      "gpu_info",
      "process_list",
      "port_check",
      "terminal_task_start",
      "terminal_task_list",
      "terminal_task_logs",
      "terminal_task_send",
      "terminal_task_kill",
      "file_search_ripgrep",
      "archive_zip",
      "archive_unzip",
      "http_ping",
      "http_request",
      "pdf_generate",
      "system_open",
      "file_preview",
    ],
    includesResource: true,
  },
  sysadmin: {
    name: "System Admin",
    description: "37 tools for IT management, services, event logs, network, background tasks, ripgrep, archives, and desktop automation (all except pdf_generate)",
    tools: [
      "terminal_run",
      "file_read",
      "file_write",
      "file_edit",
      "file_list",
      "file_search",
      "file_copy",
      "file_move",
      "file_tail",
      "file_hash",
      "file_delete_safe",
      "system_info",
      "gpu_info",
      "process_list",
      "port_check",
      "process_kill",
      "eventlog_query",
      "network_info",
      "service_list",
      "service_status",
      "service_control",
      "screen_capture",
      "system_open",
      "clipboard_get",
      "clipboard_set",
      "notification_send",
      "http_ping",
      "http_request",
      "terminal_task_start",
      "terminal_task_list",
      "terminal_task_logs",
      "terminal_task_send",
      "terminal_task_kill",
      "file_search_ripgrep",
      "archive_zip",
      "archive_unzip",
      "file_preview",
    ],
    includesResource: true,
  },
  full: {
    name: "Full Suite",
    description: "All 38 native Windows tools and interactive preview resources",
    tools: [
      "terminal_run",
      "terminal_task_start",
      "terminal_task_list",
      "terminal_task_logs",
      "terminal_task_send",
      "terminal_task_kill",
      "file_read",
      "file_write",
      "file_edit",
      "file_list",
      "file_search",
      "file_delete_safe",
      "file_move",
      "file_copy",
      "archive_zip",
      "archive_unzip",
      "file_tail",
      "file_hash",
      "file_search_ripgrep",
      "pdf_generate",
      "file_preview",
      "clipboard_get",
      "clipboard_set",
      "screen_capture",
      "system_open",
      "notification_send",
      "system_info",
      "gpu_info",
      "process_list",
      "process_kill",
      "port_check",
      "eventlog_query",
      "service_list",
      "service_status",
      "service_control",
      "http_ping",
      "http_request",
      "network_info",
    ],
    includesResource: true,
  },
  custom: {
    name: "Custom",
    description: "User-defined tool selection via --tools or config.json",
    tools: [],
    includesResource: true,
  },
};

export function resolveCustomTools(
  baseProfile: ToolProfile = "full",
  toolsArg?: string,
  configCustomTools?: string[]
): string[] | undefined {
  if (!toolsArg && (!configCustomTools || configCustomTools.length === 0)) {
    return undefined;
  }
  const rawList = toolsArg
    ? toolsArg.split(",").map((t) => t.trim()).filter(Boolean)
    : configCustomTools || [];

  const hasAdd = rawList.some((t) => t.startsWith("+"));
  const hasRemove = rawList.some((t) => t.startsWith("-"));

  if (hasAdd || hasRemove) {
    const baseTools = new Set((PROFILES[baseProfile] || PROFILES.full).tools);
    for (const item of rawList) {
      if (item.startsWith("+")) {
        baseTools.add(item.slice(1).trim());
      } else if (item.startsWith("-")) {
        baseTools.delete(item.slice(1).trim());
      } else {
        baseTools.add(item);
      }
    }
    return Array.from(baseTools);
  }

  return rawList;
}

export function isToolInProfile(toolName: string, profile: ToolProfile = "full", customTools?: string[]): boolean {
  if (customTools && customTools.length > 0) {
    return customTools.includes(toolName);
  }
  const p = PROFILES[profile] || PROFILES.full;
  return p.tools.includes(toolName);
}

export function isValidProfile(profile: string): profile is ToolProfile {
  return profile in PROFILES;
}
