# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.1] - 2026-09-29

### Security & Hardening (Tasks 1–10)
- **Task 1: PowerShell Injection Defense (Unicode Smart Quotes)** [`323a7f2`]: Added `psQuote()` escaping for Unicode smart quotes (`\u2018`, `\u2019`, `\u201A`, `\u201B`), rejected null bytes (`\0`) and unescaped newlines. Migrated PowerShell engine parameter passing in filesystem and system tools to isolated environment variables (`$env:WH_ARG_*`).
- **Task 2: Child Process Environment Scrubbing** [`43c316f`]: Created `getCleanChildEnv()` to sanitize inherited environment variables before spawning child processes, blocking leakage of `MCP_AUTH_TOKEN`, `WINHELM_AUTH_TOKEN`, `AUTH_TOKEN`, and `SECRET` to subshells or child tools.
- **Task 3: Audit Log & Sanitizer Hardening** [`9beaf58`]:
  - Structured audit logger hashes session IDs with SHA-256 (first 12 chars) to prevent raw session token persistence.
  - Hardened credential masking regexes to support quoted strings, Bearer variations, and query parameters (`exchange=`, `winhelm_session=`, `session=`).
  - Terminal logs enforce a 500-char cap on tool inputs and 200-char cap on outputs/errors.
- **Task 4: Fail-Closed Boundary Consistency (`allowSystemExecution: false`)** [`eb9904f`]:
  - `powershell-runner` validates effective working directory against `allowedDirectories` when no explicit `cwd` is supplied.
  - Command path checker verifies all absolute path tokens against `allowedDirectories` rather than only drive root prefixes.
  - Security warning emitted immediately whenever CLI flags enable system execution.
- **Task 5: Session Absolute Lifetime & MCP Protocol Token Isolation** [`496ee10`]:
  - Implemented 12-hour absolute maximum lifetime cap (`maxLifetimeMs`) on ephemeral sessions in addition to the 15-minute sliding window.
  - Separated protocol handling: query-token authenticated requests to `/mcp`, `/sse`, and `/message` do not generate browser session cookies or trigger `Set-Cookie` headers.
- **Task 6: Dashboard Output HTML Encoding & Strict CSP** [`bd12937`]:
  - Exported `escapeHtml()` and applied server-side and client-side HTML encoding to all dynamic monitor fields (log titles, details, statuses, drive names, GPU metadata).
  - Enforced strict Content-Security-Policy on `/` and `/dashboard`.
- **Task 7: Startup Gate for Network Exposure** [`80ca9d9`]:
  - Introduced `validateNetworkExposure()`: WinHelm rejects startup with exit code 1 if configured with a non-loopback host interface without an active authentication token.
- **Task 8: Repo Hygiene & Version Centralization** [`17824df`]:
  - Untracked `winhelm.config.json` from git and updated `.gitignore`.
  - Added priority loading for `winhelm.local.json` before `winhelm.config.json`.
  - Centralized server version reporting to `src/utils/version.ts` dynamically sourced from `package.json`.
- **Task 9: Robustness Caps & Safe Process Cleanup** [`ff68554`]:
  - Capped stdout and stderr at 1 MB per stream in `runPowerShell()` and limited task output buffers to 1 MB in `TaskManager`.
  - Implemented Windows process tree termination on timeout using `taskkill /PID <pid> /T /F` prior to SIGKILL.
  - Restricted `/preview` to files ≤ 5 MB to prevent memory exhaustion.
  - Explicitly blocked `Host: 0.0.0.0` in `isHostAllowed()`.
- **Task 10: Documentation Accuracy & Test Suite Verification** [`6d7be10`]:
  - Updated documentation accuracy across `README.md`, `SECURITY.md`, `docs/SECURITY.md`, `docs/THREAT_MODEL.md`, `TERMS_OF_USE.md`, and `CHANGELOG.md`.
  - Fixed test harness `authToken: null` handling in `createServer` options so unauthenticated tests are isolated from local machine config tokens.
  - Full suite verification: 219/219 tests passing across 62 suites (0 failures).

---

## [1.2.0] - 2026-09-29

### Breaking Changes
- **Fail-Closed System Execution Confinement (`allowSystemExecution: false`)**: Changed `allowSystemExecution` default from `true` to `false` (Fail-Closed). Access to system runtime binaries outside explicitly allowed directories (e.g. `C:\Windows\System32`) is now blocked by default. To execute system tools, opt in via CLI `--system-exec`, environment variable `WINHELM_ALLOW_SYSTEM_EXEC=1`, or config `"allowSystemExecution": true`. A prominent terminal warning is displayed whenever system execution is active.

### Security & Hardening
- **One-Time Exchange Token Architecture & Ephemeral Sessions**: Replaced long-lived master URL tokens with single-use exchange tokens (`POST /auth/exchange` or `?exchange=<token>`). Exchange tokens are immediately invalidated upon consumption to eliminate Replay Attacks. The gateway issues an ephemeral sliding session cookie (`winhelm_session`, 15-minute sliding TTL) with `SameSite=Strict; HttpOnly` flags.
- **Browser Address Bar Token Stripping**: Browser dashboard access via query token immediately triggers an HTTP 302 redirect that sets the session cookie and strips the token from the browser address bar and history.
- **W3C CORS Spec Compliance**: Implemented dynamic origin reflection when `corsOrigins` is set to `"*"` alongside `credentials: true`, adhering to W3C CORS specifications without browser origin rejection.
- **Unicode Path Normalization (NFKC)**: Added NFKC normalization to `isPathAllowed()` before resolving paths, preventing directory traversal escapes via full-width Unicode dots (`\uFF0E\uFF0E/`).
- **Request URL Log Sanitization**: Automatically masks secret tokens in `req.originalUrl` before passing requests to terminal and file loggers, preventing credentials from leaking into terminal outputs or disk logs.
- **Dedicated JSONL Audit Logger**: Introduced append-only audit logger writing to `logs/audit.log` with automatic 10MB file rotation and 5 backup files.
- **STRIDE Threat Model & Compliance Documentation**: Added `docs/THREAT_MODEL.md` (covering STRIDE matrix, Mermaid architecture, and residual risk assessment), bilingual `TERMS_OF_USE.md` (Shared Responsibility Model), root `SECURITY.md`, GitHub security workflow (`.github/workflows/security.yml`), and RFC 9116 `public/.well-known/security.txt`.
- **Security Boundary Unit Test Suite**: Added 30 comprehensive unit tests (`test/unit/security-boundary.test.ts`) validating path confinement, Unicode NFKC, UNC escape, DNS rebinding, credential masking, timing attacks, rate limiting, and session lifecycle.

---

## [1.1.2] - 2026-09-28

### Fixed
- **Browser Extension & IDE Webview CORS Support**: Added native whitelist support in `isOriginAllowed()` for `chrome-extension://` (Chrome, Edge, Brave, Arc), `moz-extension://` (Firefox), `safari-web-extension://` (Safari), and `vscode-webview://` (VS Code / Cursor). Resolves HTTP 405 Method Not Allowed errors when connecting via browser extensions.
- **CORS `Access-Control-Expose-Headers` for `Mcp-Session-Id`**: Configured CORS middleware to explicitly expose `Mcp-Session-Id`, `Mcp-Protocol-Version`, and `Last-Event-ID`. Prevents browsers from hiding the session ID header from client-side JavaScript, resolving `400 Bad Request: Server not initialized` errors on subsequent requests.
- **Session ID Query Parameter Fallback**: Added fallback parsing in `StreamableGateway` for `?sessionId=...` and `?mcp-session-id=...` query parameters alongside standard headers with optional chaining support.

---

## [1.1.1] - 2026-09-28

### Fixed
- **Tailscale & Remote Origin CORS Support**: Extended CORS origin validation (`isOriginAllowed`) to permit Tailscale CGNAT IP addresses (`100.64.0.0/10` e.g. `100.78.131.83`), MagicDNS (`*.ts.net`), and remote Web MCP AI clients (`claude.ai`, `chatgpt.com`).
- **Graceful CORS Error Handling**: Changed origin rejection to omit the `Access-Control-Allow-Origin` header (`callback(null, false)`) instead of throwing an unhandled `Error`, preventing Express from dumping 500 error stack traces in terminal output on unrecognized origins.
- **Tailscale IP in Host Validation**: Added automatic permission for the Tailscale CGNAT subnet (`100.64.0.0/10`) in `isHostAllowed()`, enabling seamless direct connection via Tailscale IP alongside MagicDNS domains.
- **Smart Browser Redirect for `/mcp`**: Added automatic detection for human web browser visits (`Accept: text/html`) on `GET /mcp` and redirects to the Web Monitor Dashboard (`/?token=...`), eliminating confusing `406 Not Acceptable` errors when URLs are pasted into a browser.

---

## [1.1.0] - 2026-09-28

### Breaking Changes
- **Fail-Closed by Default Filesystem Confinement (`allowedDirectories`)**: Changed the default security semantic of `allowedDirectories: []` or empty/unconfigured. Previously, an empty array permitted full filesystem access ("fail-open"). It now strictly blocks all filesystem operations ("fail-closed") with a descriptive security error. To restore full-drive access, you must explicitly opt-in using wildcard syntax `allowedDirectories: ["*"]` or `["all"]`. Existing configurations that relied on `[]` for open access must update to `["*"]`.

### Security
- **Host Header Validation & DNS Rebinding Defense (`allowedHosts`)**: Added strict Host header validation middleware restricting incoming HTTP requests to configured hosts (default: `localhost`, `127.0.0.1`, `[::1]`, and `*.ts.net`). Requests with unrecognized or forged `Host` headers are rejected with 403 Forbidden. Configurable via `allowedHosts` in config or `MCP_ALLOWED_HOSTS` environment variable.
- **Unauthenticated Remote Proxy / Tunnel Gate**: Enforced an immediate fail-closed 403 Forbidden gate when requests are proxied via `X-Forwarded-For` or `Forwarded` headers while no `authToken` is configured, preventing accidental public access without authentication.
- **Strict Read-Only Mode Enforcement**: Extended `isReadOnly()` enforcement to `terminal_run` and `terminal_task_start` in terminal tools, and blocked state-mutating HTTP methods (`POST`, `PUT`, `DELETE`, `PATCH`) in `http_request`.
- **Fail-Closed on Corrupt Configuration**: Changed `ConfigManager.loadConfigSync()` and `init()` to throw fatal errors upon JSON parsing syntax errors instead of silently falling back to defaults.
- **Markdown Code Block Language Tag Sanitization**: Sanitized `codeBlockLang` in PDF generator against regex `/[^\w\-]/g` and escaped HTML to prevent markup and attribute injection.
- **Preview Content-Security-Policy & Global Security Headers**: Added strict CSP (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none';`) to `/preview` and enforced global `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` on all HTTP responses.
- **Cookie Security Hardening**: Enhanced `Set-Cookie` with `Max-Age=2592000` (30 days), `SameSite=Lax`, and conditional `Secure` flag when served over HTTPS.
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
- **Production Configuration Template (`winhelm.config.example.json`)**: Added an out-of-the-box configuration template with `profile: core`, example `allowedDirectories`, and `allowedHosts`.
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
- **NPM Distribution Package Whitelist**: Cleaned up `package.json` `"files"` array to strictly bundle runtime distribution artifacts (`dist`, `docs`, `manifest.json`, `server.json`, `scripts/build-exe.ps1`, `scripts/manage-service.ps1`, `CHANGELOG.md`, `README.md`, `LICENSE`), excluding development configs, tests, and internal scratch scripts.
- Refactored `ConfigManager.updateConfig()` to default to `persist = false` for safer runtime overrides and test execution.

### Tests
- Expanded automated test coverage from 68 tests across 25 suites to **114 automated tests across 29 suites** (100% passing, 0 failures), adding comprehensive test coverage for regex blocklists, custom configuration paths, non-persistence behavior, source path confinement, ANSI and JSON/AWS log sanitization, `start.ps1` loopback defaults and safety enforcement, Tailscale Funnel security gates, fail-closed `allowedDirectories` boundary enforcement, URL query token authentication for Claude.ai, browser session cookie persistence, pwsh detection and fallback, file search directory exclusion, gateway session idle/LRU/404 lifecycle eviction, Host header validation, remote proxy gate, corrupt config fail-closed, read-only terminal and HTTP method guards, code block language tag sanitization, CSP and security headers, and cookie attributes.

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
