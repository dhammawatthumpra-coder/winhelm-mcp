# WinHelm MCP — Tool Profiles & Security Presets

In WinHelm, **Profiles** serve two vital purposes:
1. **Context Window Optimization:** Reducing context bloat by loading only necessary tool schemas into AI assistant prompts.
2. **Security & Governance Presets:** In schema-v2, configuring folder permission modes, terminal execution policies, and tool risk authorization rules.

---

## Table of Contents

- [Schema-v2 Product Profiles (Safe, Balanced, Power)](#schema-v2-product-profiles)
  - [`safe` — Read-Only Exploration & Audits](#1-safe-read-only-exploration)
  - [`balanced` — Interactive Engineering (Recommended)](#2-balanced-interactive-engineering-recommended)
  - [`power` — Autonomous Full-Stack Development](#3-power-autonomous-full-stack-development)
  - [Deferred Modes: `dangerous`](#deferred-modes-dangerous)
- [Legacy Compatibility Presets (`minimal`, `core`, `dev`, `sysadmin`, `full`)](#legacy-compatibility-presets)
- [Profile Comparison Matrix](#profile-comparison-matrix)
- [Token Math & Context Economics](#token-math--context-economics)
- [How to Set Profiles](#how-to-set-profiles)

---

## Schema-v2 Product Profiles

When using schema-v2 (`schemaVersion: 2` in configuration or via `winhelm setup`), WinHelm provides three core product profiles:

### 1. `safe` (Read-Only Exploration)
Designed for code auditing, documentation search, read-only telemetry, and small language models.
- **Folder Permission:** `read` (strictly read-only across all configured folders).
- **Terminal Mode:** `off` (terminal execution is disabled).
- **Tool Policies:**
  - **R0 (Read-only tools):** `auto` (except background task listing/logs which are `off`).
  - **R1 (Mutating tools):** `off`.
  - **R2 (Network tools):** `off`.
  - **R3 (Desktop/Clipboard tools):** `off`.
  - **R4 (System mutation tools):** `off`.
  - **R5 (Shell tools):** `off`.
  - **Recovery tools:** `auto` (`winhelm_status`, `winhelm_job_status`).

### 2. `balanced` (Interactive Engineering — Recommended Default)
The default profile for daily software engineering with AI coding assistants (Claude Desktop, Cursor). Strikes a pragmatic balance between autonomous execution and human oversight.
- **Folder Permission:** `readwrite` (file modifications permitted within configured folders).
- **Terminal Mode:** `ask` (every shell command or script execution prompts for human approval).
- **Tool Policies:**
  - **R0 (Read-only) & R1 (Local file edits/creates):** `auto` within allowed folders.
  - **R2 (Network requests):** `ask` (human approval required).
  - **R3 (Clipboard & screen capture):** `ask` (human approval required).
  - **R4 (Process kill & service control):** `ask` (human approval required).
  - **R5 (Shell / commands):** Gated by terminal mode (`ask`).
  - **Recovery tools:** `auto`.

### 3. `power` (Autonomous Full-Stack Development)
Designed for trusted automation scripts and end-to-end development workflows where continuous prompts would disrupt long-running tasks.
- **Folder Permission:** `readwrite`.
- **Terminal Mode:** `full` (PowerShell and command execution run autonomously).
- **Tool Policies:**
  - **R0, R1, and R2 (Network):** `auto`.
  - **R3 (Desktop) & R4 (Process/Service mutation):** `ask` (retains approval gating for high-impact host operations).
  - **R5 (Shell / commands):** `auto`.
  - **Recovery tools:** `auto`.

### Unrestricted `dangerous` mode
> ⚠️ **Notice:** An unrestricted `dangerous` profile is **not shipped** in v1.4.0. Safe / Balanced / Power are the supported product profiles.

## Approval Modes are separate from profiles

Schema-v2 v1.4.0 separates capability posture from prompting behavior:

- **Manual** — R0 read-only/recovery work can run automatically; permitted state-changing work normally asks.
- **Smart** — the default for product profiles; bounded low-risk work can proceed automatically while higher-risk work asks.
- **Trusted** — routine permitted work can proceed automatically, but it still cannot bypass capability denial, absolute deny, explicit-confirmation, or mandatory-confirmation floors.

A profile answers **what is allowed**. Approval Mode answers **whether an already-permitted action asks**. Approval Mode never expands capability.

---

## Legacy Compatibility Presets

To maintain complete backward compatibility with v1.2.1 workflows, WinHelm also supports legacy preset names:

| Preset | Target Use Case | Legacy Tool Count |
| :--- | :--- | :---: |
| **`minimal`** | Small models (Haiku, Llama 8B, local LLMs) with ~85% token reduction | 6 |
| **`core`** | Daily coding and file operations without background daemons | 15 |
| **`dev`** | Software engineering with background tasks, ripgrep, archives, and PDF generator | 28 |
| **`sysadmin`** | IT operations, Windows services, event logs, and system diagnostics | 37 |
| **`full`** | All legacy system tools | 38 |

In schema-v2, passing a legacy preset name configures tool authorization policies matching the canonical tool membership of that preset.

---

## Profile Comparison Matrix

| Capability / Category | `safe` | `balanced` | `power` |
| :--- | :---: | :---: | :---: |
| **Folder Permission** | `read` | `readwrite` | `readwrite` |
| **Terminal Runner (`terminal_run`)** | ❌ Blocked | 🛡️ Approval | ✅ Auto |
| **No-Shell Runner (`command_run`)** | ❌ Blocked | 🛡️ Approval | ✅ Auto |
| **Background Tasks (`terminal_task_*`)** | ❌ Blocked | 🛡️ Approval | ✅ Auto |
| **File Reading (`file_read`, `file_list`, etc.)** | ✅ Auto | ✅ Auto | ✅ Auto |
| **File Writing / Editing (`file_write`, `file_edit`)** | ❌ Blocked | ✅ Auto | ✅ Auto |
| **Recycle Bin Deletion (`file_delete_safe`)** | ❌ Blocked | ✅ Auto | ✅ Auto |
| **Code Search Ripgrep (`file_search_ripgrep`)** | ✅ Auto | ✅ Auto | ✅ Auto |
| **Network Requests (`http_ping`, `http_request`)** | ❌ Blocked | 🛡️ Approval | ✅ Auto |
| **Desktop Automation (`clipboard_*`, `screen_capture`)** | ❌ Blocked | 🛡️ Approval | 🛡️ Approval |
| **Process Termination (`process_kill`)** | ❌ Blocked | 🛡️ Approval | 🛡️ Approval |
| **System Info Telemetry (`system_info`, `gpu_info`)** | ✅ Auto | ✅ Auto | ✅ Auto |
| **Recovery Status (`winhelm_status`, `winhelm_job_status`)** | ✅ Auto | ✅ Auto | ✅ Auto |

---

## Token Math & Context Economics

Every tool schema takes prompt tokens when serialized. WinHelm allows optimizing prompt overhead:

| Profile | Active Tools | Approx Context Tokens | Token Reduction | Recommended LLMs |
| :--- | :---: | :---: | :---: | :--- |
| **`minimal`** | 6 | ~1,500 | 🟢 **−85%** | Claude Haiku, Llama 8B, local models |
| **`core`** | 15 | ~4,000 | 🟢 **−60%** | Everyday coding without daemons |
| **`dev` / `balanced`** | profile-dependent | profile-dependent | — | Daily engineering |
| **`full` / `power`** | up to 56 | release-surface dependent | 🔵 Full v1.4 surface | Trusted automation |

---

## How to Set Profiles

### CLI Setup Wizard
```powershell
# Set balanced profile with workspace folder
winhelm setup --preset balanced --folder "D:\Workspace" --yes

# Set safe profile for read-only exploration
winhelm setup --preset safe --folder "C:\Projects" --yes
```

### Server Execution Flag
```powershell
# Run server with specific profile
winhelm --profile balanced

# Or pass in claude_desktop_config.json:
# "args": ["D:\\mcp\\winhelm-mcp\\dist\\index.js", "--stdio", "--profile", "balanced"]
```