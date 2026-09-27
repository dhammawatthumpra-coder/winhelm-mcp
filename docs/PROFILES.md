# WinHelm MCP — Tool Profiles & Context Optimization

Modern AI coding assistants consume **thousands of tokens before the first message** just to load tool schemas. Every tool definition (name, description, parameter types, enums, defaults) is sent on every request — even when the tool is never called.

WinHelm solves this with **Dynamic Profile Loading**: you decide which subset of the 38 tools your agent actually sees.

---

## Table of Contents

- [Why Profiles Matter](#why-profiles-matter)
- [The Token Math](#the-token-math)
- [Built-in Profiles](#built-in-profiles)
  - [`minimal` — 6 tools](#minimal--6-tools-small-models--token-constrained-workflows)
  - [`core` — 15 tools](#core--15-tools-general-purpose-baseline)
  - [`dev` — 28 tools](#dev--28-tools-software-development)
  - [`sysadmin` — 37 tools](#sysadmin--37-tools-system-administration)
  - [`full` — 38 tools](#full--38-tools-everything)
- [Comparison Matrix](#comparison-matrix)
- [Custom Profiles (`--tools`)](#custom-profiles---tools)
- [Use Case Recipes](#use-case-recipes)
- [FAQ](#faq)

---

## Why Profiles Matter

Every MCP tool schema averages **200–300 tokens** when serialized. Loading all 38 tools means:

- **~10,000 tokens** consumed before the conversation even starts
- **Slower tool selection** — the model scans 38 candidates to pick the right one
- **Higher hallucination rate** — overlapping tool names increase wrong-tool calls
- **Higher cost** — every turn re-sends the full tool list

For small models (Claude Haiku, Llama 3 8B, Phi-3), the entire context window is only 8k–32k tokens. Loading 38 tools can consume **50–100% of the window** before any user message.

**Loading only what you need is the single highest-leverage optimization.**

---

## The Token Math

Estimated based on schema serialization + description length:

| Profile | Tools | Approx. Tokens | Context Saved | Best For |
| :--- | :---: | :---: | :---: | :--- |
| `full` | 38 | ~10,000 | baseline | Power users, visual previews & complete suite |
| `sysadmin` | 37 | ~9,200 | **−8%** | IT ops, server diagnostics, Windows services |
| `dev` | 28 | ~6,800 | **−32%** | Coding agents (default for software engineering) |
| `core` | 15 | ~4,000 | **−60%** | Everyday coding & file operations |
| `minimal` | 6 | ~1,500 | **−85%** | Claude Haiku, Llama 8B, local models |

> **Real-world impact:** Running Claude Haiku 3.5 (200k context) with `full` wastes ~5% of the window on tools. Running Llama 3.1 8B (8k context) with `full` is **impossible** — the tool list alone overflows the context.

---

## Built-in Profiles

### `minimal` — 6 tools (Small Models / Token-Constrained Workflows)

```powershell
winhelm --profile minimal
```

**Tools included:**

| Tool | Purpose |
| :--- | :--- |
| `terminal_run` | Run PowerShell commands |
| `file_read` | Read file contents |
| `file_write` | Create / overwrite files |
| `file_list` | List directories |
| `file_search` | Substring search across files |
| `system_info` | CPU / RAM / OS / drives telemetry |

**Use when:**
- Running Claude Haiku, Llama 3 8B, Phi-3, or any model with ≤ 32k context
- You need a fast, focused agent that only reads/writes code
- You want to minimize cost per request

**Trade-offs:**
- No file editing (use `file_write` instead)
- No background tasks
- No process/service management

---

### `core` — 15 tools (General-Purpose Baseline)

```powershell
winhelm --profile core
```

**Tools included:**

| Category | Tools |
| :--- | :--- |
| Terminal | `terminal_run` |
| Filesystem | `file_read`, `file_write`, `file_edit`, `file_list`, `file_search`, `file_copy`, `file_move`, `file_delete_safe`, `file_tail`, `file_hash` |
| System | `system_info`, `gpu_info`, `process_list`, `port_check` |

**Use when:**
- General-purpose assistant that edits code but doesn't build/run long tasks
- You want safe file operations (Recycle Bin delete) without archive/PDF bloat
- Balanced default for most users

**Trade-offs:**
- No background daemons (can't run `npm run dev` async)
- No ripgrep (slower search on large codebases)
- No PDF / preview / clipboard / notification

---

### `dev` — 28 tools (Software Development)

```powershell
winhelm --profile dev
```

**Tools included:** All `core` (15 tools) + the following 13 tools:

| Category | Added Tools |
| :--- | :--- |
| Terminal | `terminal_task_start`, `terminal_task_list`, `terminal_task_logs`, `terminal_task_send`, `terminal_task_kill` |
| Filesystem | `archive_zip`, `archive_unzip` |
| Codebase & Docs | `file_search_ripgrep`, `pdf_generate`, `file_preview` |
| Network | `http_ping`, `http_request` |
| Desktop | `system_open` |

**Use when:**
- Autonomous coding agents (Claude 3.7 Sonnet, Cursor, Cline, Windsurf, ChatGPT)
- Running dev servers, test watchers, or builds in the background
- Searching large codebases with streaming ripgrep
- Testing REST API endpoints (`http_request`) and health checks (`http_ping`)
- Zipping build artifacts and exporting Markdown documentation to styled PDFs
- Opening generated files or URLs in default applications (`system_open`)

**Trade-offs:**
- No process kill (guards against accidental termination of system processes)
- No Windows service control
- No Windows event log inspection
- No desktop surveillance (clipboard and screen capture omitted)

> **This is the recommended default for software engineering agents.**

---

### `sysadmin` — 37 tools (System Administration & Ops)

```powershell
winhelm --profile sysadmin
```

**Tools included:** All tools in WinHelm **except `pdf_generate`** (All `core` + 22 advanced tools):

| Category | Added Tools |
| :--- | :--- |
| Terminal | `terminal_task_start`, `terminal_task_list`, `terminal_task_logs`, `terminal_task_send`, `terminal_task_kill` |
| Filesystem | `archive_zip`, `archive_unzip` |
| Codebase & Preview | `file_search_ripgrep`, `file_preview` |
| System | `process_kill`, `eventlog_query` |
| Services | `service_list`, `service_status`, `service_control` |
| Network | `network_info`, `http_ping`, `http_request` |
| Desktop | `clipboard_get`, `clipboard_set`, `screen_capture`, `system_open`, `notification_send` |

**Use when:**
- IT operations, Windows DevOps, and server management
- Troubleshooting crashes via Windows Event Log and killing runaway PIDs
- Starting, stopping, and inspecting Windows Services
- Searching massive server logs with ripgrep and archiving bundles to `.zip`
- Inspecting network adapters, DNS, open ports, and Tailscale IPs
- Desktop automation with native Toast notifications and screenshot capture

**Trade-offs:**
- No headless Chromium PDF generation (`pdf_generate` omitted to preserve a clean, lightweight footprint in headless/server environments without Edge or Chrome)

---

### `full` — 38 tools (Everything)

```powershell
winhelm --profile full
```

**Default when `--profile` is omitted.**

Includes **all 38 tools** plus the `preview://file` MCP Resource.

**Use when:**
- You're building a power-user agent
- You need every capability in one session
- You don't care about token cost

**Trade-offs:**
- Highest token cost
- Slower tool selection
- Overkill for 90% of tasks

---

## Comparison Matrix

| Tool | `minimal` (6) | `core` (15) | `dev` (28) | `sysadmin` (37) | `full` (38) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `terminal_run` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `terminal_task_start` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `terminal_task_list` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `terminal_task_logs` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `terminal_task_send` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `terminal_task_kill` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `file_read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `file_write` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `file_edit` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `file_list` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `file_search` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `file_delete_safe` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `file_move` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `file_copy` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `archive_zip` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `archive_unzip` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `file_tail` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `file_hash` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `file_search_ripgrep` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `pdf_generate` | ❌ | ❌ | ✅ | ❌ | ✅ |
| `file_preview` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `clipboard_get` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `clipboard_set` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `screen_capture` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `system_open` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `notification_send` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `system_info` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gpu_info` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `process_list` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `process_kill` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `port_check` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `eventlog_query` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `service_list` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `service_status` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `service_control` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `http_ping` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `http_request` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `network_info` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `preview://file` *(resource)* | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Total** | **6** | **15** | **28** | **37** | **38** |

---

## Custom Profiles (`--tools`)

For advanced users who need a specific subset, WinHelm supports explicit tool selection:

### Whitelist Mode

Load only the tools you list:

```powershell
winhelm --profile custom --tools "terminal_run,file_read,file_write,file_list"
```

### Extend a Preset

Start from a preset and add specific tools:

```powershell
winhelm --profile dev --tools "+pdf_generate,process_kill"
```

### Exclude from a Preset

Start from a preset and remove specific tools:

```powershell
winhelm --profile full --tools "-screen_capture,-clipboard_set"
```

### Via Config File

```json
{
  "profile": "custom",
  "customTools": [
    "terminal_run",
    "file_read",
    "file_write",
    "file_list",
    "system_info"
  ]
}
```

**Validation:**
- Unknown tool names → startup error with suggestion
- Conflicting `+` and `-` in the same list → error
- Empty result → warning + fallback to `core`

---

## Use Case Recipes

### Recipe 1: Claude Haiku on a Budget

```powershell
winhelm --profile minimal --port 8788
```

Result: **~1,500 tokens** for tools → leaves 198k+ for the conversation.

---

### Recipe 2: Cursor AI Coding Agent

```powershell
winhelm --profile dev --port 8788
```

Result: **~6,800 tokens** for tools → covers 98% of software development tasks with background tasks, ripgrep, and archives.

---

### Recipe 3: Remote Windows Server Monitoring

```powershell
winhelm --profile sysadmin --auth <strong-token> --host 0.0.0.0
```

Result: **~9,200 tokens** → full ops capability without headless Chromium PDF bloat.

---

### Recipe 4: Read-Only Audit Agent

```powershell
winhelm --profile custom --read-only --tools "file_read,file_list,file_search,file_tail,file_hash,system_info,eventlog_query"
```

Result: **~2,000 tokens** → no mutation possible, perfect for auditors.

---

### Recipe 5: PDF Report Generator

```powershell
winhelm --profile custom --tools "file_read,file_write,pdf_generate,file_list,system_info"
```

Result: **~1,300 tokens** → minimum viable report workflow.

---

## FAQ

**Q: What's the default profile?**  
A: `full` when `--profile` is omitted. For most users, `dev` is a better default — see recommendations below.

**Q: Can I switch profiles at runtime?**  
A: No. Profiles are resolved at startup. Restart the server to change.

**Q: Does the profile affect the Web Dashboard?**  
A: No. The dashboard always shows all metrics regardless of profile.

**Q: Which profile should I start with?**  
A: 
- **Coding agents** → `dev`
- **General assistants** → `core`
- **Small models** → `minimal`
- **Ops / IT** → `sysadmin`
- **Undecided** → `dev`

**Q: How do you calculate token counts?**  
A: We serialize each tool's JSON schema (name + description + parameters + enums) and count tokens with `tiktoken` (cl100k_base). Actual counts vary ±10% across models.

**Q: Why not just use `full` always?**  
A: Because every token sent costs money, adds latency, and increases the chance of wrong-tool selection. The difference between `full` and `dev` is ~3,500 tokens **per request**.

**Q: Will you add more profiles?**  
A: Unlikely. Five profiles cover 99% of use cases. For anything else, use `--tools`.

**Q: Can I define my own named profile?**  
A: Yes, via `winhelm.config.json`:

```json
{
  "profiles": {
    "mytools": ["terminal_run", "file_read", "system_info"]
  }
}
```

Then: `winhelm --profile mytools`

---

## See Also

- [Tools Reference](./TOOLS.md) — full parameter documentation for every tool
- [Security Model](./SECURITY.md) — read-only mode, path confinement, blacklist
- [Real-World Examples](./EXAMPLES.md) — end-to-end agent workflows