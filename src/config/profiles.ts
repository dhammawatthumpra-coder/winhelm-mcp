/**
 * WinHelm Tool Profiles
 * Allows AI agents to load only required tools to optimize context window and tokens
 */

export type ToolProfile = "full" | "core" | "dev" | "sysadmin";

export interface ProfileDefinition {
  name: string;
  description: string;
  tools: string[];
  includesResource: boolean;
}

export const PROFILES: Record<ToolProfile, ProfileDefinition> = {
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
    description: "25 tools for software engineering, background tasks, ripgrep, archives, and previews",
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
      "file_preview",
    ],
    includesResource: true,
  },
  sysadmin: {
    name: "System Admin",
    description: "32 tools for IT management, services, event logs, network, and desktop automation",
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
      "terminal_task_kill",
    ],
    includesResource: false,
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
};

export function isToolInProfile(toolName: string, profile: ToolProfile = "full"): boolean {
  const p = PROFILES[profile] || PROFILES.full;
  return p.tools.includes(toolName);
}

export function isValidProfile(profile: string): profile is ToolProfile {
  return profile in PROFILES;
}
