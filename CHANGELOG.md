# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-09-27

### Added
- **Unified Dual-Protocol Gateway**:
  - Full support for MCP **Streamable HTTP** (`/mcp`) protocol.
  - Full backward compatibility for **Server-Sent Events** (`/sse`, `/message`).
  - Real-time Web Monitor Dashboard (`/` and `/dashboard`) with live request throughput, log streams, and GPU stats.
  - Interactive file and markdown viewer (`/preview?path=<file>`).
  - MCP UI App Resource: `preview://file`.
- **38 Native Windows Tools**:
  - **Terminal & Background Execution**: `terminal_run`, `terminal_task_start`, `terminal_task_stop`, `terminal_task_status`, `terminal_task_list`, `terminal_task_input`.
  - **Filesystem & Search**: `file_read`, `file_write`, `file_edit`, `file_list`, `file_search`, `file_tail`, `file_hash`, `file_copy`, `file_move`, `file_archive_zip`, `file_extract_zip`, `file_recycle_bin`, `ripgrep_search`.
  - **Workstation & Inspection**: `process_list`, `process_kill`, `eventlog_query`, `network_info`, `windows_service_list`, `windows_service_action`, `system_info`, `system_monitor`.
  - **Desktop & Productivity**: `screen_capture`, `app_launch`, `clipboard_read`, `clipboard_write`, `notification_send`, `pdf_generate`.
  - **Network & Diagnostics**: `http_ping`, `http_request`.
  - **Auditing & Config**: `log_export`, `config_view`, `config_reload`.
- **Enterprise Security**:
  - Configurable command allowlist & regex blacklist blocking destructive commands (`format`, `diskpart`, `rmdir /s /q C:\`, etc.).
  - Read-only enforcement mode (`--read-only`).
  - Path confinement (`allowedDirectories`).
  - Automatic secret and bearer token masking in all log channels.
  - SHA-256 audit logging to daily rotating log files.
- **Dynamic Tool Profile System ("Load Only What You Need")**:
  - `core` profile: 15 essential tools for basic coding (~60% context token savings).
  - `dev` profile: 25 tools for full-stack software development with background tasks, ripgrep, archives, and previews (~35% token savings).
  - `sysadmin` profile: 32 tools for IT management, services, event logs, network, and desktop automation.
  - `full` profile: All 38 tools and resources (default).
  - Configure via CLI (`--profile <name>` or `-p <name>`), env var (`WINHELM_PROFILE`), or `winhelm.config.json`.
  - Visual status badge and inactive tool indicators on Web Monitor Dashboard.
- **Standalone Binary Packaging**:
  - Node.js Single Executable Application (SEA) build script creating portable `winhelm.exe` (~2.6 MB bundle).
- **Test Suite**:
  - 59 automated unit, integration, stress, and profile tests passing with 100% test coverage across 25 suites.
