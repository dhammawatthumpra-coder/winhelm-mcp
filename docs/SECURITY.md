# WinHelm MCP — Security Model & Architecture

Security is a foundational design pillar of WinHelm. Giving an AI agent access to terminal execution, filesystem writes, and system processes requires robust, multi-layered safeguards and clear boundaries between autonomous execution and human authorization.

---

## 1. Multi-Layer Security Architecture

```
[ MCP Clients: Claude Desktop / Cursor / Remote ]
                      │
                      ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 1: Network & Authentication Gate                  │
│  - Loopback-First Binding (127.0.0.1 default)            │
│  - Bearer Token Authentication & Protected Secret Store  │
│  - Host Header Validation (DNS Rebinding Defense)        │
│  - Rate Limiting (120 req/min Sliding Window)            │
└──────────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 2: Schema-v2 Governance & Policy Engine           │
│  - Profile Presets: Safe / Balanced / Power              │
│  - Terminal Execution Policy (off / ask / full)          │
│  - Tool Risk Classification (R0 to R5)                   │
│  - External Process Kill Approval Gate                   │
└──────────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 3: Filesystem Confinement & Protected Paths       │
│  - Folder-Scoped Permissions (read / readwrite)          │
│  - Protected Internal Paths Isolation (~/.winhelm, logs) │
│  - Path Traversal & Symlink Canonicalization             │
│  - Recycle Bin Safe Deletion (file_delete_safe)          │
└──────────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 4: Cross-Process Human Approval Plane             │
│  - Per-Job Durable Mirroring (approval-requests)         │
│  - Atomic First-Writer Decisions (approval-decisions)    │
│  - Web Dashboard Decision Plane (Port 8788)              │
│  - Exactly-Once Execution Invariant (executionCount <= 1)│
│  - Fail-Closed Crash Recovery (unknown state)            │
└──────────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 5: Execution Shield, Sanitization & Audit         │
│  - Direct Argument Vector Execution (command_run)        │
│  - Dangerous Command Regex Interception                  │
│  - Automated Secret Redaction (API Keys, Passwords)      │
│  - Structured JSONL Audit Logging with Session Hashing   │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Configuration Modes: Legacy vs. Schema-v2

WinHelm provides two distinct configuration modes:

### Legacy Mode (v1.2.1 Compatibility)
- Active when `winhelm.config.json` lacks a `schemaVersion` attribute.
- Governed by `allowedDirectories` whitelist and tool profile filtering (`PROFILES`).
- **Approval gating is inactive in legacy mode:** tool calls are not intercepted for human approval, and external process termination is not gated by human approval.
- Exists solely to maintain backward compatibility with v1.2.1 deployments.

### Schema-v2 Mode (`schemaVersion: 2`)
- Explicitly opted in via `winhelm setup` or setting `"schemaVersion": 2`.
- Enforces folder-scoped permissions, terminal modes, risk-based tool authorization policies, and cross-process human approval workflows.
- Internal directories are strictly protected from modification regardless of folder configuration.

---

## 3. Schema-v2 Permission Model & Risk Classes

### Folder Permissions
In schema-v2, filesystem access is declared per-folder:
- `read`: Read-only operations (`file_read`, `file_list`, `file_search`, `file_hash`, `file_tail`, `file_preview`). Mutating file operations are strictly rejected.
- `readwrite`: Read and write operations allowed within the folder subtree.

Every path is resolved to its real canonical path (`fs.realpathSync`) before boundary evaluation, neutralizing path traversal attacks (`..\..\`) and directory junction bypasses.

### Terminal Modes
Terminal mode is one layer of Schema-v2 authorization for execution tools (`terminal_run`, `terminal_task_start`, `command_run`):
- `off`: terminal execution capability is disabled.
- `ask`: terminal execution carries an explicit per-command confirmation floor.
- `full`: terminal execution capability is permitted at this layer, but Approval Mode and mandatory-confirmation rules are still evaluated afterward.

Product presets default to **Smart Approval Mode**. Both Balanced and Power store terminal mode `full`; under default Smart, representative R5 terminal/command actions still require approval. Trusted can remove routine prompts for permitted R5 actions, but it cannot bypass explicit/mandatory confirmation or other security floors.

### Tool Risk Classification (R0 to R5)

| Risk Class | Classification | Tools | Balanced + default Smart |
| :---: | :--- | :--- | :---: |
| **R0** | Read-Only & Inspection | `file_read`, `file_list`, `file_search`, `file_search_ripgrep`, `file_tail`, `file_hash`, `file_preview`, `system_info`, `gpu_info`, `network_info`, `port_check`, `process_list`, `service_list`, `service_status`, `eventlog_query`, `terminal_task_list`, `terminal_task_logs` | `allow` |
| **R1** | Local Mutation | `file_write`, `file_edit`, `file_copy`, `file_move`, `file_delete_safe`, `archive_zip`, `archive_unzip`, `pdf_generate`, `notification_send` | `allow` inside configured `readwrite` authority |
| **R2** | Network Outbound | `http_ping`, `http_request` | `ask` |
| **R3** | Desktop & Clipboard | `clipboard_get`, `clipboard_set`, `screen_capture`, `system_open` | `ask` |
| **R4** | System Mutation | `process_kill`, `service_control` | **deny — Balanced capability ceiling** |
| **R5** | Shell & Execution | `terminal_run`, `terminal_task_start`, `terminal_task_send`, `terminal_task_kill`, `command_run` | `ask` under default Smart; stored terminal mode is `full` |

### External `process_kill` Governance
Under schema-v2, `process_kill` inspects the target process:
- Processes spawned by WinHelm as background daemon tasks can be managed according to profile policy.
- Processes **not** started by WinHelm (external OS processes) strictly require human approval before termination, preventing agents from terminating host applications or background services autonomously.

---

## 4. Human Approval Workflow & Cross-Process Architecture

WinHelm v1.4.0 includes the distributed, file-based approval coordination architecture inside the protected `~/.winhelm` directory:

```
~/.winhelm/
  ├── approval-requests/       <-- Written exclusively by owning process
  │   └── <jobId>.json
  ├── approval-decisions/      <-- Written first-writer-wins by decider
  │   └── <jobId>.json
  ├── secrets.json             <-- Protected auth token storage
  └── admin-code-store.json    <-- Single-use admin code SHA-256 digests
```

### Separation of Planes
- **Decision Plane:** The Web Dashboard (`http://127.0.0.1:8788/admin/approvals`) or local CLI (`winhelm approve <jobId>`, `winhelm deny <jobId>`). The decision plane records human intent; it **never** invokes tool callbacks directly.
- **Execution Plane:** The **owning WinHelm process** that received the MCP call (e.g. Claude Desktop or Cursor stdio instance). Only the owning process holds the execution callback and executes the approved action.

### Approval Lifecycle

```
[Tool Invocation] ──(policy = 'ask')──> awaiting_approval
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
                approved                    denied                   expired
                    │                         │                         │
                    ▼                         ▼                         ▼
                 running               (Exec Count = 0)          (Exec Count = 0)
                    │
            ┌───────┴───────┐
            ▼               ▼
        completed        failed
```

If an owning process terminates while a job is in-flight or unconfirmed, recovery marks the job state as **`unknown`**. Ambiguous side effects are never automatically replayed.

### Invariants & Exactly-Once Guarantees
1. **Durable Journaling Before Notification:** The approval request is mirrored to disk only after durable journal persistence succeeds.
2. **First-Writer-Wins Decisions:** Decision records (`approval-decisions/<jobId>.json`) are created with exclusive file creation flags (`open wx`). Any duplicate or competing decision attempt is rejected (`ALREADY_DECIDED`).
3. **Compare-And-Swap (CAS) Execution Claim:** When applying an approval, the owning engine atomically transitions state from `approved` to `running`. This guarantees:
   $$\text{executionCount} \le 1$$
4. **Post-Expiry Invalidation:** Decisions recorded after job TTL expiration (`expired`) are rejected fail-closed.
5. **Denial Invariance:** A denied job immediately transitions to `denied`, cancels waiting callbacks with `executionCount = 0`, and cannot subsequently be approved or executed.

---

## 5. Protected Paths & Secret Isolation

### Protected Internal Paths
To prevent AI coding assistants from tampering with security configurations, auth secrets, or approval journals, WinHelm enforces **Protected Internal Paths**:
- Filesystem mutation tools (`file_write`, `file_edit`, `file_delete_safe`, `file_copy`, `file_move`, `archive_unzip`) strictly reject any path targeting or residing within:
  - `%USERPROFILE%\.winhelm`
  - WinHelm installation directory and configuration files (`winhelm.config.json`, `winhelm.local.json`)
  - Active log directories (`logs/`)
- This protection applies **even if broad wildcard access (`["*"]`) is configured in legacy mode**.

### Protected Secret Storage (`secrets.json`)
- The MCP authentication token (`authToken`) is stored in `%USERPROFILE%\.winhelm\secrets.json` with user-only filesystem ACLs.
- During migration and token rotation, raw tokens are removed from `winhelm.config.json`.
- Client configuration files generated via `winhelm connect` invoke `winhelm --stdio` and never store auth tokens in client configuration JSON.

### Shared Admin Code Store (`admin-code-store.json`)
- Admin codes for Dashboard unlocking (`winhelm admin-code`) are generated exclusively via interactive local terminal sessions.
- To allow an admin code to unlock a Dashboard served by a separate background instance (DEF-02b), only the **SHA-256 digest** and expiration timestamp are mirrored into `~/.winhelm/admin-code-store.json`.
- Codes are single-use: consuming the code deletes the stored digest. Raw code strings are never persisted to disk.

---

## 6. Authentication & Network Hardening

### Loopback-First Binding
- By default, WinHelm binds strictly to **`127.0.0.1` (localhost)**.
- **Fail-Closed Startup Gate (`validateNetworkExposure`):** If configured to bind to a non-loopback address (`0.0.0.0` or LAN interface) without an authentication token, WinHelm terminates immediately with exit code 1.

### Bearer Token Verification
- All HTTP/SSE endpoints (`/mcp`, `/sse`, `/message`, `/preview`, `/admin/*`) require `Authorization: Bearer <token>`.
- Token comparisons use cryptographically secure timing-safe equality (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.

### Host Header Validation (DNS Rebinding Defense)
- WinHelm validates incoming `Host` headers against an allowlist (`localhost`, `127.0.0.1`, `[::1]`, and configured `allowedHosts` such as `*.ts.net`).
- Unauthorized host headers are rejected with **HTTP 403 Forbidden**.
- `Host: 0.0.0.0` is explicitly blocked.

### Content Security Policy & Security Headers
- Web Dashboard routes (`/`, `/dashboard`, `/admin/*`) enforce a strict Content Security Policy (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none';`).
- File previews (`/preview`) enforce an isolated CSP (`default-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'`).
- Global HTTP responses include `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.

---

## 7. Execution Defense & Dangerous Command Interception

### Direct Argument Execution (`command_run`)
- In schema-v2, `command_run` executes commands directly via `child_process.spawn` passing arguments as a string array (`args`).
- Eliminates PowerShell command-line string interpolation and shell quote-escaping vulnerabilities.

### Dangerous Command Blocklist
PowerShell execution (`terminal_run`, `terminal_task_start`) inspects command lines against regex blocklists targeting catastrophic operations:

| Category | Blocked Patterns |
| :--- | :--- |
| **Disk & Partition Formatting** | `format\s+`, `format-volume`, `diskpart`, `clear-disk`, `initialize-disk` |
| **Recursive Root Deletion** | `rmdir\s+/[sS]`, `del\s+/[fF]/[sS]/[qQ]\s+[cC]:\\`, `remove-item\s+.*-recurse\s+.*[cC]:\\` |
| **Registry & Boot Tampering** | `reg\s+delete\s+hklm`, `bcdedit`, `bootrec` |
| **Account & Privilege Escalation** | `net\s+user\s+.*\/add`, `takeown\s+/[fF]`, `icacls\s+.*\/grant` |
| **Credential Dumping** | `mimikatz`, `procdump\s+.*lsass`, `comsvcs\.dll` |

---

## 8. Secret Redaction & Audit Logging

### Automated Redaction ([sanitizer.ts](../src/utils/sanitizer.ts))
Before logging to terminal or disk, text is stripped of credentials:
- Bearer Tokens: `Bearer ************`
- Anthropic / OpenAI API Keys: `sk-ant-************`, `sk-************`
- GitHub Tokens: `ghp_************`, `gho_************`
- AWS Keys: `AKIA************`
- JSON Credential Properties: `"authToken": "************"`, `"password": "************"`, `"x-api-key": "************"`

### Structured JSONL Audit Logger
- Security events (blocked paths, failed authentications, approval decisions, executed tools) are appended to `logs/audit.log`.
- Session identifiers are hashed using SHA-256 before writing to log entries.
- Audit logs automatically rotate at 10 MB with 5 backup files, and logs older than 7 days are automatically pruned.
