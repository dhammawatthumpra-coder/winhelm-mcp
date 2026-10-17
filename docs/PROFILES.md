# WinHelm MCP — Tool Profiles & Security Presets

In WinHelm, **Profiles** serve two vital purposes:
1. **Context Window Optimization:** Reducing context bloat by loading only necessary tool schemas into AI assistant prompts.
2. **Security & Governance Presets:** In schema-v2, configuring folder permission modes, terminal execution policies, and tool risk authorization rules.

---

## Table of Contents

- [Schema-v2 Product Profiles (Safe, Balanced, Power)](#schema-v2-product-profiles)
  - [`safe` — Read-Only Exploration & Audits](#1-safe-read-only-exploration)
  - [`balanced` — Interactive Engineering (Recommended)](#2-balanced-interactive-engineering-recommended)
  - [`power` — Broader Capability for Trusted Automation](#3-power-broader-capability-for-trusted-automation)
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
- **Stored Terminal Mode:** `off` (terminal execution is disabled).
- **Capability / preset policy:**
  - **R0 (Read-only tools):** permitted with policy `auto`, including `terminal_task_list` and `terminal_task_logs`.
  - **R1/R2/R3/R4/R5:** unavailable under the Safe capability ceiling.
  - Background-task mutation tools (`terminal_task_start`, `terminal_task_send`, `terminal_task_kill`) are R5 and remain unavailable.
  - **Recovery tools:** permitted with policy `auto` (`winhelm_status`, `winhelm_job_status`).

### 2. `balanced` (Interactive Engineering — Recommended Default)
The default profile for daily software engineering with AI coding assistants (Claude Desktop, Cursor). Product presets default to **Smart Approval Mode**.
- **Folder Permission:** `readwrite`.
- **Stored Terminal Mode:** `full`. This is a capability-layer setting; with the default **Smart** Approval Mode, R5 terminal/command execution still requires approval.
- **Capability / preset policy:**
  - **R0/R1:** permitted; under default Smart they run automatically within configured authority.
  - **R2 (Network) and R3 (Desktop/Clipboard):** capability-permitted, but default Smart requires approval.
  - **R4 (Process kill & service control):** **denied by the Balanced product-profile capability ceiling**. Approval Mode cannot make R4 available.
  - **R5 (Shell / commands):** capability-permitted through terminal mode `full`, but default Smart requires approval.
  - **Recovery tools:** permitted automatically.

### 3. `power` (Broader Capability for Trusted Automation)
Designed for trusted automation workflows that need broader capability than Balanced. Product presets still default to **Smart Approval Mode**; selecting Power does not by itself mean prompt-free execution.
- **Folder Permission:** `readwrite`.
- **Stored Terminal Mode:** `full`.
- **Capability / preset policy:** R0/R1/R2/R3/R4/R5 are capability-permitted according to their normal security floors.
- **Effective behavior with default Smart:** R0/R1 run automatically; representative R2/R3/R4/R5 actions require approval.
- **Trusted Approval Mode:** can remove routine prompts for permitted R2/R3/R5 actions, but cannot bypass absolute deny, explicit-confirmation, or mandatory-confirmation floors. R4 operations such as service mutation remain approval-gated where mandatory confirmation applies.
- **Recovery tools:** permitted automatically.

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

The decisions below show the **default effective behavior** after applying each product preset. Product presets default to **Smart Approval Mode**. “Denied” means the product-profile capability ceiling blocks the action; changing Approval Mode cannot override it.

| Capability / Category | `safe` + Smart | `balanced` + Smart | `power` + Smart |
| :--- | :---: | :---: | :---: |
| **Folder Permission** | `read` | `readwrite` | `readwrite` |
| **Stored Terminal Mode** | `off` | `full` | `full` |
| **Terminal Runner (`terminal_run`)** | ❌ Denied | 🛡️ Approval | 🛡️ Approval |
| **No-Shell Runner (`command_run`)** | ❌ Denied | 🛡️ Approval | 🛡️ Approval |
| **Background Task List/Logs** | ✅ Auto | ✅ Auto | ✅ Auto |
| **Background Task Start/Send/Kill** | ❌ Denied | 🛡️ Approval | 🛡️ Approval |
| **File Reading (`file_read`, `file_list`, etc.)** | ✅ Auto | ✅ Auto | ✅ Auto |
| **File Writing / Editing (`file_write`, `file_edit`)** | ❌ Denied | ✅ Auto | ✅ Auto |
| **Recycle Bin Deletion (`file_delete_safe`)** | ❌ Denied | ✅ Auto | ✅ Auto |
| **Code Search Ripgrep (`file_search_ripgrep`)** | ✅ Auto | ✅ Auto | ✅ Auto |
| **Network Requests (`http_ping`, `http_request`)** | ❌ Denied | 🛡️ Approval | 🛡️ Approval |
| **Desktop Automation (`clipboard_*`, `screen_capture`)** | ❌ Denied | 🛡️ Approval | 🛡️ Approval |
| **Process / Service Mutation (R4)** | ❌ Denied | ❌ **Capability denied** | 🛡️ Approval |
| **System Info Telemetry (`system_info`, `gpu_info`)** | ✅ Auto | ✅ Auto | ✅ Auto |
| **Recovery Status (`winhelm_status`, `winhelm_job_status`)** | ✅ Auto | ✅ Auto | ✅ Auto |

With **Trusted** Approval Mode, permitted Power R2/R3/R5 actions can normally run without routine prompts, while mandatory-confirmation operations remain gated. Balanced R4 remains denied in every Approval Mode.

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

### Legacy Exposure Flag

`--profile` is a legacy tool-exposure flag. It is not the Schema-v2 product-profile configuration mechanism. For Schema-v2 use `winhelm setup --preset <safe|balanced|power>`.

Legacy example:
```powershell
winhelm --profile dev

# Or in a legacy client entry:
# "args": ["<WINHELM_INSTALL_ROOT>\\dist\\index.js", "--stdio", "--profile", "dev"]
```