# WinHelm MCP — Security Model & Architecture

Security is a foundational design pillar of WinHelm. Giving an AI agent access to terminal execution, filesystem writes, and system processes requires robust, multi-layered safeguards.

---

## 1. Multi-Layer Security Architecture

```
[ MCP Client / AI Agent ]
           │
           ▼
┌──────────────────────────────────────────────┐
│  Layer 1: Network & Authentication Gate      │
│  - Token Authentication (Bearer Header)     │
│  - Rate Limiting (120 req/min Sliding Window)│
└──────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  Layer 2: Operation & Read-Only Guard        │
│  - Enforce Read-Only Mode (--read-only)      │
│  - Mutating Tools Blocked at Dispatcher      │
└──────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  Layer 3: Filesystem Confinement             │
│  - Allowed Directories Whitelist             │
│  - Drive Letter Isolation (e.g. D:\ only)    │
│  - Path Traversal (..\) Sanitization         │
└──────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  Layer 4: Command Filter & Execution Shield  │
│  - Blacklist Pattern Regex Filtering         │
│  - Destructive Command Interception          │
│  - NonInteractive / NoProfile PowerShell     │
└──────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  Layer 5: Secret Masking & Audit Logging     │
│  - Auto Redaction of API Keys & Passwords    │
│  - Daily Rotating Log Files with Hashing     │
└──────────────────────────────────────────────┘
```

---

## 2. Authentication & Access Control

By default, WinHelm binds strictly to **`127.0.0.1` (localhost loopback)**, preventing external machines on your local network (LAN) or public internet from reaching the server.

If you attempt to bind WinHelm to an external interface (`--host 0.0.0.0` or a LAN IP) without configuring an authentication token, WinHelm activates a **Fail-Closed Startup Gate** (`validateNetworkExposure`) and immediately terminates with exit code 1 to prevent accidental open remote code execution. In any shared, multi-user, LAN, or remote setup, you must enforce Bearer Token authentication:

### CLI Flag
```powershell
winhelm --auth "my-secure-random-token-here"
```

### Environment Variable
```powershell
$env:MCP_AUTH_TOKEN = "my-secure-random-token-here"
winhelm
```

When enabled:
- All protocol endpoints (`/mcp`, `/sse`, `/message`), file previews (`/preview`), and administrative telemetry APIs (`/api/monitor/*`) require an `Authorization: Bearer <token>` header.
- For clients without custom header support (such as Claude.ai Custom Connectors) or convenient browser access to the Web Monitor Dashboard and Previewer, the token can also be supplied via URL query parameter (`?token=<token>` or `?auth=<token>`) or browser cookie.
- Unauthenticated access is strictly confined to public health checks (`/health`) and the basic dashboard HTML shell (`/`, `/dashboard`).

### Disabling Authentication (`"authToken": null`)

If `"authToken"` is explicitly set to `null` in `winhelm.config.json` (or `--auth` / `MCP_AUTH_TOKEN` is omitted):
- The server operates in **No-Auth Mode** (`Public network mode active (No auth token set)`).
- Incoming MCP requests and tools are executed without verifying any Bearer token or query token.
- **Fail-Closed Startup Gate:** This mode is strictly confined to local loopback development (`127.0.0.1`, `localhost`). WinHelm will refuse to start on non-loopback addresses (`0.0.0.0` or LAN interfaces) without an authentication token. Safety gates in `start-funnel.ps1` also guard Tailscale Funnels.

---

## 3. Read-Only Enforcement Mode

If you wish to allow an AI agent to read code, query event logs, and inspect system telemetry without modifying anything, start WinHelm in **Read-Only Mode**:

```powershell
winhelm --read-only
```

When active, any call to mutating tools (e.g. `file_write`, `file_edit`, `file_delete_safe`, `terminal_run`, `process_kill`, `service_control`) is rejected before reaching the execution engine.

---

## 4. Path Confinement (`allowedDirectories`) & Fail-Closed Design

WinHelm follows a **fail-closed by default** security principle:
- **Default (`allowedDirectories: []` or empty)**: If no allowed directories are configured, **all filesystem operations are strictly blocked**. This prevents accidental full-machine exposure when running an unconfigured instance.
- **Specific Directory Whitelist**: Specify target directories or drives to restrict access:
  ```json
  {
    "allowedDirectories": [
      "D:\\mcp",
      "C:\\Projects"
    ],
    "allowSystemExecution": false
  }
  ```
- **System Execution Isolation (`allowSystemExecution`)**:
  - **Default: `false` (Fail-Closed)**. Commands referencing drives outside `allowedDirectories` (such as `C:\`) or invoking system binaries outside the whitelist are blocked by default.
  - To allow invoking runtime binaries on `C:\` (such as `python.exe`, `node.exe`, `git.exe`) while keeping file tools restricted to your project drive, explicitly enable `"allowSystemExecution": true`, pass the `--system-exec` CLI flag, or set `WINHELM_ALLOW_SYSTEM_EXEC=true`.
  - When enabled, WinHelm logs a security warning: `[SECURITY] System execution enabled - Runtime binaries on C: are now accessible`.
- **Whole-Volume Whitelist**: You can whitelist an entire volume by specifying `"D:\\"`, `"D:"`, or `"D"`.
- **Wildcard Full-Drive Access (`["*"]` or `["all"]`)**: You can explicitly opt-in to unrestricted machine access by configuring `["*"]` or `["all"]`.
  > ⚠️ **Warning:** Wildcard access (`["*"]`) should only be used for trusted, local single-user development with authentication enabled. Never expose an unauthenticated server with wildcard access to a public network or reverse proxy.
- Any attempt to access paths outside the whitelist is rejected with a descriptive security error.
- Path traversal tricks (`..\..\Windows\System32`) and NTFS directory junctions/symlinks are resolved to canonical real paths via `fs.realpathSync` before boundary checks.

---

---

## 5. Security Model & Trust Boundaries (Important Clarification)

To configure WinHelm safely, understand the distinction between hard security boundaries and defense-in-depth safeguards:

### 🛡️ Hard Security Boundaries
1. **Authentication Token (`authToken` / `--auth`)**:
   - The primary security perimeter. When enabled, all MCP protocol interactions, tool dispatches, file previews, and monitoring APIs require token verification via timing-safe comparison (`crypto.timingSafeEqual`).
2. **Tool Profiles (`--profile minimal` or `--profile core`)**:
   - The most effective containment strategy. Profiles strictly exclude tools at registration time. Using `core` provides 15 file inspection and reading tools while completely excluding `terminal_run`, `terminal_task_start`, and system mutation tools.
3. **Read-Only Mode (`--read-only`)**:
   - Enforces an immutable environment. Blocks all filesystem modifications, archive creations, service controls, process terminations, mutating HTTP methods (POST/PUT/DELETE), and shell executions (`terminal_run` / `terminal_task_start`).

### ⚠️ Defense-in-Depth Safeguards (Not Hard Security Boundaries)
1. **Command Blocklist Patterns**:
   - Regex-based command filtering is designed to prevent accidental destructive operations (e.g. `format-volume`, `rmdir /s /q C:\`). It is **not** an impregnable security sandbox against intentional evasion, as PowerShell syntax supports aliases, string concatenation, and encoded commands (`-EncodedCommand`, `iex`).
2. **Filesystem Confinement (`allowedDirectories`)**:
   - Strictly confines native **File Tools** (`file_read`, `file_write`, `file_edit`, `file_delete_safe`, `copy_file`, `create_zip`, `extract_zip`). It also sets the working directory for terminal execution. However, if `terminal_run` is enabled (under `dev`, `sysadmin`, or `full` profiles) with `allowSystemExecution: true`, processes run with the full operating system permissions of the Windows user account running WinHelm.

---

## 6. Network Hardening & Web Protections

1. **Host Header Validation (DNS Rebinding Defense)**:
   - WinHelm validates incoming `Host` headers against an allowlist (`localhost`, `127.0.0.1`, `[::1]`, and configured `allowedHosts` such as `*.ts.net`). Requests with unauthorized host headers are rejected with **HTTP 403 Forbidden**, preventing malicious websites from exploiting browser same-origin policies via DNS rebinding.
   - `Host: 0.0.0.0` is explicitly rejected in all configurations, as `0.0.0.0` is a network bind address rather than a valid request host.
2. **Unauthenticated Remote Proxy / Tunnel Guard**:
   - If WinHelm is started without an authentication token (`authToken: null`), any request detected arriving through a reverse proxy or tunnel (containing `X-Forwarded-For` or `Forwarded` headers) is immediately blocked with **HTTP 403 Forbidden** (Fail-Closed). This prevents accidental exposure of a local shell to the internet.
3. **Content Security Policy & Security Headers**:
   - Web Monitor Dashboard routes (`/`, `/dashboard`) enforce a strict Content Security Policy (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'none'; base-uri 'self';`).
   - File previews (`/preview`) enforce an isolated CSP (`default-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'`) preventing previewed files from executing network requests against the local API.
   - Global HTTP responses include `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
4. **Robustness Caps & Resource Protection**:
   - **Terminal Buffer Cap**: Standard output and standard error in `runPowerShell()` and background tasks are capped at 1 MB per stream to prevent process memory exhaustion.
   - **Windows Process Tree Cleanup**: When commands exceed their timeout, WinHelm terminates the entire child process tree via native Windows `taskkill /PID <pid> /T /F` prior to SIGKILL.
   - **File Preview Size Cap**: The `/preview` endpoint rejects files exceeding 5 MB before reading into memory.
5. **Token Security Notice**:
   - While `?token=...` query parameters are supported for browser dashboards and Claude.ai custom connectors, automated tools and production integrations should prefer `Authorization: Bearer <token>` headers to avoid token retention in intermediate proxy logs or browser history. Protocol endpoints (`/mcp`, `/sse`, `/message`) do not establish browser cookies or sessions when authenticated via query token.

---

## 7. Dangerous Command Blacklist

WinHelm inspects command lines executed via `terminal_run` or `terminal_task_start` against regex patterns targeting destructive or risky actions:

| Category | Blocked Patterns |
| :--- | :--- |
| **Disk & Partition Formatting** | `format\s+`, `format-volume`, `diskpart`, `clear-disk`, `initialize-disk` |
| **Recursive Root Deletion** | `rmdir\s+/[sS]`, `del\s+/[fF]/[sS]/[qQ]\s+[cC]:\\`, `remove-item\s+.*-recurse\s+.*[cC]:\\` |
| **Registry & Boot Tampering** | `reg\s+delete\s+hklm`, `bcdedit`, `bootrec` |
| **Account & Privilege Escalation** | `net\s+user\s+.*\/add`, `takeown\s+/[fF]`, `icacls\s+.*\/grant` |
| **Credential Dumping** | `mimikatz`, `procdump\s+.*lsass`, `comsvcs\.dll` |

---

## 8. Secret Redaction & Log Sanitization

Before log entries are displayed on the Web Monitor Dashboard or written to disk, all text is piped through [sanitizer.ts](../src/utils/sanitizer.ts):

- **Bearer Tokens**: `Bearer ************`
- **OpenAI & Claude API Keys**: `sk-ant-************`, `sk-************`
- **GitHub Tokens**: `ghp_************`, `gho_************`
- **AWS Access Keys**: `AKIA************`
- **JSON Fields & Credentials**: `"authToken": "************"`, `"password": "************"`, `"x-api-key": "************"`
- **Password Objects**: `{ "password": "************" }`

---

## 9. Audit Logging & Export

All executed commands, exit codes, durations, and tool errors are sequentially logged to daily audit logs in `logs/winhelm-YYYY-MM-DD.log`.

In addition, security-relevant events (blocked requests, authentication attempts, path traversal blocks, and tool executions) are permanently appended to a dedicated structured JSONL file in `logs/audit.log` via [audit-logger.ts](../src/utils/audit-logger.ts) with automatic 10MB file rotation and backup management.

You can export audit logs at any time via the Web Monitor Dashboard buttons ("📥 Export JSON" / "📥 Export CSV") or programmatically via the HTTP endpoint:
```
GET /api/monitor/export?format=json
GET /api/monitor/export?format=csv
```

Logs older than 7 days are automatically pruned to prevent disk consumption.

---

## 10. Ephemeral Session Authentication

To eliminate persistent credential exposure in browser URLs, history, and bookmarks:
- The master `authToken` can be exchanged via `POST /auth/exchange` (or single-use `?exchange=<token>`) for an ephemeral `winhelm_session` cookie. Exchange tokens are immediately destroyed upon consumption to prevent replay attacks.
- Ephemeral sessions use cryptographically secure 64-character hex identifiers (`crypto.randomBytes(32)`).
- Sessions are subject to a **15-minute sliding expiration window** (`Max-Age=900; SameSite=Lax; HttpOnly`). Each valid request refreshes the 15-minute window. Cookie refreshes are throttled until 50% of the sliding window has elapsed.
- In addition to sliding expiry, sessions enforce a **12-hour absolute maximum lifetime cap** (`maxLifetimeMs`), guaranteeing that continuous activity cannot extend a session indefinitely.
- When navigating to the Web Monitor Dashboard with a URL query token, WinHelm automatically exchanges the token for a session cookie and issues a clean 302 redirect to strip the token from the browser address bar.
- Protocol endpoints (`/mcp`, `/sse`, `/message`) authenticated via query token do not set session cookies. Remote MCP connectors (such as Claude.ai) continue to support standard `Authorization: Bearer <token>` and URL query parameters with zero breaking changes.

---

## 11. Threat Model & Legal Disclaimers

- 🎯 **[Threat Model & STRIDE Analysis](THREAT_MODEL.md)**: Exhaustive threat enumeration, trust boundary diagrams, assumptions, and mitigations.
- 📜 **[Terms of Use & Security Disclaimer](../TERMS_OF_USE.md)**: Bilingual (English & Thai) terms detailing the Shared Responsibility Model and warranty disclaimer.
- 🔒 **[Vulnerability Disclosure Policy](../SECURITY.md)**: Coordinated disclosure instructions and response commitments.
