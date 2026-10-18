# WinHelm v1.4.1 Dashboard UI Refresh — Phase 1: Visual Design System & Wireframes

Date: 2026-10-18 (+07)  
Revision: R1  
Lane: `WINHELM_V1_4_1_DASHBOARD_UI_REFRESH` (Tranche C)  
Umbrella Release: WinHelm v1.4.1 — Operational UX + Self-Configuration  
Workspace: `D:\mcp\winhelm-v1.4.1-dashboard-ui-refresh-r1`  
Branch: `feat/v1.4.1-dashboard-ui-refresh`  

---

## 1. Visual Design System Principles

The visual language of the refreshed WinHelm v1.4.1 dashboard embodies:
- **Calm Authority**: Muted, high-contrast, professional palette inspired by native modern Windows desktop systems.
- **Zero Decorative Fluff**: Avoids cyberpunk/hacker glowing borders, arbitrary animated gradients, and giant technical gauges.
- **Strong Status Hierarchy**: State is never communicated by color alone. Every badge, indicator, or pill pairs clear semantic icons and descriptive text labels with accessible contrast.
- **Progressive Disclosure**: Routine operations are presented in clean, scannable cards. Deep JSON payloads, process IDs, and raw socket endpoints are tucked neatly into expandable diagnostic drawers.

---

## 2. Design Tokens

### 2.1 Spacing Scale
Based on an 8-point harmonic grid:
```css
--space-1: 4px;   /* micro padding, badge internal */
--space-2: 8px;   /* tight spacing, between icon and label */
--space-3: 12px;  /* standard button vertical padding, form gap */
--space-4: 16px;  /* standard card internal padding, layout gap */
--space-5: 20px;  /* card section separation */
--space-6: 24px;  /* panel header padding, major grid gap */
--space-8: 32px;  /* section container separation */
--space-10: 40px; /* viewport outer margin */
```

### 2.2 Typography Scale
Uses modern system font stack optimized for Windows, macOS, and Linux:
`font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;`
`font-mono: ui-monospace, SFMono-Regular, "Segoe UI Mono", Menlo, Consolas, monospace;`

| Token | Size | Line Height | Weight | Usage |
|---|---|---|---|---|
| `--text-xs` | 11px (0.6875rem) | 16px | 500 | Metadata, timestamps, status pills |
| `--text-sm` | 13px (0.8125rem) | 18px | 400 / 500 | Body secondary, field labels, table cells |
| `--text-base` | 14px (0.875rem) | 20px | 400 / 500 | Body primary, input text, buttons |
| `--text-md` | 16px (1.000rem) | 24px | 600 | Card titles, section subheadings |
| `--text-lg` | 18px (1.125rem) | 26px | 600 | View titles, modal headings |
| `--text-xl` | 22px (1.375rem) | 28px | 700 | Primary page title, metric callouts |

### 2.3 Borders & Elevation
```css
--radius-sm: 4px;   /* buttons, tags, pills */
--radius-md: 8px;   /* cards, input fields, dropdowns */
--radius-lg: 12px;  /* modals, major panels, focus callouts */
--radius-full: 9999px; /* status dots, circular avatars */

/* Dark Mode Shadows */
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
--shadow-md: 0 4px 12px rgba(0, 0, 0, 0.5);
--shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.65);

/* Light Mode Shadows */
--shadow-sm-light: 0 1px 2px rgba(0, 0, 0, 0.05);
--shadow-md-light: 0 4px 12px rgba(0, 0, 0, 0.08);
--shadow-lg-light: 0 12px 32px rgba(0, 0, 0, 0.12);
```

### 2.4 Color & Status Tokens (Dark & Light)

```css
/* ==========================================================================
   DARK THEME (Default)
   ========================================================================== */
[data-theme="dark"] {
  --bg-canvas: #0f141c;       /* deepest background */
  --bg-surface: #161d2a;      /* card background */
  --bg-surface-elevated: #1e2638; /* popovers, modals, active items */
  --bg-subtle: #232d42;       /* hover states, subtle dividers */

  --border-subtle: #28334a;   /* borders between elements */
  --border-strong: #3b4968;   /* focused inputs, prominent borders */

  --text-primary: #f0f4fc;    /* high-emphasis text */
  --text-secondary: #9db0ce;  /* medium-emphasis text, labels */
  --text-muted: #6b7d9b;      /* timestamps, helper text, disabled */

  /* Semantic Status Tokens */
  --status-ready-bg: rgba(34, 197, 94, 0.12);
  --status-ready-text: #4ade80;
  --status-ready-border: rgba(34, 197, 94, 0.35);

  --status-attention-bg: rgba(234, 179, 8, 0.12);
  --status-attention-text: #facc15;
  --status-attention-border: rgba(234, 179, 8, 0.35);

  --status-offline-bg: rgba(239, 68, 68, 0.12);
  --status-offline-text: #f87171;
  --status-offline-border: rgba(239, 68, 68, 0.35);

  --status-info-bg: rgba(59, 130, 246, 0.12);
  --status-info-text: #60a5fa;
  --status-info-border: rgba(59, 130, 246, 0.35);

  --status-neutral-bg: rgba(148, 163, 184, 0.12);
  --status-neutral-text: #cbd5e1;
  --status-neutral-border: rgba(148, 163, 184, 0.3);

  /* Primary Interactive */
  --accent-primary: #3b82f6;
  --accent-primary-hover: #2563eb;
  --accent-primary-text: #ffffff;
}

/* ==========================================================================
   LIGHT THEME
   ========================================================================== */
[data-theme="light"] {
  --bg-canvas: #f4f6fa;       /* clean, warm grey-blue canvas */
  --bg-surface: #ffffff;      /* pure white cards */
  --bg-surface-elevated: #ffffff;
  --bg-subtle: #f1f4f9;

  --border-subtle: #e2e8f0;
  --border-strong: #cbd5e1;

  --text-primary: #0f172a;    /* slate 900 */
  --text-secondary: #475569;  /* slate 600 */
  --text-muted: #94a3b8;      /* slate 400 */

  /* Semantic Status Tokens */
  --status-ready-bg: #ecfdf5;
  --status-ready-text: #15803d;
  --status-ready-border: #86efac;

  --status-attention-bg: #fefce8;
  --status-attention-text: #a16207;
  --status-attention-border: #fde047;

  --status-offline-bg: #fef2f2;
  --status-offline-text: #b91c1c;
  --status-offline-border: #fca5a5;

  --status-info-bg: #eff6ff;
  --status-info-text: #1d4ed8;
  --status-info-border: #93c5fd;

  --status-neutral-bg: #f8fafc;
  --status-neutral-text: #475569;
  --status-neutral-border: #cbd5e1;

  --accent-primary: #2563eb;
  --accent-primary-hover: #1d4ed8;
  --accent-primary-text: #ffffff;
}
```

---

## 3. Strict Status Vocabulary & Copy Guidelines

To prevent user confusion and conflicting states, the following standardized vocabulary is enforced across all screens:

| Concept | Approved Term | Disallowed Ambiguous Terms | Semantics & Meaning |
|---|---|---|---|
| **System State** | `Ready` | *Healthy, Active, Up, Okay* | WinHelm core is running and loopback gateway is functional. |
| | `Needs Attention` | *Degraded, Warning, Issue* | Running, but pending approvals or security warnings require human action. |
| | `Offline` | *Dead, Stopped, Down* | Host daemon is unreachable or stopped. |
| **Clients** | `Connected` | *Live, Bound, Attached* | Client actively engaged in a live session. |
| | `Configured` | *Installed, Setup* | Config file detected and valid, but client not currently running. |
| | `Not Configured` | *Missing, Absent* | No client config file found. |
| **Remote Access** | `Remote Access: OFF` | *Local Only, Disconnected* | Maximum isolation. Local loopback only. Zero public exposure. |
| | `Remote Access: ON` | *Connected, Public* | Active ingress tunnel verified. Endpoint is reachable externally. |
| | `Remote Access: Needs Attention`| *Broken, Error* | Tunnel enabled in config but connection failed or credentials expired. |
| **Approvals** | `Pending` | *Waiting, Queued* | Waiting for human Approve/Deny decision. |
| | `Approved` | *Accepted, Allowed* | User authorized execution. |
| | `Denied` | *Blocked, Rejected* | User rejected execution. |
| | `Expired` | *Timed out* | Approval window passed without human input. |
| **Internal Ports** | `Automatic` | *Dynamic, Random* | Tranche A managed dynamic loopback port assignment. |
| | `Fixed` | *Static, Legacy* | User-pinned explicit port number. |
| **Admin Privilege**| `Locked` | *Secured, Restricted* | Elevated operations require local admin-code entry. |
| | `Unlocked` | *Elevated, Root* | Valid admin session active (temporary). |

---

## 4. Screen Wireframes & Detailed Layouts

### 4.1 Home (At-a-Glance Operational Overview)
```
+----------------------------------------------------------------------------------------------------+
| [Logo] WinHelm v1.4.1       [● Ready]       [🔒 Admin Locked]   [☼ Theme]   [🌐 EN/TH]   [↻ Refresh]|
+-------------------+--------------------------------------------------------------------------------+
| NAV               | HOME                                                                           |
| > Home            |                                                                                |
|   Approvals (1)   | +----------------------------------------------------------------------------+ |
|   Connections     | | ⚠ ATTENTION REQUIRED: 1 Pending Tool Approval                              | |
|   Access & Sec    | | Claude Desktop requested `execute_command` (Risk: High)  [Review in Inbox] | |
|   Activity        | +----------------------------------------------------------------------------+ |
|   Settings        |                                                                                |
|   Advanced        | 4 CORE OPERATIONAL TILES:                                                      |
|   Setup / Repair  | +-----------------------+-----------------------+----------------------------+ |
|                   | | APPROVALS INBOX       | ACCESS POSTURE        | REMOTE ACCESS              | |
|                   | | [ 1 Pending ]         | Profile: Balanced     | [ ● OFF (Local Only) ]     | |
|                   | | 24 Approved today     | Policy: Smart Prompt  | No internet exposure       | |
|                   | | [ Open Approvals -> ] | [ Review Policy -> ]  | [ Configure Ingress -> ]   | |
|                   | +-----------------------+-----------------------+----------------------------+ |
|                   | | CLIENT ECOSYSTEM      | SYSTEM / REPAIR       | INTERNAL PORTS             | |
|                   | | [ 2 Connected ]       | Setup: Complete       | [ Automatic (Healthy) ]    | |
|                   | | Claude (●), Cursor (●)| All checks passing    | Ports managed seamlessly   | |
|                   | | [ View Clients -> ]   | [ Diagnostics -> ]    | [ Advanced Routing -> ]    | |
|                   | +-----------------------+-----------------------+----------------------------+ |
|                   |                                                                                |
|                   | RECENT ACTIVITY STREAM (Last 5 events)                                         |
|                   | +----------------------------------------------------------------------------+ |
|                   | | 12:44:02  [Tool] execute_command  by Claude Desktop      [Awaiting Action] | |
|                   | | 12:41:19  [File] read_file        by Cursor              [Allowed (Smart)] | |
|                   | | 12:38:50  [Auth] Admin Code Verified                     [Session Active]  | |
|                   | | 12:30:11  [Init] Gateway Started (Automatic Ports)       [Ready]           | |
|                   | +----------------------------------------------------------------------------+ |
+-------------------+--------------------------------------------------------------------------------+
```

### 4.2 Approvals (Human Decision Inbox)
```
+-------------------+--------------------------------------------------------------------------------+
| NAV               | APPROVALS INBOX                                                                |
|   Home            | Windows Native Notifications: [● Available & Active]                          |
| > Approvals (1)   |                                                                                |
|   Connections     | PENDING APPROVALS QUEUE (1 item)                                               |
|   Access & Sec    | +----------------------------------------------------------------------------+ |
|   Activity        | | [!] HIGH RISK ACTION · Job #job_98412                 Expires in 02:45 min | |
|   Settings        | | Client: [Claude Desktop (PID 14220)]                                       | |
|   Advanced        | | Action: execute_command                                                    | |
|   Setup / Repair  | | Risk Reason: Modifies system state outside allowed folders                 | |
|                   | | Target: powershell.exe -Command "npm run build"                            | |
|                   | | Working Directory: D:\mcp\projects\webapp                                  | |
|                   | |                                                                            | |
|                   | | Mandatory Confirmation: [ Required by Policy ]                             | |
|                   | | [ Input: Type "confirm" to authorize: [confirm____________] ]              | |
|                   | |                                                                            | |
|                   | | [ ▼ Expand Raw Technical Arguments / Payload ]                             | |
|                   | |                                                                            | |
|                   | | ACTIONS:   [ ✓ Approve Action ]      [ ✕ Deny Action ]                     | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | RECENT APPROVAL HISTORY                                                        |
|                   | +----------------------------------------------------------------------------+ |
|                   | | 12:20:10  write_file       D:\mcp\src\app.ts      [Approved] by Owner      | |
|                   | | 11:45:00  delete_file      D:\mcp\temp.log        [Denied]   by Owner      | |
|                   | | 10:15:22  execute_command  cmd.exe /c dir         [Expired]  (Timeout)     | |
|                   | +----------------------------------------------------------------------------+ |
+-------------------+--------------------------------------------------------------------------------+
```

### 4.3 Connections (Client Ecosystem & Remote Access)
```
+-------------------+--------------------------------------------------------------------------------+
| NAV               | CONNECTIONS & CLIENT INTEGRATION                                               |
|   Home            | Manage client connections and inbound routing posture.                         |
|   Approvals       |                                                                                |
| > Connections     | REMOTE ACCESS & INGRESS CONTROL                                                |
|   Access & Sec    | +----------------------------------------------------------------------------+ |
|   Activity        | | State: [ ● Remote Access: OFF ]                                            | |
|   Settings        | | WinHelm is listening on local loopback only (127.0.0.1).                    | |
|   Advanced        | | No public traffic, external tunnels, or remote clients can connect.        | |
|   Setup / Repair  | |                                                                            | |
|                   | | Ingress Options:                                                           | |
|                   | | [ Tailscale HTTPS (/mcp) ]  Status: Disabled  [Enable Tailscale Ingress]   | |
|                   | | [ ChatGPT / OpenAI Tunnel ] Status: Disabled  [Enable Reverse Tunnel]      | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | FIRST-CLASS AI CLIENTS                                                         |
|                   | +---------------------------+------------------------------------------------+ |
|                   | | [ Claude Desktop ]        | [ Cursor ]                                     | |
|                   | | Status: [ ● Connected ]   | Status: [ ● Connected ]                        | |
|                   | | Config: C:\...\claude.json| Config: %APPDATA%\Cursor\mcp.json              | |
|                   | | Session: Live (PID 14220) | Session: Live (PID 8912)                       | |
|                   | | [ Reconfigure Client ]    | [ Reconfigure Client ]                         | |
|                   | +---------------------------+------------------------------------------------+ |
|                   | | [ ChatGPT / OpenAI ]      | [ Google Gemini ]                              | |
|                   | | Status: [ ○ Configured ]  | Status: [ ○ Ready to Connect ]                 | |
|                   | | Remote Ingress: Off       | Local MCP Bridge: Available                    | |
|                   | | [ Connect via Assistant ] | [ Connect Client ]                             | |
|                   | +---------------------------+------------------------------------------------+ |
|                   |                                                                                |
|                   | ACTIVE SESSIONS TABLE                                                          |
|                   | +---------------------+-----------+------------------+-----------------------+ |
|                   | | Client Name         | IP        | Connected Since  | Protocol Transport    | |
|                   | +---------------------+-----------+------------------+-----------------------+ |
|                   | | Claude Desktop      | 127.0.0.1 | 42 min ago       | SSE (Local loopback)  | |
|                   | | Cursor Editor       | 127.0.0.1 | 18 min ago       | Streamable HTTP       | |
|                   | +---------------------+-----------+------------------+-----------------------+ |
+-------------------+--------------------------------------------------------------------------------+
```

### 4.4 Access & Security (Comprehensible Dual-Axis Policy)
```
+-------------------+--------------------------------------------------------------------------------+
| NAV               | ACCESS & SECURITY POLICY                                                       |
|   Home            | Understand and govern what tools are exposed and when approval is required.    |
|   Approvals       |                                                                                |
|   Connections     | DUAL-AXIS SECURITY MODEL:                                                      |
| > Access & Sec    |                                                                                |
|   Activity        | AXIS 1: CAPABILITY PROFILE (What capabilities are permitted)                   |
|   Settings        | +----------------------------------------------------------------------------+ |
|   Advanced        | | ( ) SAFE         Read-only files, search, system telemetry. No changes.    | |
|   Setup / Repair  | | (*) BALANCED     Standard developer tools, safe file editing, sandboxed.   | |
|                   | | ( ) POWER        Full operating system control, direct command execution.  | |
|                   | | ℹ Dangerous mode is NOT a supported profile.                              | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | AXIS 2: APPROVAL MODE (When human prompts are triggered for permitted tools)   |
|                   | +----------------------------------------------------------------------------+ |
|                   | | ( ) MANUAL       Always prompt before any mutating or sensitive action.    | |
|                   | | (*) SMART        Prompt only for high-risk actions or boundary crosses.    | |
|                   | | ( ) TRUSTED      Skip routine prompts inside allowed folders.              | |
|                   | |                  *Note: Trusted mode never bypasses profile boundaries!*   | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | ALLOWED WORKING DIRECTORIES                                                    |
|                   | +----------------------------------------------------------------------------+ |
|                   | | [D:\mcp]                  [Read / Write]  [Default Workspace]              | |
|                   | | [C:\Users\csuti\Projects] [Read / Write]                                   | |
|                   | | [+ Add Folder Boundary]   (Requires Admin Unlock)                          | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | PRIVILEGE & MUTATION ACTIONS                                                   |
|                   | +----------------------------------------------------------------------------+ |
|                   | | Status: [🔒 Admin Locked]  Admin authorization required to apply changes.   | |
|                   | | [ Unlock Admin Session ]  (Enter one-time code from terminal)              | |
|                   | | [ Preview Policy Changes ]  [ Apply Policy Changes ]                       | |
|                   | +----------------------------------------------------------------------------+ |
+-------------------+--------------------------------------------------------------------------------+
```

### 4.5 Activity (Audit Log & Event Timeline)
```
+-------------------+--------------------------------------------------------------------------------+
| NAV               | ACTIVITY & AUDIT TRAIL                                                         |
|   Home            | Filter and inspect human and AI actions recorded by WinHelm.                   |
|   Approvals       |                                                                                |
|   Connections     | FILTERS: [ All (48) ] [ Approvals (4) ] [ Tools (36) ] [ Security (6) ] [ Errors (0) ]
|   Access & Sec    | Search: [ Filter events by name, client, path...                           ]   |
| > Activity        |                                                                                |
|   Settings        | TIMELINE:                                                                      |
|   Advanced        | +----------------------------------------------------------------------------+ |
|   Setup / Repair  | | 12:44:02  [Pending Approval] execute_command  by Claude Desktop            | |
|                   | |           powershell.exe -Command "npm run build"                          | |
|                   | |----------------------------------------------------------------------------| |
|                   | | 12:41:19  [Tool Executed]    read_file        by Cursor                    | |
|                   | |           Target: D:\mcp\src\gateway\server.ts  [Outcome: Success]         | |
|                   | |----------------------------------------------------------------------------| |
|                   | | 12:38:50  [Security Event]   Admin Unlock     Local Terminal Session       | |
|                   | |           One-time code validated. Session granted for 15 minutes.       | |
|                   | |----------------------------------------------------------------------------| |
|                   | | 12:30:11  [System Startup]   Gateway Ready    Ports: Automatic Allocated   | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | [ Download Full Audit Log (JSON) ]   [ Clear Buffer (Admin Only) ]             |
+-------------------+--------------------------------------------------------------------------------+
```

### 4.6 Settings (Preferences & Credentials)
```
+-------------------+--------------------------------------------------------------------------------+
| NAV               | SETTINGS & PREFERENCES                                                         |
|   Home            | Everyday user preferences and local credential management.                     |
|   Approvals       |                                                                                |
|   Connections     | APPEARANCE & LOCALIZATION                                                      |
|   Access & Sec    | +----------------------------------------------------------------------------+ |
|   Activity        | | Language:   [ English (US)          ▼ ]  (Includes 100% ภาษาไทย parity)    | |
| > Settings        | | Theme:      [ System Default        ▼ ]  (Light / Dark / Auto)             | |
|   Advanced        | +----------------------------------------------------------------------------+ |
|   Setup / Repair  |                                                                                |
|                   | NOTIFICATIONS                                                                  |
|                   | +----------------------------------------------------------------------------+ |
|                   | | [x] Show Windows Desktop Toast Notifications for pending approvals          | |
|                   | | [x] Play subtle audio cue on high-risk approval requests                   | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | MCP SECURITY CREDENTIALS                                                       |
|                   | +----------------------------------------------------------------------------+ |
|                   | | MCP Bearer Access Token                                                    | |
|                   | | Token: [ •••••••••••••••••••••••••••••••••••••••• ] [ Show Token (1-Time) ] | |
|                   | | [ Rotate Access Token Now ]  (Requires Admin Unlock)                       | |
|                   | | *Warning: Rotating token invalidates all existing client connections*       | |
|                   | +----------------------------------------------------------------------------+ |
+-------------------+--------------------------------------------------------------------------------+
```

### 4.7 Advanced / Diagnostics (Technical Escape Hatch)
```
+-------------------+--------------------------------------------------------------------------------+
| NAV               | ADVANCED & SYSTEM DIAGNOSTICS                                                  |
|   Home            | Technical plumbing, dynamic routing targets, and diagnostic probes.           |
|   Approvals       |                                                                                |
|   Connections     | TRANCHE A: DYNAMIC INTERNAL PORT ALLOCATION                                    |
|   Access & Sec    | +----------------------------------------------------------------------------+ |
|   Activity        | | Allocation Mode:          [ Automatic (Tranche A Dynamic) ]                | |
|   Settings        | | Core Loopback Endpoint:   http://127.0.0.1:18820                           | |
| > Advanced        | | R7 Subprocess Endpoint:   http://127.0.0.1:18821                           | |
|   Setup / Repair  | | R8 Ingress Listener:      http://127.0.0.1:18822                           | |
|                   | | Active Generation ID:     gen_20261018_0984a1                              | |
|                   | | Port Collision Retries:   0 (Clean allocation)                             | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | PROCESS LIFECYCLE & RUNTIME TELEMETRY                                          |
|                   | +----------------------------------------------------------------------------+ |
|                   | | Host PID: 19488        Node.js: v22.12.0        Uptime: 2h 14m             | |
|                   | | Memory RSS: 58.4 MB    Heap Used: 32.1 MB       SSE Clients: 2             | |
|                   | +----------------------------------------------------------------------------+ |
|                   |                                                                                |
|                   | DIAGNOSTIC PROBES & LOG ACCESS                                                 |
|                   | +----------------------------------------------------------------------------+ |
|                   | | [ Run Diagnostic Self-Test ]   [ Inspect Raw Socket Tables ]                 | |
|                   | | [ Open Preserved Engineering Monitor (/dashboard) ]                         | |
|                   | +----------------------------------------------------------------------------+ |
+-------------------+--------------------------------------------------------------------------------+
```

### 4.8 Setup / Repair Entry Point (Companion Bridge)
```
+----------------------------------------------------------------------------------------------------+
| SETUP & REPAIR ASSISTANT                                                                       [X] |
+----------------------------------------------------------------------------------------------------+
| WinHelm Installation Health: [ ● All Core Components Installed & Verified ]                       |
|                                                                                                    |
| COMPANION APPLICATION:                                                                             |
| +------------------------------------------------------------------------------------------------+ |
| | WinHelm Setup Assistant Companion                                                              | |
| | Status: Installed at `D:\mcp\winhelm-setup-assistant-r1`                                       | |
| |                                                                                                | |
| | [ 🚀 Launch Standalone Setup Assistant ]                                                       | |
| | Use the dedicated Setup Assistant to install prerequisites, manage Windows startup services,    | |
| | and repair corrupted client configurations.                                                     | |
| +------------------------------------------------------------------------------------------------+ |
|                                                                                                    |
| QUICK REPAIR ACTIONS:                                                                              |
| [ 🔄 Reset Dynamic Ports ]   [ 📁 Repair Folder Permissions ]   [ 🔑 Re-inject Client Configs ]    |
+----------------------------------------------------------------------------------------------------+
```

---

## 5. Responsive Behavior Specifications

The layout fluidly adapts across three distinct viewport profiles:

1. **Desktop Standard (`width >= 1024px`)**:
   - Fixed left sidebar navigation (`width: 240px`).
   - Multi-column card grids (2 or 3 columns).
   - Full horizontal tables for sessions and audit logs.
2. **Tablet / Narrow Window (`768px <= width < 1024px`)**:
   - Collapsible icon-and-label sidebar (`width: 72px` or overlay drawer).
   - Two-column cards reflow into single columns.
   - Tables scroll horizontally or collapse into labeled key-value definition lists.
3. **Compact / Mobile (`width < 768px`)**:
   - Top navigation bar with hamburger menu toggle.
   - 100% width vertical card stacking.
   - Approval action buttons switch from inline to full-width stacked buttons (`Approve` on top, `Deny` below).
   - Approval countdown timers and risk tags wrap cleanly without text clipping.

---

## 6. Accessibility (A11y) Specifications

- **Color Independence**: Every status element uses a shape/icon + color + descriptive textual label (e.g., green dot + checkmark icon + `Ready`).
- **Contrast Ratios**: All text tokens in both light and dark modes achieve WCAG AA contrast ratio of at least 4.5:1 for body copy and 3.0:1 for large headings and status badges.
- **Keyboard Navigation**:
  - Logical tab sequence through all navigation items, cards, inputs, and action buttons.
  - Visible 2px outline focus rings (`outline: 2px solid var(--accent-primary); outline-offset: 2px`).
  - No automatic keyboard activation of destructive/approval buttons to prevent accidental execution.
  - Modal focus trapping when Admin Unlock or Setup Assistant dialog is opened; Escape key dismisses modals.
- **Screen Reader Semantics**:
  - Semantic HTML5 landmarks (`<nav>`, `<header>`, `<main>`, `<section>`, `<article>`).
  - ARIA live regions (`aria-live="polite"`) for real-time approval job notifications and status updates.
  - Form controls have explicit associated `<label>` elements.

---

## 7. API / Data-Contract Matrix

| UI Component | Data Source | Method & Endpoint | Payload Structure / Contract |
|---|---|---|---|
| **System Status Pill** | Gateway Health | `GET /health` | `{ status: "ok", timestamp }` |
| **Urgent Attention Bar** | Admin Approvals | `GET /admin/approvals` | `{ jobs: [ { id, client, tool, riskLevel, ... } ] }` |
| **Capability Profile** | Profile Service | `GET /admin/profile` | `{ preset: "balanced", terminalMode: "ask", allowedDirectories: [...] }` |
| **Approval Mode** | Profile Service | `GET /admin/profile` | `{ approvalMode: "smart" }` |
| **Remote Access Posture**| Tunnel Manager | `GET /admin/tunnel/status` | `{ active: false, provider: null, hostname: null }` |
| **Connected Clients** | Session Context | `GET /admin/clients/status` | `{ clients: [ { name, configured, connected, pid } ] }` |
| **Dynamic Internal Ports**| Tranche A Adapter | `GET /admin/status` | `{ portMode: "automatic", endpoints: { core, r7, r8 }, generationId }` |
| **Toast Notifications**| Tranche B Adapter | `GET /admin/status` | `{ nativeNotifications: "available" }` |
| **Audit Stream** | Audit Logger | `GET /api/monitor/logs` | `{ logs: [ { timestamp, actor, action, outcome } ] }` |
| **Admin Unlock** | Admin Auth | `POST /admin/auth/exchange`| Body: `{ code: "..." }` -> Cookie + `{ csrfToken, expiresAt }` |
| **Approve / Deny** | Approval Engine | `POST /admin/approvals/:id/(approve\|deny)` | Header: `x-winhelm-csrf`, Body: `{ reason: "..." }` |
| **Setup Assistant** | Companion Bridge | Status probe / IPC | `{ companionInstalled: true, path: "..." }` |

---

## 8. Summary & Transition to Prototype Construction

The visual tokens, component inventory, vocabulary, wireframes, and API contracts defined in this specification provide the exact blueprint for the local clickable interactive prototype constructed in `docs/ui-refresh/prototype/`.
