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
- **Capability policy:** R0 and recovery tools are permitted; R1–R5 state-changing/network/desktop/system/command capabilities are blocked.
- **R0 behavior:** read-only tools, including `terminal_task_list` and `terminal_task_logs`, are automatic in every Approval Mode.

### 2. `balanced` (Interactive Engineering — Recommended Default)
The default profile for daily software engineering with AI coding assistants (Claude Desktop, Cursor). It permits ordinary development capabilities while denying R4 host-control capability.
- **Folder Permission:** `readwrite`.
- **Terminal Mode:** `full` (direct command execution is available to the profile; this setting alone does not remove Approval Mode prompts).
- **Capability policy:** R0, R1, R2, R3, and R5 are permitted; **R4 (`process_kill`, `service_control`) is blocked**.
- **Default Approval Mode:** `smart` — R0 and R1 are automatic; R2 network, R3 desktop/user-data, and direct R5 command execution ask. Confirmation floors remain stronger than this default.

### 3. `power` (Broad Capability Development)
Designed for trusted end-to-end development workflows that require host-control capability in addition to the Balanced surface.
- **Folder Permission:** `readwrite`.
- **Terminal Mode:** `full`.
- **Capability policy:** R0–R5 are permitted, subject to protected boundaries and non-bypassable security floors.
- **Default Approval Mode:** `smart` — R0 and R1 are automatic; R2 network, R3 desktop/user-data, R4 host control, and direct R5 command execution ask. Switching to `trusted` may remove routine prompts for already-permitted actions, but never bypasses capability denial, Absolute Deny, explicit-confirmation, or mandatory-confirmation floors.

### Unrestricted `dangerous` mode
> ⚠️ **Notice:** An unrestricted `dangerous` profile is **not shipped** in v1.4.1. Safe / Balanced / Power are the supported product profiles.

## Approval Modes are separate from profiles

Schema-v2 v1.4.1 separates capability posture from prompting behavior:

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
| **Terminal configuration** | `off` | `full` | `full` |
| **Direct command capability (`terminal_run`, `command_run`, task start/send/kill)** | ❌ Blocked | ✅ Permitted | ✅ Permitted |
| **Task inspection (`terminal_task_list`, `terminal_task_logs`)** | ✅ R0 | ✅ R0 | ✅ R0 |
| **File Reading (`file_read`, `file_list`, etc.)** | ✅ R0 | ✅ R0 | ✅ R0 |
| **File Writing / Editing (`file_write`, `file_edit`)** | ❌ Blocked | ✅ R1 | ✅ R1 |
| **Recycle Bin Deletion (`file_delete_safe`)** | ❌ Blocked | ✅ R1 | ✅ R1 |
| **Code Search Ripgrep (`file_search_ripgrep`)** | ✅ R0 | ✅ R0 | ✅ R0 |
| **Network Requests (`http_ping`, `http_request`)** | ❌ Blocked | ✅ R2 | ✅ R2 |
| **Desktop / user-data tools (`clipboard_*`, `screen_capture`, `system_open`)** | ❌ Blocked | ✅ R3 | ✅ R3 |
| **Host control (`process_kill`, `service_control`)** | ❌ Blocked | ❌ Blocked | ✅ R4 |
| **System Info Telemetry (`system_info`, `gpu_info`)** | ✅ R0 | ✅ R0 | ✅ R0 |
| **Recovery Status (`winhelm_status`, `winhelm_job_status`)** | ✅ R0 | ✅ R0 | ✅ R0 |

The matrix above describes **capability**, not whether a prompt appears. With the default `smart` Approval Mode, R0/R1 are automatic while R2/R3/R4 and direct R5 execution ask; only rows permitted by the selected profile can reach Approval Mode evaluation. Manual asks for permitted state-changing actions. Trusted removes routine prompts for permitted actions, subject to explicit- and mandatory-confirmation floors.

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