# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-09-27

### Security
- **Default Network Interface Hardening**: Changed default HTTP binding host from `0.0.0.0` to `127.0.0.1` (loopback only) to prevent unintentional exposure to the local network or public internet. Added a prominent console warning when binding to non-loopback addresses without authentication.
- **Closed Auth Bypass for Dashboard & Preview**: Enforced authentication on `/preview` and `/api/monitor/*` endpoints. Added support for token authentication via query parameter (`?token=...` or `?auth=...`) and HTTP cookie fallback for browser dashboard and markdown previewer access.
- **Filesystem Source-Path Confinement**: Added strict `allowedDirectories` path confinement checks for `sourcePath` in `copyFileOrDir`, `sourceDir` in `createZip`, and `zipPath` in `extractZip` to prevent exfiltration or copying of files outside allowed boundaries.
- **Dangerous Command Blocklist Enforcement (Option A)**: Integrated `DEFAULT_BLOCKED_PATTERNS` regex blocklist in `ConfigManager.isCommandAllowed()` blocking destructive system manipulation commands including `reg delete HKLM`, `diskpart`, `mimikatz`, `procdump`, `bcdedit`, `net user /add`, `takeown /f`, and `icacls /grant`.
- **Symlink & Junction Traversal Guard**: Integrated `fs.realpathSync` path canonicalization in `ConfigManager.isPathAllowed()` to resolve symlinks and NTFS directory junctions before boundary evaluation.
- **CORS Hardening**: Restricted CORS default origins to localhost / loopback interfaces (`127.0.0.1`, `[::1]`, and active port origins) instead of wildcard `*`.
- **Console Request Log Sanitization**: Updated `Logger.req()` to mask sensitive tokens and credentials in URL query parameters using `sanitizeText()` prior to log string assembly, preserving ANSI color codes in console output.

### Added
- **`--config <path>` Flag**: Added ability to load configuration directly from any specified JSON path, bypassing default search candidates for multi-project isolation. Includes automatic UTF-8 BOM stripping.
- **Session Non-Persistence Mode**: CLI overrides (`--allowed-dirs`, `--auth`, `--profile`, `--tools`, `--read-only`) now default to in-memory application without mutating configuration files on disk (`persist = false`). Added `--persist` flag for opt-in disk persistence.

### Changed
- Refactored `ConfigManager.updateConfig()` to default to `persist = false` for safer runtime overrides and test execution.

### Tests
- Expanded automated test coverage from 68 tests across 25 suites to **78 automated tests across 26 suites** (100% passing, 0 failures), adding comprehensive test coverage for regex blocklists, custom configuration paths, non-persistence behavior, source path confinement, and ANSI log sanitization.

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
