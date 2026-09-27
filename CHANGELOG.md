# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-09-27

### Added
- **Multi-Transport MCP Gateway**:
  - Full support for MCP **Streamable HTTP** (`/mcp`) protocol.
  - Full backward compatibility for **Server-Sent Events** (`/sse`, `/message`).
  - Native **Standard I/O (`--stdio`)** transport via MCP `StdioServerTransport` for direct integration with local AI agents, **OpenAI `tunnel-client` (ChatGPT)**, Claude Desktop, and Cursor.
  - **Early Stdout Purity Guard**: In `--stdio` mode, automatically redirects operational logging to `stderr` to ensure the JSON-RPC wire on `stdout` remains 100% clean and free of parser errors.
  - Real-time Web Monitor Dashboard (`/` and `/dashboard`) with live request throughput, log streams, and GPU stats.
  - Interactive file and markdown viewer (`/preview?path=<file>`).
  - MCP UI App Resource: `preview://file`.
- **38 Native Windows Tools**:
  - **Terminal & Background Execution (6)**: `terminal_run`, `terminal_task_start`, `terminal_task_list`, `terminal_task_logs`, `terminal_task_send`, `terminal_task_kill`.
  - **Filesystem & Safe Delete (12)**: `file_read`, `file_write`, `file_edit`, `file_list`, `file_search`, `file_delete_safe`, `file_move`, `file_copy`, `archive_zip`, `archive_unzip`, `file_tail`, `file_hash`.
  - **Codebase Search, PDF & Preview (3)**: `file_search_ripgrep`, `pdf_generate`, `file_preview`.
  - **Desktop & Productivity (5)**: `clipboard_get`, `clipboard_set`, `screen_capture`, `system_open`, `notification_send`.
  - **System, Processes & Services (9)**: `system_info`, `gpu_info`, `process_list`, `process_kill`, `port_check`, `eventlog_query`, `service_list`, `service_status`, `service_control`.
  - **Network & Diagnostics (3)**: `http_ping`, `http_request`, `network_info`.
- **Enterprise Security**:
  - Configurable command allowlist & regex blacklist blocking destructive commands (`format`, `diskpart`, `rmdir /s /q C:\`, etc.).
  - Read-only enforcement mode (`--read-only`).
  - Path confinement (`allowedDirectories`).
  - Automatic secret and bearer token masking in all log channels.
  - SHA-256 audit logging to daily rotating log files.
- **Dynamic Tool Profile System ("Load Only What You Need")**:
  - `minimal` profile: 6 essential tools for small models like Claude 3.5 Haiku and Llama 8B (~85% context token savings).
  - `core` profile: 15 essential tools for basic coding (~60% context token savings).
  - `dev` profile: 28 tools for full-stack software development with background tasks, ripgrep, archives, HTTP testing, PDF reports, system open, and previews (~32% token savings).
  - `sysadmin` profile: 37 tools for IT management, services, event logs, network, tasks, ripgrep, archives, and desktop automation (all tools except headless `pdf_generate`).
  - `full` profile: All 38 tools and resources (default).
  - **Custom Profiles (`--tools`)**: Whitelist specific tools or dynamically extend/shrink any profile using `+tool` and `-tool` modifiers (e.g. `--profile dev --tools "+pdf_generate"`).
  - Configure via CLI (`--profile <name>` or `-p <name>`), env var (`WINHELM_PROFILE`), or `winhelm.config.json`.
  - Visual status badge and inactive tool indicators on Web Monitor Dashboard.
  - Backward compatibility: `--profile full` remains the default if unspecified to preserve full legacy behavior.
- **Standalone Binary Packaging**:
  - Node.js Single Executable Application (SEA) build script creating portable `winhelm.exe` (~2.6 MB bundle).
- **Test Suite**:
  - 68 automated unit, integration, stress, and profile tests passing with 100% test coverage across 25 suites.
