# CLAUDE.md - WinHelm MCP Server

This file provides architectural guidance and coding conventions when working with code in this repository.

## Project Overview

**WinHelm** is an open-source, production-ready Windows Native MCP (Model Context Protocol) server designed for local and remote AI agent control. It provides a **single-process all-in-one architecture** combining a native multi-transport Web Gateway (Streamable HTTP `/mcp` + Server-Sent Events `/sse` & `/message`), Web Monitor Dashboard, and 38 Windows administration and automation tools.

### Core Strengths:
1. **Single-Process Lightweight Gateway:** No proxy chain or supergateway needed. Connects directly to Claude, Cursor, LibreChat, or remote agents via Tailscale.
2. **First-Class UTF-8 Encoding:** Pre-configures PowerShell console encoding to UTF-8 (`[Console]::OutputEncoding`) to handle multilingual scripts (including Thai, Japanese, CJK, etc.) without garbled output.
3. **Security Guardrails:** Built-in configurable `AllowedDirectories` check and `BlockedCommands` filter to prevent catastrophic system commands (such as disk formatting).
4. **TypeScript Strict Mode:** Fully typed ESM codebase with modular separation of concerns.

---

## Build & Development Commands

```bash
# Install dependencies
npm install

# Compile TypeScript to dist/
npm run build

# Type check without emitting
npm run type-check

# Run test suite
npm test

# Run in development mode with auto-reload
npm run dev

# Start compiled server
npm start
```

---

## Repository Architecture

```
winhelm-mcp/
├── src/
│   ├── config/                   # Configuration & Security policy
│   │   ├── config-manager.ts     # ConfigManager singleton (Allowed paths, blocked commands)
│   │   └── default-config.ts     # Default security baseline & limits
│   ├── engine/                   # Windows Platform Execution Engine
│   │   ├── powershell-runner.ts  # Child process manager, UTF-8 wrapper, timeout guard
│   │   ├── filesystem.ts         # Read (line limits), Write, Surgical Edit, Search, List
│   │   └── system.ts             # Clipboard, Screenshot (.NET), Ports, Processes, System Info
│   ├── gateway/                  # Network & Transport Protocol
│   │   ├── sse-gateway.ts        # SSE session manager (/sse, /message)
│   │   ├── streamable-gateway.ts # Streamable HTTP transport manager (/mcp)
│   │   └── server.ts             # Express App setup, CORS, Auth Bearer guard, /health
│   ├── tools/                    # Modular MCP Tool Definitions
│   │   ├── terminal-tools.ts     # terminal_run
│   │   ├── file-tools.ts         # file_read, file_write, file_edit, file_list, file_search
│   │   ├── desktop-tools.ts      # clipboard_*, screen_capture, system_*, process_kill, port_check
│   │   └── index.ts              # Aggregate tool registrar
│   ├── types/                    # TypeScript interfaces & types
│   │   └── index.ts
│   └── index.ts                  # CLI argument parser & server entry point
├── test/                         # Unit & Integration Tests
│   ├── integration/              # SSE & Streamable HTTP tests
│   └── unit/                     # Engine & Security checks
├── CLAUDE.md                     # Architecture & coding guide
├── manifest.json                 # MCP Registry Manifest
├── server.json                   # MCP Server Configuration
├── tsconfig.json                 # TypeScript strict configuration
└── package.json
```

---

## Tool Reference (38 System Tools & Resources)

| Category | Tool | Parameters | Description |
|---|---|---|---|
| **Terminal (Foreground)** | `terminal_run` | `command`, `cwd?`, `timeout_ms?` | Execute PowerShell command with UTF-8 encoding and timeout protection |
| **Terminal (Background)** | `terminal_task_start` | `command`, `cwd?` | Spawn asynchronous background task or daemon process |
| | `terminal_task_list` | _(none)_ | List all running background tasks with PID, status, and start time |
| | `terminal_task_logs` | `taskId`, `lines?` | Retrieve buffered stdout/stderr logs from a background task |
| | `terminal_task_send` | `taskId`, `input` | Send stdin text/keystrokes to an interactive background task |
| | `terminal_task_kill` | `taskId` | Terminate running background task process tree gracefully or forcefully |
| **Filesystem & Safe Delete** | `file_read` | `path`, `start_line?`, `end_line?` | Read file with line numbering and range slicing to protect context limits |
| | `file_write` | `path`, `content` | Write or overwrite file, creating parent directories recursively |
| | `file_edit` | `path`, `old_text`, `new_text` | Surgical replacement of unique text string |
| | `file_list` | `path?`, `recursive?` | List directory contents with file size and modified timestamp |
| | `file_search` | `query`, `path?`, `file_pattern?` | Search text inside files with pattern filter |
| | `file_delete_safe` | `path` | Send file/folder safely to Windows Recycle Bin (restorable, no data loss) |
| | `file_move` | `from`, `to` | Move or rename file or directory within allowed paths |
| | `file_copy` | `from`, `to`, `overwrite?` | Copy file or directory recursively |
| | `file_tail` | `path`, `lines?` | Read the last N lines of log files without buffer overflow |
| | `file_hash` | `path`, `algorithm?` | Calculate SHA-256, MD5, or SHA-1 cryptographic file checksum |
| **Archive (.ZIP)** | `archive_zip` | `source_dir`, `zip_path` | Compress directory into .zip file using native .NET |
| | `archive_unzip` | `zip_path`, `target_dir`, `overwrite?` | Extract .zip archive to destination directory |
| **Advanced Search (Ripgrep)** | `file_search_ripgrep` | `query`, `path?`, `file_pattern?`, `case_sensitive?`, `is_regex?`, `page?`, `page_size?` | High-speed paginated regex search via ripgrep with fallback |
| **PDF Document Generator** | `pdf_generate` | `source_path`, `pdf_path`, `landscape?`, `title?` | Convert Markdown, HTML, or Text to PDF via native Chromium headless |
| **Preview & Web Viewer** | `file_preview` | `path`, `max_lines?` | Generate snippet preview and interactive Web Dashboard URL (`/preview?path=...`) |
| **Desktop & Clipboard** | `clipboard_get` | _(none)_ | Read current text from Windows Clipboard |
| | `clipboard_set` | `text` | Copy string to Windows Clipboard via Base64 UTF-8 |
| | `screen_capture` | _(none)_ | Capture desktop screenshot using .NET and return Base64 PNG image |
| | `system_open` | `target` | Open URL, file, or folder in Windows default application |
| | `notification_send` | `title`, `message`, `sound?` | Send native Windows toast notification to desktop |
| **System & Hardware** | `system_info` | _(none)_ | Query CPU usage %, RAM total/used/free, and filtered allowed drive capacities |
| | `gpu_info` | _(none)_ | Query GPU stats (NVIDIA nvidia-smi / WMI): VRAM, load, temperature, driver |
| | `process_list` | `limit?`, `sort_by?`, `filter?` | List top running processes sorted by RAM or CPU with PID and paths |
| | `process_kill` | `pid?`, `name?` | Terminate running process by PID or process name |
| | `port_check` | `port` | Check TCP port usage and retrieve owning PID & process name |
| | `eventlog_query` | `log_name?`, `level?`, `hours?`, `limit?` | Query Windows Event Log for crashes, warnings, and errors |
| **Windows Services** | `service_list` | `filter?` | List Windows services with status and startup type |
| | `service_status` | `service_name` | Get detailed status, PID, and display name for a specific service |
| | `service_control` | `service_name`, `action` | Start, stop, or restart a Windows service (respects read-only mode) |
| **Network & Web Probe** | `http_ping` | `url`, `timeout_ms?` | Quick HTTP ping probe measuring latency in ms, status code, and headers |
| | `http_request` | `url`, `method?`, `headers?`, `body?`, `timeout_ms?` | Full HTTP client for REST APIs and dev server verification with JSON parsing |
| | `network_info` | `include_listening_ports?` | Query network adapters, IP addresses, Gateway, DNS, and Tailscale IP |

---

## Security & Production Guardrails

### 1. Secret Redaction & Sanitization
All logs, error outputs, and telemetry automatically mask credentials:
- Bearer tokens (`Bearer ********`)
- OpenAI / Anthropic / GitHub keys (`sk-***`, `ghp_***`)
- Password CLI arguments (`-p`, `--password`, `-Password`)

### 2. Rate Limiting
Built-in sliding-window limiter on `/mcp`, `/sse`, and `/message`:
- Default: `120 requests/minute` per IP
- Exceeding limit returns `HTTP 429 Too Many Requests` with `Retry-After` header.

### 3. Read-Only Mode
Enforce zero-mutation mode via `MCP_READ_ONLY=1`, `--read-only`, or config:
- Blocks `file_write`, `file_edit`, `process_kill`, `terminal_task_kill`.
- Allows audit, search, diagnostics, and read operations safely.

### 4. Path Boundaries & Full-Drive Support
Supports strict sandboxing or full drive access:
- Single paths: `D:\mcp`, `C:\Projects`
- Full drives: `D:\`, `D:`, `D`

### 5. Persistent Daily File Logging & Audit Export
- Log file: `logs/winhelm-YYYY-MM-DD.log`
- Auto-rotates at midnight, caps at 10 MB per file, auto-prunes files > 7 days old.
- Export endpoints: `GET /api/monitor/export?format=json` and `GET /api/monitor/export?format=csv`.

---

## Windows Service & Daemon Management

Manage WinHelm as an auto-starting Windows Background Service (via Windows Task Scheduler / SYSTEM):

```powershell
npm run service:install    # Install as background service (auto-starts at boot)
npm run service:status     # Check service health and running state
npm run service:start      # Start the background service
npm run service:stop       # Stop the background service
npm run service:uninstall  # Completely remove background service
```

---

## Standalone Executable Build

Build a portable standalone Windows `.exe` without requiring Node.js on client machines:

```powershell
npm run build:exe          # Generates dist/winhelm.exe via Node SEA
```

---

## Configuration Reference

### Config File (`winhelm.config.json`)
```json
{
  "blockedCommands": [
    "format-volume",
    "format-disk",
    "clear-disk",
    "stop-computer",
    "restart-computer",
    "rmdir /s /q c:\\",
    "del /f /s /q c:\\"
  ],
  "allowedDirectories": ["D:\\"],
  "fileReadLineLimit": 2000,
  "defaultTimeoutMs": 60000,
  "telemetryEnabled": false,
  "authToken": null,
  "readOnly": false,
  "rateLimitWindowMs": 60000,
  "rateLimitMaxRequests": 120
}
```

### Environment Variables
- `PORT`: Port to listen on (default `8788`)
- `HOST`: Host address (default `0.0.0.0`)
- `MCP_AUTH_TOKEN`: If set, requires `Authorization: Bearer <token>` for all requests
- `MCP_ALLOWED_DIRECTORIES`: Comma-separated list of permitted paths (e.g. `D:\mcp,D:\`)
- `MCP_BLOCKED_COMMANDS`: Comma-separated list of dangerous command substrings to deny
- `MCP_READ_ONLY`: If `1` or `true`, enables strict read-only mode
