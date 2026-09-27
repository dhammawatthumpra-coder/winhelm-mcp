# WinHelm MCP — Comprehensive Tools Reference

WinHelm provides **38 native Windows tools** and **1 MCP Resource** designed for AI coding agents and desktop automation.

---

## Tool Profiles Matrix

WinHelm supports loading subset profiles to prevent prompt context bloat:

| Tool Name | `core` (15) | `dev` (28) | `sysadmin` (37) | `full` (38) | Category | Description |
| :--- | :---: | :---: | :---: | :---: | :--- | :--- |
| `terminal_run` | ✅ | ✅ | ✅ | ✅ | Terminal | Synchronous PowerShell runner with UTF-8 encoding |
| `terminal_task_start` | ❌ | ✅ | ✅ | ✅ | Terminal | Starts detached background daemon task |
| `terminal_task_list` | ❌ | ✅ | ✅ | ✅ | Terminal | Lists active and exited background tasks |
| `terminal_task_logs` | ❌ | ✅ | ✅ | ✅ | Terminal | Retrieves buffered output logs of a task |
| `terminal_task_send` | ❌ | ✅ | ✅ | ✅ | Terminal | Sends interactive input (`stdin`) to a task |
| `terminal_task_kill` | ❌ | ✅ | ✅ | ✅ | Terminal | Terminates a background task process tree |
| `file_read` | ✅ | ✅ | ✅ | ✅ | Filesystem | Reads file content with optional line slicing |
| `file_write` | ✅ | ✅ | ✅ | ✅ | Filesystem | Writes UTF-8 file (creates directories) |
| `file_edit` | ✅ | ✅ | ✅ | ✅ | Filesystem | Precise surgical text replacement |
| `file_list` | ✅ | ✅ | ✅ | ✅ | Filesystem | Lists directory entries with stats |
| `file_search` | ✅ | ✅ | ✅ | ✅ | Filesystem | Substring search across files |
| `file_delete_safe` | ✅ | ✅ | ✅ | ✅ | Filesystem | Moves file to Windows Recycle Bin (recoverable) |
| `file_move` | ✅ | ✅ | ✅ | ✅ | Filesystem | Atomically moves or renames a file/folder |
| `file_copy` | ✅ | ✅ | ✅ | ✅ | Filesystem | Recursively copies files or directories |
| `archive_zip` | ❌ | ✅ | ✅ | ✅ | Filesystem | Compresses directory to `.zip` via native .NET |
| `archive_unzip` | ❌ | ✅ | ✅ | ✅ | Filesystem | Extracts `.zip` archive via native .NET |
| `file_tail` | ✅ | ✅ | ✅ | ✅ | Filesystem | Reads trailing N lines of large files/logs |
| `file_hash` | ✅ | ✅ | ✅ | ✅ | Filesystem | Computes SHA-256, MD5, or SHA-1 checksum |
| `file_search_ripgrep` | ❌ | ✅ | ✅ | ✅ | Codebase | Fast regex code search with streaming pagination |
| `pdf_generate` | ❌ | ✅ | ❌ | ✅ | Document | Generates styled PDF via headless Edge/Chrome |
| `file_preview` | ❌ | ✅ | ✅ | ✅ | Preview | File metadata and web preview URL |
| `clipboard_get` | ❌ | ❌ | ✅ | ✅ | Desktop | Reads text from Windows Clipboard |
| `clipboard_set` | ❌ | ❌ | ✅ | ✅ | Desktop | Writes text to Windows Clipboard |
| `screen_capture` | ❌ | ❌ | ✅ | ✅ | Desktop | Captures desktop screenshot (base64 PNG) |
| `system_open` | ❌ | ✅ | ✅ | ✅ | Desktop | Opens URL, file, or folder in default app |
| `notification_send` | ❌ | ❌ | ✅ | ✅ | Desktop | Dispatches Windows native Toast Notification |
| `system_info` | ✅ | ✅ | ✅ | ✅ | System | OS version, CPU, RAM, drives & uptime |
| `gpu_info` | ✅ | ✅ | ✅ | ✅ | System | NVIDIA GPU telemetry (VRAM, temp) or WMI |
| `process_list` | ✅ | ✅ | ✅ | ✅ | System | Lists top processes sorted by RAM or CPU |
| `process_kill` | ❌ | ❌ | ✅ | ✅ | System | Kills process by PID or executable name |
| `port_check` | ✅ | ✅ | ✅ | ✅ | System | Checks TCP port usage and owning PID |
| `eventlog_query` | ❌ | ❌ | ✅ | ✅ | System | Queries Windows Event Log (errors/warnings) |
| `service_list` | ❌ | ❌ | ✅ | ✅ | Services | Lists Windows Services and status |
| `service_status` | ❌ | ❌ | ✅ | ✅ | Services | Detailed status and PID of a service |
| `service_control` | ❌ | ❌ | ✅ | ✅ | Services | Starts, stops, or restarts a service |
| `http_ping` | ❌ | ✅ | ✅ | ✅ | Network | Fast HTTP latency and health probe |
| `http_request` | ❌ | ✅ | ✅ | ✅ | Network | Dispatches HTTP requests (GET/POST/etc.) |
| `network_info` | ❌ | ❌ | ✅ | ✅ | Network | Network adapters, IPs, DNS, and Tailscale |
| `preview://file` *(Resource)* | ❌ | ✅ | ✅ | ✅ | MCP Resource | Dynamic interactive HTML preview resource |

---

## Table of Contents

1. [Terminal & Background Execution](#1-terminal--background-execution) (6 tools)
2. [Filesystem, Safe Delete & Archives](#2-filesystem-safe-delete--archives) (12 tools)
3. [Codebase Search, PDF & Preview](#3-codebase-search-pdf--preview) (3 tools)
4. [Desktop & Productivity](#4-desktop--productivity) (5 tools)
5. [System, Processes & Windows Services](#5-system-processes--windows-services) (9 tools)
6. [Network & Web Diagnostics](#6-network--web-diagnostics) (3 tools)
7. [MCP Resources](#7-mcp-resources) (1 resource)

---

## 1. Terminal & Background Execution

### `terminal_run`
Executes a PowerShell command synchronously with automatic UTF-8 encoding enforcement and timeout handling.
- **Parameters:**
  - `command` *(string, required)*: The PowerShell command to execute.
  - `cwd` *(string, optional)*: Working directory for execution.
  - `timeout_ms` *(number, optional, default: 60000)*: Timeout in milliseconds.
- **Returns:** Text output containing stdout and stderr.

### `terminal_task_start`
Launches a long-running command in the background (e.g. dev servers, npm build, test watchers) returning a Task ID immediately.
- **Parameters:**
  - `command` *(string, required)*: Background command to run.
  - `cwd` *(string, optional)*: Working directory.
- **Returns:** `{ message: string, task: { id, command, cwd, pid, status, startTime } }`

### `terminal_task_list`
Lists all active, completed, or failed background tasks managed by WinHelm.
- **Parameters:** None.
- **Returns:** Array of background task objects.

### `terminal_task_logs`
Retrieves live buffered output logs and status from a running or completed background task.
- **Parameters:**
  - `task_id` *(string, required)*: Task ID returned from `terminal_task_start`.
  - `tail_lines` *(number, optional, default: 100)*: Number of trailing lines to view.
- **Returns:** Header with task status followed by recent standard output and error text.

### `terminal_task_send`
Sends interactive text/keystrokes directly to the `stdin` stream of a running background process.
- **Parameters:**
  - `task_id` *(string, required)*: Task ID of running process.
  - `input` *(string, required)*: Text to send to stdin.
- **Returns:** Confirmation message.

### `terminal_task_kill`
Terminates a running background task and its entire Windows process tree (`taskkill /T /F`) with zero orphan processes.
- **Parameters:**
  - `task_id` *(string, required)*: Task ID to terminate.
- **Returns:** Confirmation message.

---

## 2. Filesystem, Safe Delete & Archives

### `file_read`
Reads file content in UTF-8, with optional 1-indexed line range slicing to conserve LLM context window.
- **Parameters:**
  - `path` *(string, required)*: File path.
  - `start_line` *(number, optional)*: 1-indexed start line.
  - `end_line` *(number, optional)*: 1-indexed end line.
- **Returns:** Content string with line numbers when a range is specified.

### `file_write`
Writes or creates a file with UTF-8 encoding, creating parent directories automatically.
- **Parameters:**
  - `path` *(string, required)*: Target file path.
  - `content` *(string, required)*: Full content to write.
- **Returns:** Confirmation with bytes written.

### `file_edit`
Surgically replaces a unique block of text inside an existing file without modifying unrelated lines. Fails safely if `old_text` does not appear uniquely.
- **Parameters:**
  - `path` *(string, required)*: File path to edit.
  - `old_text` *(string, required)*: Exact text block to replace.
  - `new_text` *(string, required)*: Replacement text block.
- **Returns:** Confirmation of successful replacement.

### `file_list`
Lists files and directories with size, type, and modification dates.
- **Parameters:**
  - `path` *(string, optional, default: ".")*: Directory path.
  - `recursive` *(boolean, optional, default: false)*: Scan subdirectories up to 3 levels.
- **Returns:** JSON directory listing.

### `file_search`
Quick substring or pattern search across files in a directory.
- **Parameters:**
  - `query` *(string, required)*: Search string to find within files.
  - `path` *(string, optional, default: ".")*: Base folder path.
  - `file_pattern` *(string, optional)*: File name filter (e.g. `.ts`, `.json`).
- **Returns:** List of matching files and occurrences.

### `file_delete_safe`
Safely moves files or directories to the **Windows Recycle Bin** instead of permanent deletion. Items can be restored from the desktop Recycle Bin if deleted accidentally.
- **Parameters:**
  - `path` *(string, required)*: Target file or directory path.
- **Returns:** Confirmation message.

### `file_move`
Atomically moves or renames a file or folder.
- **Parameters:**
  - `source` *(string, required)*: Source file or folder path.
  - `destination` *(string, required)*: Destination path.
  - `overwrite` *(boolean, optional, default: false)*: Overwrite existing destination.
- **Returns:** Confirmation of move.

### `file_copy`
Recursively copies files or directories using native Windows shell operations.
- **Parameters:**
  - `source` *(string, required)*: Source path.
  - `destination` *(string, required)*: Target destination path.
  - `overwrite` *(boolean, optional, default: true)*: Overwrite existing target.
- **Returns:** Confirmation of copy.

### `archive_zip`
Compresses a directory into a standard `.zip` archive using native Windows .NET APIs.
- **Parameters:**
  - `source_dir` *(string, required)*: Directory path to compress.
  - `zip_path` *(string, required)*: Destination `.zip` file path.
- **Returns:** Confirmation message.

### `archive_unzip`
Extracts a `.zip` archive into a target directory.
- **Parameters:**
  - `zip_path` *(string, required)*: Path to `.zip` file.
  - `target_dir` *(string, required)*: Destination folder path.
  - `overwrite` *(boolean, optional, default: true)*: Overwrite existing files.
- **Returns:** Confirmation message.

### `file_tail`
Reads the trailing N lines of large log or data files with line numbers without exhausting LLM context.
- **Parameters:**
  - `path` *(string, required)*: Target file path.
  - `lines` *(number, optional, default: 50)*: Number of trailing lines.
- **Returns:** Trailing lines with line numbers.

### `file_hash`
Computes cryptographic hash digests of a file via low-memory chunked streaming.
- **Parameters:**
  - `path` *(string, required)*: Target file path.
  - `algorithm` *(string, optional, default: "sha256")*: `"sha256"`, `"md5"`, or `"sha1"`.
- **Returns:** `{ path: string, algorithm: string, hash: string, sizeBytes: number }`

---

## 3. Codebase Search, PDF & Preview

### `file_search_ripgrep`
High-speed codebase search using `ripgrep` (`rg.exe`) with regex, glob filters, and streaming pagination to prevent token blowups.
- **Parameters:**
  - `query` *(string, required)*: Search string or regex pattern.
  - `path` *(string, optional, default: ".")*: Directory path to search.
  - `file_pattern` *(string, optional)*: Glob pattern filter (e.g. `'*.ts'`, `'src/**'`).
  - `case_sensitive` *(boolean, optional, default: false)*: Case-sensitive matching.
  - `is_regex` *(boolean, optional, default: false)*: Treat query as regex.
  - `page` *(number, optional, default: 1)*: Page number (1-based).
  - `page_size` *(number, optional, default: 50, max: 200)*: Matches per page.
  - `context_lines` *(number, optional, default: 0)*: Lines of context around matches.
- **Returns:** Formatted list of matches with file, line, column, and text.

### `pdf_generate`
Converts Markdown text or Markdown file into a styled PDF document using headless Microsoft Edge or Google Chrome.
- **Parameters:**
  - `source_path` *(string, required)*: Path to input Markdown (`.md`), HTML, or text file.
  - `pdf_path` *(string, required)*: Output destination `.pdf` file path.
  - `landscape` *(boolean, optional, default: false)*: Landscape orientation.
  - `title` *(string, optional)*: Document title for page headers.
- **Returns:** PDF generation report with file size and browser engine used.

### `file_preview`
Generates file metadata and an interactive browser preview link.
- **Parameters:**
  - `path` *(string, required)*: File path to preview.
  - `max_lines` *(number, optional, default: 50)*: Maximum snippet lines in response.
- **Returns:** JSON object containing `previewUrl`, line count, file size, and preview snippet.

---

## 4. Desktop & Productivity

### `clipboard_get`
Reads current text from the Windows Clipboard.
- **Parameters:** None.
- **Returns:** Text content from clipboard.

### `clipboard_set`
Copies UTF-8 text into the Windows Clipboard.
- **Parameters:**
  - `text` *(string, required)*: Text to copy to clipboard.
- **Returns:** Confirmation message.

### `screen_capture`
Takes a high-resolution screenshot of the Windows desktop and returns a base64-encoded PNG image.
- **Parameters:** None.
- **Returns:** MCP Image content block (PNG) and descriptive text.

### `system_open`
Opens a URL in the default browser, or opens a file/folder in Windows File Explorer.
- **Parameters:**
  - `target` *(string, required)*: URL, folder path, or file path to open.
- **Returns:** Confirmation message.

### `notification_send`
Dispatches a native Windows Toast Notification to the Action Center.
- **Parameters:**
  - `title` *(string, required)*: Notification title.
  - `message` *(string, required)*: Notification body text.
  - `sound` *(boolean, optional, default: true)*: Play alert chime.
- **Returns:** Confirmation message.

---

## 5. System, Processes & Windows Services

### `system_info`
Comprehensive hardware and OS summary: CPU model & cores, RAM (Total/Used/Free), OS version, allowed drive capacities, and uptime.
- **Parameters:** None.
- **Returns:** JSON system telemetry snapshot.

### `gpu_info`
Queries NVIDIA GPU metrics (model, VRAM total/used/free, temperature, driver version) via `nvidia-smi` with WMI fallback.
- **Parameters:** None.
- **Returns:** JSON GPU telemetry.

### `process_list`
Lists running Windows processes with PID, Process Name, RAM usage (Working Set MB), CPU %, and paths.
- **Parameters:**
  - `limit` *(number, optional, default: 20, max: 100)*: Max number of processes to return.
  - `sort_by` *(string, optional, default: "memory")*: `"memory"`, `"cpu"`, `"name"`, or `"pid"`.
  - `filter` *(string, optional)*: Substring filter on process name or path.
- **Returns:** JSON array of process objects.

### `process_kill`
Terminates a Windows process safely by PID or Process Name.
- **Parameters:**
  - `pid` *(number, optional)*: Target Process ID.
  - `name` *(string, optional)*: Target process name (e.g. `'node'`, `'notepad'`).
- **Returns:** JSON termination result.

### `port_check`
Checks if a TCP port is currently open/listening and identifies the owning process PID and process name.
- **Parameters:**
  - `port` *(number, required)*: TCP port number to inspect (e.g. 8788, 3000).
- **Returns:** JSON object containing `port`, `inUse`, `pid`, `processName`.

### `eventlog_query`
Queries the Windows Event Log (Application, System) for crash reports, error traces, and warnings.
- **Parameters:**
  - `log_name` *(string, optional, default: "Application")*: `"Application"` or `"System"`.
  - `level` *(string, optional, default: "Error")*: `"Critical"`, `"Error"`, `"Warning"`, `"Information"`, or `"All"`.
  - `hours` *(number, optional, default: 24)*: Retrieve events from the past N hours.
  - `source` *(string, optional)*: Provider or application source filter.
  - `limit` *(number, optional, default: 20, max: 100)*: Max events to retrieve.
- **Returns:** JSON array of event log entries.

### `service_list`
Lists Windows Services with current status (`Running`, `Stopped`) and display names.
- **Parameters:**
  - `filter` *(string, optional)*: Substring filter on service name or display name.
- **Returns:** JSON array of services.

### `service_status`
Inspects detailed status, startup type, and PID of a specific Windows Service.
- **Parameters:**
  - `service_name` *(string, required)*: Exact name of the service (e.g. `'wslservice'`, `'ssh-agent'`).
- **Returns:** JSON service details.

### `service_control`
Starts, stops, or restarts a Windows Service (requires appropriate privileges).
- **Parameters:**
  - `service_name` *(string, required)*: Exact name of the service.
  - `action` *(string, required)*: `"start"`, `"stop"`, or `"restart"`.
- **Returns:** JSON execution status.

---

## 6. Network & Web Diagnostics

### `http_ping`
Rapidly pings an HTTP/HTTPS endpoint to measure roundtrip latency in milliseconds, status code, and header info.
- **Parameters:**
  - `url` *(string, required)*: Target HTTP/HTTPS URL.
  - `timeout_ms` *(number, optional, default: 5000)*: Timeout in milliseconds.
  - `expected_status` *(number, optional)*: Expected HTTP status code (default: any 2xx).
- **Returns:** JSON latency and response status.

### `http_request`
Dispatches an HTTP request (GET, POST, PUT, DELETE, PATCH, HEAD) with custom headers and payload for REST API testing.
- **Parameters:**
  - `url` *(string, required)*: Target URL.
  - `method` *(string, optional, default: "GET")*: HTTP method.
  - `headers` *(object, optional)*: Key-value map of HTTP headers.
  - `body` *(string, optional)*: Request payload string.
  - `timeout_ms` *(number, optional, default: 15000)*: Timeout in milliseconds.
- **Returns:** Response status, duration, headers, and parsed body.

### `network_info`
Retrieves local IP addresses, network adapters, Default Gateway, DNS servers, and Tailscale IP (`100.x.y.z`).
- **Parameters:**
  - `include_listening_ports` *(boolean, optional, default: false)*: Include list of listening TCP ports.
- **Returns:** JSON network summary.

---

## 7. MCP Resources

### `preview://file`
Interactive file preview resource registered on the MCP Server (`text/html;profile=mcp-app`). Allows MCP client apps and web browsers to view syntax-highlighted code and rendered Markdown at `http://localhost:8788/preview?path=<filepath>`.
