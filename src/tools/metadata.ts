import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  ALL_V13_TOOL_NAMES,
  type ToolName,
  SCHEMA_V2_TOOL_NAMES,
} from "./registry.js";

export type V13ToolName =
  | ToolName
  | (typeof SCHEMA_V2_TOOL_NAMES)[keyof typeof SCHEMA_V2_TOOL_NAMES];

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

function metadata(
  title: string,
  description: string,
  annotations: WinHelmToolMetadata["annotations"]
): WinHelmToolMetadata {
  return { title, description, annotations };
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

export const TOOL_METADATA: Record<V13ToolName, WinHelmToolMetadata> = {
  terminal_run: metadata(
    "Run PowerShell command",
    "Run one PowerShell command synchronously with timeout and UTF-8 output handling.",
    MUTATING_OPEN_WORLD
  ),
  terminal_task_start: metadata(
    "Start background terminal task",
    "Start a long-running PowerShell task and return a WinHelm task identifier.",
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
    "Read UTF-8 file content with optional line-range slicing.",
    READ_ONLY
  ),
  file_write: metadata(
    "Write file",
    "Create or replace a UTF-8 file inside an allowed writable folder.",
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
    "Search file contents for a substring or pattern inside an allowed folder.",
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
    "Run paginated ripgrep search inside an allowed folder.",
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
    "Run a direct executable without a shell; Safe mode permits only hardened package-manager adapters.",
    MUTATING_OPEN_WORLD
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
  const expected = new Set(ALL_V13_TOOL_NAMES);
  const actual = new Set(Object.keys(TOOL_METADATA));

  for (const name of expected) {
    if (!actual.has(name)) {
      issues.push(`missing metadata: ${name}`);
      continue;
    }

    const entry = getToolMetadata(name);
    if (!entry.title.trim()) issues.push(`empty title: ${name}`);
    if (!entry.description.trim()) issues.push(`empty description: ${name}`);

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
