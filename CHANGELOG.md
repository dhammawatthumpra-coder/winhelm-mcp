# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-09-28

### Breaking Changes
- **Fail-Closed by Default Filesystem Confinement (`allowedDirectories`)**: Changed the default security semantic of `allowedDirectories: []` or empty/unconfigured. Previously, an empty array permitted full filesystem access ("fail-open"). It now strictly blocks all filesystem operations ("fail-closed") with a descriptive security error. To restore full-drive access, you must explicitly opt-in using wildcard syntax `allowedDirectories: ["*"]` or `["all"]`. Existing configurations that relied on `[]` for open access must update to `["*"]`.

### Security
- **Default Network Interface Hardening**: Changed default HTTP binding host from `0.0.0.0` to `127.0.0.1` (loopback only) to prevent unintentional exposure to the local network or public internet. Added a prominent console warning when binding to non-loopback addresses without authentication.
- **Closed Auth Bypass for Dashboard & Preview**: Enforced authentication on `/preview` and `/api/monitor/*` endpoints. Added support for token authentication via query parameter (`?token=...` or `?auth=...`) and HTTP cookie fallback for browser dashboard and markdown previewer access.
- **Filesystem Source-Path Confinement**: Added strict `allowedDirectories` path confinement checks for `sourcePath` in `copyFileOrDir`, `sourceDir` in `createZip`, and `zipPath` in `extractZip` to prevent exfiltration or copying of files outside allowed boundaries.
- **Dangerous Command Blocklist Enforcement (Option A)**: Integrated `DEFAULT_BLOCKED_PATTERNS` regex blocklist in `ConfigManager.isCommandAllowed()` blocking destructive system manipulation commands including `reg delete HKLM`, `diskpart`, `mimikatz`, `procdump`, `bcdedit`, `net user /add`, `takeown /f`, and `icacls /grant`.
- **Symlink & Junction Traversal Guard**: Integrated `fs.realpathSync` path canonicalization in `ConfigManager.isPathAllowed()` to resolve symlinks and NTFS directory junctions before boundary evaluation.
- **CORS Hardening**: Restricted CORS default origins to localhost / loopback interfaces (`127.0.0.1`, `[::1]`, and active port origins) instead of wildcard `*`.
- **Console Request Log & Output Sanitization**: Enhanced `sanitizeText()` and `sanitizeObject()` to automatically mask quoted JSON credential fields (`"authToken"`, `"password"`, `"x-api-key"`, etc.) and AWS access keys (`AKIA...`) with asterisks (`***`). Applied sanitization across `Logger.toolStart` and `Logger.toolDone` to prevent secret leakage in console stdout and log streams.
- **Hardened `start.ps1` & Host Safety Gate**: Changed default `$HostAddr` parameter in `start.ps1` from `0.0.0.0` to `127.0.0.1`. Added a mandatory security validation gate that blocks execution with exit code 1 if a non-loopback interface (e.g. `0.0.0.0`) is requested without an authentication token (via `-Auth`, environment variable, or config file).
- **Reverse Proxy Support (`trust proxy: loopback`)**: Configured Express `trust proxy` to `"loopback"` so rate limiting and request logging receive client's real IP via `X-Forwarded-For` through Tailscale Funnel and local tunnel reverse proxies.
- **Timing Attack Mitigation**: Replaced standard string equality comparison for Bearer token and browser authentication with `crypto.timingSafeEqual` with buffer length validation (`safeCompare`) to eliminate timing side-channel attacks.
- **Markdown Link & XSS Sanitization**: Hardened `formatInline()` across PDF generation and interactive file preview by sanitizing and neutralizing dangerous link schemes (`javascript:`, `vbscript:`, `data:`).
- **Request Logger Ingestion for Document Previews**: Removed `/preview` endpoint from internal polling filter so document preview access is captured in terminal and file request logs.
- **Local Personal Config Isolation**: Added `.gitignore` pattern for `*.local.json` and `winhelm.local.json`, allowing machines to configure full-drive access without risking accidental commits to public repositories.

### Added
- **Browser Session Cookie Persistence**: Gateway automatically issues a secure `Set-Cookie: authToken=...; Path=/; HttpOnly; SameSite=Lax` header upon validating a URL query token (`?token=...`), ensuring seamless persistent authentication on the Web Monitor Dashboard and Previewer across page reloads and link clicks.
- **Streamable HTTP Session 404 & Lifecycle Cleanup**: Added strict HTTP 404 (`Session not found`, JSON-RPC code `-32001`) response for unknown or evicted `mcp-session-id` on `/mcp`. Configured `onsessioninitialized` session registration, placed `transport.onclose` before `connect()` to preserve SDK teardown, and ensured uninitialized/rejected transports are immediately closed to prevent memory leaks.
- **NPM Package & Executable Readiness**: Added `#!/usr/bin/env node` shebang in CLI entrypoint for global npm/npx execution (`winhelm`), formal ESM `exports` map, standard package metadata (`repository`, `homepage`, `bugs`, `keywords`), and automated `prepublishOnly` lifecycle validation (`npm run build && npm test`).
- **Runtime Engine Alignment**: Standardized Node.js minimum requirement to `Node.js >= 20.0.0` across package configuration and documentation.
- **`--config <path>` Flag**: Added ability to load configuration directly from any specified JSON path, bypassing default search candidates for multi-project isolation. Includes automatic UTF-8 BOM stripping.
- **Session Non-Persistence Mode**: CLI overrides (`--allowed-dirs`, `--auth`, `--profile`, `--tools`, `--read-only`) now default to in-memory application without mutating configuration files on disk (`persist = false`). Added `--persist` flag for opt-in disk persistence.
- **Enhanced `start.ps1` Parameters**: Added `-Config`, `-Tools`, `-ReadOnly`, and `-NoPersist` switches for complete parity with CLI options.
- **PowerShell 7+ (`pwsh`) Fast Fallback**: Automatically detects and leverages `pwsh.exe` for reduced process spawn overhead while preserving 100% backward compatibility via cached fallback to Windows PowerShell (`powershell.exe`). Configurable via `preferPwsh` config option.
- **Build & Log Artifact Search Exclusion**: Automatically excludes `dist/`, `logs/`, `build/`, `out/`, and dot-folders (`.serena/`, `.git/`) from `file_search` and recursive directory scans, with configurable override via `searchExcludeDirs`.
- **Gateway Session Lifecycle & LRU Eviction**: Added idle session eviction (`sessionIdleTimeoutMs`, default 45m) and maximum concurrent session cap (`maxConcurrentSessions`, default 100) with least-recently-used (LRU) pruning in both Streamable HTTP and SSE gateways.

### Changed
- Refactored `ConfigManager.updateConfig()` to default to `persist = false` for safer runtime overrides and test execution.

### Tests
- Expanded automated test coverage from 68 tests across 25 suites to **103 automated tests across 28 suites** (100% passing, 0 failures), adding comprehensive test coverage for regex blocklists, custom configuration paths, non-persistence behavior, source path confinement, ANSI and JSON/AWS log sanitization, `start.ps1` loopback defaults and safety enforcement, Tailscale Funnel security gates, fail-closed `allowedDirectories` boundary enforcement, URL query token authentication for Claude.ai, browser session cookie persistence, pwsh detection and fallback, file search directory exclusion, and gateway session idle/LRU/404 lifecycle eviction.

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
