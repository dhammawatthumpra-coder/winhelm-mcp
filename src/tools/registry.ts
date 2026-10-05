/**
 * WinHelm Canonical Tool Registry
 * Single Source of Truth for all registered MCP Tool and Resource names.
 */

export const TOOL_NAMES = {
  // 1. Terminal & Background Tasks (6)
  TERMINAL_RUN: "terminal_run",
  TERMINAL_TASK_START: "terminal_task_start",
  TERMINAL_TASK_LIST: "terminal_task_list",
  TERMINAL_TASK_LOGS: "terminal_task_logs",
  TERMINAL_TASK_SEND: "terminal_task_send",
  TERMINAL_TASK_KILL: "terminal_task_kill",

  // 2. Filesystem, Safe Delete & Archives (15)
  FILE_READ: "file_read",
  FILE_WRITE: "file_write",
  FILE_EDIT: "file_edit",
  FILE_LIST: "file_list",
  FILE_SEARCH: "file_search",
  FILE_DELETE_SAFE: "file_delete_safe",
  FILE_MOVE: "file_move",
  FILE_COPY: "file_copy",
  ARCHIVE_ZIP: "archive_zip",
  ARCHIVE_UNZIP: "archive_unzip",
  FILE_TAIL: "file_tail",
  FILE_HASH: "file_hash",
  FILE_SEARCH_RIPGREP: "file_search_ripgrep",
  PDF_GENERATE: "pdf_generate",
  FILE_PREVIEW: "file_preview",

  // 3. Desktop, Clipboard & Toast (5)
  CLIPBOARD_GET: "clipboard_get",
  CLIPBOARD_SET: "clipboard_set",
  SCREEN_CAPTURE: "screen_capture",
  SYSTEM_OPEN: "system_open",
  NOTIFICATION_SEND: "notification_send",

  // 4. System, Processes & Windows Services (9)
  SYSTEM_INFO: "system_info",
  GPU_INFO: "gpu_info",
  PROCESS_LIST: "process_list",
  PROCESS_KILL: "process_kill",
  PORT_CHECK: "port_check",
  EVENTLOG_QUERY: "eventlog_query",
  SERVICE_LIST: "service_list",
  SERVICE_STATUS: "service_status",
  SERVICE_CONTROL: "service_control",

  // 5. Network & Connectivity Probe (3)
  HTTP_PING: "http_ping",
  HTTP_REQUEST: "http_request",
  NETWORK_INFO: "network_info",
} as const;

export const SCHEMA_V2_TOOL_NAMES = {
  WINHELM_STATUS: "winhelm_status",
  WINHELM_JOB_STATUS: "winhelm_job_status",
  COMMAND_RUN: "command_run",
} as const;

/**
 * Spec 3.4 Tier A / Phase 1 public additions (final surface: 9 tools):
 * batch inspection, mutation integrity, governance/provenance, governed
 * process execution and deterministic verification. Names are adopted per
 * capability group as their implementations land; Tier B remains out of scope.
 */
export const SPEC_34_TIER_A_TOOL_NAMES = [
  "file_inspect_batch",
  "file_write_atomic",
  "file_create_exclusive",
  "session_current",
  "session_audit_search",
  "file_provenance_lookup",
] as const;

export const RECOVERY_TOOL_NAMES = [
  SCHEMA_V2_TOOL_NAMES.WINHELM_STATUS,
  SCHEMA_V2_TOOL_NAMES.WINHELM_JOB_STATUS,
] as const;

const RECOVERY_TOOL_SET = new Set<string>(RECOVERY_TOOL_NAMES);

export function isRecoveryToolName(name: string): boolean {
  return RECOVERY_TOOL_SET.has(name);
}

export const RESOURCE_NAMES = {
  PREVIEW_FILE: "preview://file",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export const ALL_TOOL_NAMES: ToolName[] = Object.values(TOOL_NAMES);

/** Original v1.2.1 corpus; kept separate for legacy profile compatibility. */
export const LEGACY_TOOL_NAMES = ALL_TOOL_NAMES;

/** Full v1.3 schema-v2 surface: 38 legacy + 3 schema-v2 additions. */
export const ALL_V13_TOOL_NAMES: string[] = [
  ...ALL_TOOL_NAMES,
  ...Object.values(SCHEMA_V2_TOOL_NAMES),
];

/**
 * Canonical v1.4 public surface: the accepted v1.3 surface plus the adopted
 * Spec 3.4 Tier A tools. The canonical count is 41 + adopted Tier A names
 * (50 when Tier A Phase 1 is complete).
 */
export const ALL_V14_TOOL_NAMES: string[] = [
  ...ALL_V13_TOOL_NAMES,
  ...SPEC_34_TIER_A_TOOL_NAMES,
];

export const PROFILE_CONTROLLED_V13_TOOL_NAMES: string[] = [
  ...ALL_TOOL_NAMES,
  SCHEMA_V2_TOOL_NAMES.COMMAND_RUN,
];
