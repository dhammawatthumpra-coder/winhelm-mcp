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

If you bind WinHelm to an external interface (`--host 0.0.0.0`) without an authentication token, a prominent startup warning is emitted to alert you of open exposure. In any shared, multi-user, LAN, or remote setup, you should enforce Bearer Token authentication:

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
- For convenient browser access to the Web Monitor Dashboard and Previewer, the token can also be supplied via URL query parameter (`?token=<token>` or `?auth=<token>`) or browser cookie.
- Unauthenticated access is strictly confined to public health checks (`/health`) and the basic dashboard HTML shell (`/`, `/dashboard`).

---

## 3. Read-Only Enforcement Mode

If you wish to allow an AI agent to read code, query event logs, and inspect system telemetry without modifying anything, start WinHelm in **Read-Only Mode**:

```powershell
winhelm --read-only
```

When active, any call to mutating tools (e.g. `file_write`, `file_edit`, `file_delete_safe`, `terminal_run`, `process_kill`, `service_control`) is rejected before reaching the execution engine.

---

## 4. Path Confinement (`allowedDirectories`)

You can restrict filesystem operations (`file_read`, `file_write`, `file_list`, `file_search_ripgrep`, `terminal_run` working directories) to specific paths or drives in `winhelm.config.json`:

```json
{
  "allowedDirectories": [
    "D:\\mcp",
    "C:\\Projects"
  ],
  "allowSystemExecution": true
}
```

- Any attempt to access paths outside the whitelist is rejected with a security error.
- Path traversal tricks (`..\..\Windows\System32`) are normalized and blocked.
- You can whitelist an entire volume by specifying `"D:\\"`, `"D:"`, or `"D"`.

---

## 5. Dangerous Command Blacklist

WinHelm inspects command lines executed via `terminal_run` or `terminal_task_start` against regex patterns targeting destructive or risky actions:

| Category | Blocked Patterns |
| :--- | :--- |
| **Disk & Partition Formatting** | `format\s+`, `format-volume`, `diskpart`, `clear-disk`, `initialize-disk` |
| **Recursive Root Deletion** | `rmdir\s+/[sS]`, `del\s+/[fF]/[sS]/[qQ]\s+[cC]:\\`, `remove-item\s+.*-recurse\s+.*[cC]:\\` |
| **Registry & Boot Tampering** | `reg\s+delete\s+hklm`, `bcdedit`, `bootrec` |
| **Account & Privilege Escalation** | `net\s+user\s+.*\/add`, `takeown\s+/[fF]`, `icacls\s+.*\/grant` |
| **Credential Dumping** | `mimikatz`, `procdump\s+.*lsass`, `comsvcs\.dll` |

---

## 6. Secret Redaction & Log Sanitization

Before log entries are displayed on the Web Monitor Dashboard or written to disk, all text is piped through [sanitizer.ts](../src/utils/sanitizer.ts):

- **Bearer Tokens**: `Bearer [REDACTED]`
- **OpenAI & Claude API Keys**: `sk-ant-[REDACTED]`, `sk-[REDACTED]`
- **GitHub Tokens**: `ghp_[REDACTED]`, `gho_[REDACTED]`
- **AWS Secrets**: `AKIA[REDACTED]`
- **Password Objects**: `{ "password": "******" }`

---

## 7. Audit Logging & Export

All executed commands, exit codes, durations, and tool errors are sequentially logged to daily audit logs in `logs/winhelm-YYYY-MM-DD.log`.

You can export audit logs at any time via the Web Monitor Dashboard buttons ("📥 Export JSON" / "📥 Export CSV") or programmatically via the HTTP endpoint:
```
GET /api/monitor/export?format=json
GET /api/monitor/export?format=csv
```

Logs older than 7 days are automatically pruned to prevent disk consumption.
