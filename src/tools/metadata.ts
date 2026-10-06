import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  ALL_V14_TOOL_NAMES,
  type ToolName,
  SCHEMA_V2_TOOL_NAMES,
  SPEC_34_TIER_A_TOOL_NAMES,
} from "./registry.js";

export type V13ToolName =
  | ToolName
  | (typeof SCHEMA_V2_TOOL_NAMES)[keyof typeof SCHEMA_V2_TOOL_NAMES];

export type V14ToolName =
  | V13ToolName
  | (typeof SPEC_34_TIER_A_TOOL_NAMES)[number];

export interface WinHelmToolMetadata {
  title: string;
  description: string;
  annotations: Required<
    Pick<
      ToolAnnotations,
      "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint"
    >
  >;
}

/**
 * Baseline 5.2 requires every tool description to state that WinHelm acts on
 * the user's real machine and to tell the model how to react to a policy
 * refusal. Both statements are appended uniformly so no tool can drift.
 */
export const PC_SCOPE_STATEMENT =
  "Runs on the user's real Windows PC, not a sandbox; use it when the user refers to files, apps or processes on that computer.";

export const USER_ACTION_STATEMENT =
  'If a result contains "userAction", relay it to the user and do not try to work around it.';

/** Bounds that keep the mandated guidance while limiting the tools/list payload. */
export const DESCRIPTION_MIN_LENGTH = 140;
export const DESCRIPTION_MAX_LENGTH = 800;

function withMandatoryGuidance(description: string): string {
  return `${description.trim()} ${PC_SCOPE_STATEMENT} ${USER_ACTION_STATEMENT}`;
}

function metadata(
  title: string,
  description: string,
  annotations: WinHelmToolMetadata["annotations"]
): WinHelmToolMetadata {
  return {
    title,
    description: withMandatoryGuidance(description),
    annotations,
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const READ_ONLY_OPEN_WORLD = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const MUTATING = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const MUTATING_OPEN_WORLD = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const ADDITIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const TOOL_METADATA: Record<V14ToolName, WinHelmToolMetadata> = {
  terminal_run: metadata(
    "Run PowerShell command",
    "Run one PowerShell command synchronously when shell/PowerShell semantics are required; prefer dedicated WinHelm tools or command_run for direct executables.",
    MUTATING_OPEN_WORLD
  ),
  terminal_task_start: metadata(
    "Start background terminal task",
    "Start a long-running or interactive PowerShell task and return a WinHelm task identifier for later logs, stdin, or termination.",
    MUTATING_OPEN_WORLD
  ),
  terminal_task_list: metadata(
    "List background terminal tasks",
    "List WinHelm-managed background terminal tasks and their current states.",
    READ_ONLY
  ),
  terminal_task_logs: metadata(
    "Read background task logs",
    "Read buffered stdout/stderr from a WinHelm-managed background terminal task.",
    READ_ONLY
  ),
  terminal_task_send: metadata(
    "Send input to background task",
    "Send text input to the stdin stream of a WinHelm-managed background task.",
    MUTATING_OPEN_WORLD
  ),
  terminal_task_kill: metadata(
    "Stop background terminal task",
    "Terminate a WinHelm-managed background process tree.",
    MUTATING_OPEN_WORLD
  ),

  file_read: metadata(
    "Read file",
    "Read UTF-8 file content with optional line-range slicing; prefer this over terminal/Get-Content for ordinary text reads.",
    READ_ONLY
  ),
  file_write: metadata(
    "Write file",
    "Create or replace a UTF-8 file when ordinary replacement is acceptable; prefer file_write_atomic for important or concurrency-sensitive updates.",
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }
  ),
  file_edit: metadata(
    "Edit file",
    "Replace one unique exact text block inside an existing file.",
    MUTATING
  ),
  file_list: metadata(
    "List folder",
    "List files and folders with basic metadata inside an allowed folder.",
    READ_ONLY
  ),
  file_search: metadata(
    "Search files",
    "Search file contents for a simple literal or modest pattern inside an allowed folder; prefer ripgrep for code, regex, globs, context, or pagination.",
    READ_ONLY
  ),
  file_delete_safe: metadata(
    "Move file to Recycle Bin",
    "Move a file or folder to the Windows Recycle Bin instead of permanently deleting it.",
    MUTATING
  ),
  file_move: metadata(
    "Move or rename file",
    "Move or rename a file or folder between allowed writable locations.",
    MUTATING
  ),
  file_copy: metadata(
    "Copy file or folder",
    "Copy a file or directory tree between allowed locations.",
    MUTATING
  ),
  archive_zip: metadata(
    "Create ZIP archive",
    "Compress an allowed directory into a ZIP archive at an allowed writable path.",
    MUTATING
  ),
  archive_unzip: metadata(
    "Extract ZIP archive",
    "Extract a ZIP archive into an allowed writable folder with zip-slip protections.",
    MUTATING
  ),
  file_tail: metadata(
    "Read file tail",
    "Read the trailing lines of a large text file or log.",
    READ_ONLY
  ),
  file_hash: metadata(
    "Hash file",
    "Compute a cryptographic checksum for an allowed file using streaming I/O.",
    READ_ONLY
  ),
  file_search_ripgrep: metadata(
    "Search code with ripgrep",
    "Run paginated ripgrep search for codebase, regex, glob, context, or large-result queries inside an allowed folder.",
    READ_ONLY
  ),
  pdf_generate: metadata(
    "Generate PDF",
    "Generate a PDF from an allowed source document using local Chromium or Edge.",
    MUTATING
  ),
  file_preview: metadata(
    "Preview file",
    "Read file metadata and a bounded text preview and return a local preview reference.",
    READ_ONLY
  ),

  clipboard_get: metadata(
    "Read clipboard",
    "Read current text from the Windows clipboard.",
    READ_ONLY
  ),
  clipboard_set: metadata(
    "Write clipboard",
    "Replace Windows clipboard text with the supplied value.",
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }
  ),
  screen_capture: metadata(
    "Capture screen",
    "Capture the current Windows desktop as a PNG image.",
    READ_ONLY
  ),
  system_open: metadata(
    "Open with Windows",
    "Open a URL, file, or folder with the Windows default application.",
    MUTATING_OPEN_WORLD
  ),
  notification_send: metadata(
    "Send Windows notification",
    "Show a local Windows toast notification; WinHelm prefixes AI-authored text for provenance.",
    ADDITIVE
  ),

  system_info: metadata(
    "Read system information",
    "Read Windows, CPU, memory, drive, and uptime information.",
    READ_ONLY
  ),
  gpu_info: metadata(
    "Read GPU information",
    "Read GPU telemetry from NVIDIA tooling or Windows management interfaces.",
    READ_ONLY
  ),
  process_list: metadata(
    "List processes",
    "List running Windows processes with resource usage information.",
    READ_ONLY
  ),
  process_kill: metadata(
    "Terminate process",
    "Terminate a Windows process by PID or executable name.",
    MUTATING
  ),
  port_check: metadata(
    "Check TCP port",
    "Inspect TCP port ownership and listener state on the local Windows host.",
    READ_ONLY
  ),
  eventlog_query: metadata(
    "Query Windows Event Log",
    "Read filtered Windows Event Log entries.",
    READ_ONLY
  ),
  service_list: metadata(
    "List Windows services",
    "List Windows services and their current states.",
    READ_ONLY
  ),
  service_status: metadata(
    "Read service status",
    "Read detailed status information for a Windows service.",
    READ_ONLY
  ),
  service_control: metadata(
    "Control Windows service",
    "Start, stop, or restart a Windows service.",
    MUTATING
  ),

  http_ping: metadata(
    "Probe HTTP endpoint",
    "Measure HTTP reachability and latency after WinHelm network-boundary validation.",
    READ_ONLY_OPEN_WORLD
  ),
  http_request: metadata(
    "Send HTTP request",
    "Send an HTTP request after DNS, redirect, metadata-address, and effective-port validation.",
    MUTATING_OPEN_WORLD
  ),
  network_info: metadata(
    "Read network information",
    "Read local network adapters, addresses, DNS configuration, and Tailscale information.",
    READ_ONLY
  ),

  winhelm_status: metadata(
    "Read WinHelm status",
    "Read WinHelm schema, permission, profile, and validation status without changing configuration.",
    READ_ONLY
  ),
  winhelm_job_status: metadata(
    "Read approval job status",
    "Read the caller-owned approval job state and persisted result metadata.",
    READ_ONLY
  ),
  command_run: metadata(
    "Run executable without a shell",
    "Prefer this for direct executable invocation without a shell, including governed async runs; terminal mode safe is package-manager-only, while ask/full permit governed direct executables subject to existing gates. Use terminal_run only when shell/PowerShell semantics are required.",
    MUTATING_OPEN_WORLD
  ),

  file_inspect_batch: metadata(
    "Inspect file batch",
    "Inspect up to 100 paths in one call with metadata, streaming SHA-256 and best-effort or writer-denying consistency.",
    READ_ONLY
  ),
  file_write_atomic: metadata(
    "Write file atomically",
    "Preferred for important or concurrency-sensitive file updates: atomic replacement, optimistic preconditions, and governed text or base64 binary writes.",
    MUTATING
  ),
  file_create_exclusive: metadata(
    "Create file exclusively",
    "Create a new text or base64 binary file with Win32 CREATE_NEW semantics; use when the target must not already exist and must never be overwritten.",
    MUTATING
  ),
  session_current: metadata(
    "Read current session identity",
    "Report the current WinHelm session identity, client, process, and permission context.",
    READ_ONLY
  ),
  session_audit_search: metadata(
    "Search current session audit",
    "Search this session's own invocation/audit projection only; other sessions' activity is never returned. For durable path-scoped create/modify/delete attribution, use file_provenance_lookup.",
    READ_ONLY
  ),
  file_provenance_lookup: metadata(
    "Look up file provenance",
    "Project the cross-session mutation attribution of one authorized path without exposing the audit store.",
    READ_ONLY
  ),
  command_wait: metadata(
    "Wait for governed command",
    "Wait for an owned governed run without ever cancelling it; timeouts return still_running.",
    READ_ONLY
  ),
  file_compare: metadata(
    "Compare two files",
    "Compare two authorized files byte- or text-wise with first-difference and bounded diff output.",
    READ_ONLY
  ),
  directory_manifest: metadata(
    "Snapshot folder manifest",
    "Build a deterministic canonical folder manifest with a stable manifest SHA-256.",
    READ_ONLY
  ),
};

export function getToolMetadata(name: string): WinHelmToolMetadata {
  const entry = (TOOL_METADATA as Record<string, WinHelmToolMetadata>)[name];
  if (!entry) {
    throw new Error(`Missing WinHelm tool metadata for ${name}`);
  }
  return entry;
}

export function validateToolMetadataRegistry(): string[] {
  const issues: string[] = [];
  const expected = new Set(ALL_V14_TOOL_NAMES);
  const actual = new Set(Object.keys(TOOL_METADATA));

  for (const name of expected) {
    if (!actual.has(name)) {
      issues.push(`missing metadata: ${name}`);
      continue;
    }

    const entry = getToolMetadata(name);
    if (!entry.title.trim()) issues.push(`empty title: ${name}`);
    if (!entry.description.trim()) issues.push(`empty description: ${name}`);

    if (
      entry.description.length < DESCRIPTION_MIN_LENGTH ||
      entry.description.length > DESCRIPTION_MAX_LENGTH
    ) {
      issues.push(
        `description length ${entry.description.length} outside ${DESCRIPTION_MIN_LENGTH}-${DESCRIPTION_MAX_LENGTH}: ${name}`
      );
    }
    if (!entry.description.includes(PC_SCOPE_STATEMENT)) {
      issues.push(`description missing real-PC scope statement: ${name}`);
    }
    if (!entry.description.includes(USER_ACTION_STATEMENT)) {
      issues.push(`description missing userAction rule: ${name}`);
    }

    for (const key of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ] as const) {
      if (typeof entry.annotations[key] !== "boolean") {
        issues.push(`missing annotation ${key}: ${name}`);
      }
    }

    if (
      entry.annotations.readOnlyHint &&
      entry.annotations.destructiveHint
    ) {
      issues.push(
        `read-only tool cannot be destructive: ${name}`
      );
    }
  }

  for (const name of actual) {
    if (!expected.has(name)) {
      issues.push(`unexpected metadata: ${name}`);
    }
  }

  return issues;
}
