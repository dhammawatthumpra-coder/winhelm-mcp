# WinHelm v1.4.1 Dashboard UI Refresh — Phase 0: UX Audit & Architecture Specification

Date: 2026-10-18 (+07)  
Revision: R1  
Lane: `WINHELM_V1_4_1_DASHBOARD_UI_REFRESH` (Tranche C)  
Umbrella Release: WinHelm v1.4.1 — Operational UX + Self-Configuration  
Reference Baseline Commit: `8d40cdbd228acef737a59a2cae09bdc1c194561a`  
Workspace: `D:\mcp\winhelm-v1.4.1-dashboard-ui-refresh-r1`  
Branch: `feat/v1.4.1-dashboard-ui-refresh`  
Status: **PHASE 0 ARCHITECTURE COMPLETE**  
Milestone Disposition: `WINHELM_V1_4_1_DASHBOARD_UI_REFRESH_PHASE0_UX_ARCHITECTURE_READY`

---

## 1. Executive Summary & Product Objective

The WinHelm v1.4.1 release focuses on operational usability and self-configuration under the guiding principle:
> **OWNER CAN UNDERSTAND WINHELM STATE, HANDLE APPROVALS, SEE CLIENT CONNECTIONS, AND MANAGE ORDINARY SECURITY/ACCESS SETTINGS FROM A CLEAR PRODUCT UI WITHOUT NEEDING TERMINAL KNOWLEDGE.**

Tranche C (Dashboard / UI Refresh) transforms the WinHelm administration interface from an engineering-dense monitor into a calm, authoritative, daily-use desktop product surface. It bridges the gap between deep operating system control and seamless user experience while preserving zero-compromise security: strict local loopback isolation, single-use AdminAuth, CSRF protection, strict Content Security Policy (CSP), zero external runtime dependencies, and strict defense against silent privilege escalation.

---

## 2. Current-State UX Audit

WinHelm v1.4.0 baseline contains two distinct web UI surfaces served by Express in `src/gateway/server.ts`:

### 2.1 The Legacy Engineering Monitor (`src/gateway/dashboard-html.ts`)
- **Route**: `GET /dashboard`
- **Architecture**: Single monolithic TypeScript file (68.9 KB) emitting an inline HTML/CSS/JS string.
- **Observed Characteristics**:
  - Dense, developer-centric layout dominated by low-level technical counters (CPU, Memory, Uptime, SSE subscriber lists).
  - Prominent "Admin Unlock" form fixed at the top requiring manual entry of a one-time terminal code.
  - Profile switching, folder whitelisting, and dangerous typed confirmation inputs in a single raw grid.
  - Flat tabular presentation of approval jobs and client sessions.
  - Massive list of 60+ tools rendered with raw green/grey status dots.
  - Live log streaming terminal occupying half the visual height.
  - Auto-refresh polling every 2.5 seconds.
  - Dark-only visual styling with heavy borders and monospace text.
- **Key Shortcomings**:
  - Overwhelming visual noise for non-developers; all data presented with equal weight.
  - Conflates low-level plumbing (internal ports, process IDs, SSE sockets) with product health.
  - Lacks structured navigation; forces vertical page scrolling.
  - No clear visual differentiation between Capability Profile (what tools are enabled) and Approval Mode (how prompts behave).
  - Approvals render technical JSON payloads that are hard to parse at a glance.

### 2.2 The Initial Product Shell (`src/gateway/product-shell-html.ts`)
- **Route**: `GET /` and `GET /approvals/:jobId`
- **Architecture**: Monolithic TypeScript template (80.7 KB) containing inline styles, markup, and client scripts.
- **Observed Characteristics**:
  - Introduces structured tabbed navigation: *Overview*, *Setup*, *Access*, *Approvals*, *Activity*, *Connections*, *Settings*, plus an external escape link to `/dashboard`.
  - Top header features brand pill with admin lock/unlock status modal.
  - Overview panel highlights server state, capability profile, approval mode, and quick stats.
  - Dedicated panels for Access, Approvals, Connections, and Settings.
  - Strict escaping and DOM generation to prevent XSS injection.
- **Key UX Gaps Identified in Product Shell**:
  1. **Monolithic Code Structure**: 80 KB template string makes component reuse, unit testing, and design system evolution difficult.
  2. **Incomplete Answer to the 5 Core Questions**:
     - *Is WinHelm healthy?* (Yes, but buried among minor status badges).
     - *Is anything waiting for my attention?* (Approval badge exists, but no immediate prominent call-to-action banner on Home).
     - *Which clients are connected?* (Summarized, but local vs remote distinction is ambiguous).
     - *What security posture am I in?* (Profile and Approval Mode are placed side-by-side, but users still confuse "Trusted mode" with "Power profile").
     - *Is Remote Access off or on?* (Crucial flaw: Remote Access status is not explicit on Home. Users cannot tell if the system is isolated locally or exposed via tunnel).
  3. **Approval Inspection Experience**: Arguments are displayed as raw strings or serialized JSON blocks. Risk rationales and mandatory confirmation steps lack clear visual hierarchy.
  4. **Fragmented Diagnostics**: "Advanced" currently just navigates away to `/dashboard`. The product shell lacks an integrated, progressive disclosure experience for internal routing, component generations, and health telemetry.
  5. **Setup Assistant Confusion**: The "Setup" tab attempts to act as a mini-wizard, potentially conflicting with the dedicated standalone Setup Assistant companion.
  6. **Lack of Design System Tokens**: Hardcoded hex colors and spacing values prevent consistent dark/light theme switching and responsive fluidity.

---

## 3. Backend & API Contract Mapping

The WinHelm backend exposes two distinct planes: unauthenticated monitor endpoints and privileged local admin endpoints.

### 3.1 Unauthenticated / Public Loopback Endpoints
| Endpoint | Method | Purpose | Response Payload |
|---|---|---|---|
| `/` | `GET` | Main Product Shell HTML | HTML document (Strict CSP) |
| `/dashboard` | `GET` | Preserved Engineering Monitor HTML | HTML document (Strict CSP) |
| `/approvals/:jobId` | `GET` | Direct deep-link to approval in Product Shell | HTML document with focus job ID |
| `/health` | `GET` | Basic liveness probe | `{ status: "ok", timestamp }` |
| `/preview` | `GET` | Render text preview of pending file/script payload | Sanitized plain text preview |
| `/api/monitor/stats` | `GET` | Live telemetry & metrics | `{ activeProfile, schemaMode, terminalMode, stats: { ... } }` |
| `/api/monitor/logs` | `GET` | Read circular audit log buffer | `{ logs: [ ... ] }` |
| `/api/monitor/logs` | `DELETE` | Clear in-memory log buffer | `{ ok: true }` |
| `/api/monitor/export` | `GET` | Export logs as JSON file download | JSON payload attachment |
| `/.well-known/security.txt` | `GET` | RFC 9116 security disclosure | Plain text |

### 3.2 Privileged Local Admin Plane (`/admin/*`)
All endpoints require `winhelm_admin_session` cookie issued via single-use `admin-code` exchange. Mutations require loopback origin validation and `x-winhelm-csrf` token header.

| Endpoint | Method | Auth / CSRF | Purpose |
|---|---|---|---|
| `/admin/auth/exchange` | `POST` | Mutation Origin | Exchange one-time terminal code for session cookie + CSRF token |
| `/admin/auth/logout` | `POST` | Mutation Origin | Terminate admin session, clear cookie |
| `/admin/status` | `GET` | Admin Session | Detailed admin runtime status |
| `/admin/sessions` | `GET` | Admin Session | Active MCP client sessions and connections |
| `/admin/profile` | `GET` | Admin Session | Current capability profile, approval mode, directories, terminal mode |
| `/admin/profiles/preview` | `POST` | CSRF + Origin | Dry-run validation of profile change (Safe/Balanced/Power) |
| `/admin/profiles/apply` | `POST` | CSRF + Origin | Apply profile preset (requires confirmation for Power/full) |
| `/admin/approval-mode/preview` | `POST` | CSRF + Origin | Dry-run validation of approval mode change (Manual/Smart/Trusted) |
| `/admin/approval-mode/apply` | `POST` | CSRF + Origin | Apply approval mode policy |
| `/admin/approvals` | `GET` | Admin Session | List active and historical approval jobs |
| `/admin/approvals/:jobId/approve` | `POST` | CSRF + Origin | Approve pending tool execution |
| `/admin/approvals/:jobId/deny` | `POST` | CSRF + Origin | Deny pending tool execution |
| `/admin/clients/status` | `GET` | Admin Session | Integration status of Claude, Cursor, ChatGPT, etc. |
| `/admin/clients/:client/preview` | `POST` | CSRF + Origin | Dry-run client config injection |
| `/admin/clients/:client/apply` | `POST` | CSRF + Origin | Automatically configure client config file |
| `/admin/auth/token/rotate` | `POST` | CSRF + Origin | Rotate MCP Bearer access token immediately |
| `/admin/tunnel/status` | `GET` | Admin Session | Remote access / Tailscale / ChatGPT tunnel status |
| `/admin/tunnel/doctor` | `GET` | Admin Session | Run network and ingress diagnostic probes |
| `/admin/tunnel/configure` | `POST` | CSRF + Origin | Configure tunnel hostname/provider |
| `/admin/tunnel/start` / `stop` | `POST` | CSRF + Origin | Start or stop remote access tunnel |

---

## 4. Target Information Architecture (IA)

The target IA organizes WinHelm into 8 clear, cohesive product domains:

```
[ WinHelm Product Shell ]
│
├── Top Bar: Brand, State Pill, Quick Actions, Admin Lock/Unlock, Theme Switcher, Language Toggle
│
├── 1. Home (Overview)
│   ├── System Health Banner (Ready / Needs Attention / Offline)
│   ├── Urgent Action Card (Pending Approvals / Warnings)
│   ├── 4 Core Posture Tiles:
│   │   ├── Approvals Inbox (Pending Count & Status)
│   │   ├── Access Policy (Capability Profile + Approval Mode)
│   │   ├── Remote Access Status (Explicit: OFF / ON / Needs Attention)
│   │   └── Connected Clients (Active count & badges)
│   ├── Recent Meaningful Activity (Last 5 events)
│   └── Setup / Diagnostic Quick Summary
│
├── 2. Approvals (Human Decision Inbox)
│   ├── Notification Status (Tranche B: Windows Toast Available / Fallback)
│   ├── Pending Approvals Queue (Priority Cards)
│   │   ├── Client Badge (e.g., Claude, Cursor)
│   │   ├── Tool & Action Summary
│   │   ├── Risk Assessment & Security Rationale
│   │   ├── Sanitized Target / Resource Path
│   │   ├── Mandatory Confirmation Input (where required)
│   │   ├── Expiration Countdown
│   │   ├── Action Buttons: [Approve] / [Deny]
│   │   └── Progressive Disclosure: "View Technical Details / JSON Payload"
│   └── Historical Decision Log (Approved / Denied / Expired)
│
├── 3. Connections (Client Ecosystem & Ingress)
│   ├── First-Class Local Clients:
│   │   ├── Claude Desktop (Connected / Configured / Setup)
│   │   ├── Cursor (Connected / Configured / Setup)
│   │   ├── Gemini (Connected / Configured / Setup)
│   │   └── ChatGPT / OpenAI (Connected / Configured / Setup)
│   ├── Ingress & Remote Access Posture:
│   │   ├── Remote Access Toggle & State Banner:
│   │   │   ├── Explicit "Remote Access: OFF" (Local Ready — No Public Exposure)
│   │   │   └── Explicit "Remote Access: ON" (Active Provider, Route, Ingress URL)
│   │   └── Tailscale / Reverse Tunnel Configuration & Doctor Diagnostics
│   └── Active Client Sessions (Live session table with clientInfo, IP, Uptime)
│
├── 4. Access & Security (Comprehensible Policy Control)
│   ├── Policy Axis 1: Capability Profile (What is permitted)
│   │   ├── Safe (Read-only, Search, Non-mutating)
│   │   ├── Balanced (Standard development, Sandboxed file write)
│   │   └── Power (Direct execution, elevated tools)
│   │   └── *Safety Rule: "Dangerous" is NEVER exposed as a profile*
│   ├── Policy Axis 2: Approval Mode (When user is prompted)
│   │   ├── Manual (Prompt every sensitive/mutating action)
│   │   ├── Smart (Prompt only high-risk, boundary-crossing, or irreversible actions)
│   │   └── Trusted (Skip routine prompts within allowed folders; *Never unrestricted*)
│   ├── Allowed Working Folders (Boundary scope with Read / Read-Write tags)
│   ├── Terminal Containment Posture (Ask / Block / Restricted)
│   └── Admin Privilege Guard (Changes clearly marked as requiring Admin Unlock)
│
├── 5. Activity (Audit Timeline & Event Stream)
│   ├── Human-readable Event Timeline
│   ├── Filter Pills: All / Approvals / Security / Tools / Errors
│   ├── Search & Timestamp Filtering
│   └── Export Audit Records (JSON)
│
├── 6. Settings (Ordinary Product Preferences)
│   ├── Language Selection (English / ภาษาไทย with 100% catalog parity)
│   ├── Theme Mode (System / Light / Dark)
│   ├── Notification Policy (Desktop Toast vs In-App only)
│   ├── MCP Access Token Management (View masked token, 1-click rotate with confirmation)
│   └── Preferences Reset / Safe Revert
│
├── 7. Advanced / Diagnostics (Technical Escape Hatch)
│   ├── Network & Endpoints (Tranche A):
│   │   ├── Allocation Mode: "Automatic" vs "Fixed"
│   │   └── Resolved Endpoints: Core port, R7 port, R8 local ingress, Generation ID
│   ├── Process Runtime & Health: PIDs, Uptime, Memory RSS, Garbage Collection
│   ├── Tool Registry: Exhaustive list of schemas, handlers, and capability flags
│   ├── Diagnostic Probes & Self-Test Suite
│   └── Direct Link to Preserved Engineering Monitor (`/dashboard`)
│
└── 8. Setup & Repair Entry Point (Companion Bridge)
    ├── Status Banner: Complete / Incomplete / Needs Repair
    ├── Action: "Launch Setup Assistant" (points to standalone companion)
    ├── Quick Client Setup: Generate / Inject client config files
    └── Self-Repair: Verify permissions, validate paths, reset ports
```

---

## 5. Navigation & Screen Map

```
               ┌────────────────────────────────────────────────────────┐
               │                  WINHELM TOP HEADER                    │
               │ Brand · Status Pill · Admin Unlock · Theme · Language  │
               └──────────────────────────┬─────────────────────────────┘
                                          │
    ┌───────────────┬─────────────────────┼──────────────────────┬───────────────┐
    ▼               ▼                     ▼                      ▼               ▼
┌─────────┐   ┌───────────┐         ┌───────────┐          ┌───────────┐   ┌───────────┐
│  Home   │   │ Approvals │         │Connections│          │ Access &  │   │ Activity  │
│ (Daily) │   │  (Inbox)  │         │(Clients & │          │ Security  │   │  (Audit)  │
└────┬────┘   └─────┬─────┘         │  Ingress) │          └─────┬─────┘   └───────────┘
     │              │               └─────┬─────┘                │
     │              │                     │                      │
     │              ▼                     │                      │
     │        ┌───────────┐               │                      │
     │        │ Deep Link │               │                      │
     │        │/approvals/│               │                      │
     │        │  :jobId   │               │                      │
     │        └───────────┘               │                      │
     │                                    │                      │
     ├────────────────────────────────────┼──────────────────────┤
     ▼                                    ▼                      ▼
┌───────────┐                       ┌───────────┐          ┌───────────┐
│ Settings  │                       │ Advanced  │          │  Setup /  │
│(Pref/Auth)│                       │  (System) │          │  Repair   │
└───────────┘                       └─────┬─────┘          └───────────┘
                                          │
                                          ▼
                                    ┌───────────┐
                                    │ Legacy /  │
                                    │/dashboard │
                                    └───────────┘
```

---

## 6. Frontend Architecture Decision: Option A vs Option B

Phase 0 must decide whether the refreshed UI stays zero-dependency / self-contained or adopts a locally bundled build.

### Evaluation Matrix

| Evaluation Criteria | Option A: Componentized Zero-Dependency Architecture | Option B: Bundled SPA Build (Vite / React / Svelte) |
|---|---|---|
| **External Runtime Dependencies** | **Zero** (100% local, self-contained) | **Zero** at runtime (bundled locally) |
| **Build & Toolchain Complexity** | Minimal (TypeScript compilation only) | High (Vite/Rollup pipeline, node_modules bloat) |
| **Content Security Policy (CSP)** | Clean fit with strict `script-src 'self' 'unsafe-inline'` or hashed nonces | Complex source-map and chunk-loading hashes required |
| **Packaging & Release Footprint** | Extremely lightweight; no separate asset deployment | Adds 200KB–2MB to release package |
| **Security Review Surface** | Minimal; every line of DOM generation is auditable in TS | Large; bundle obfuscation and transitive build dependencies |
| **Accessibility & Keyboard Control** | Native semantic HTML, predictable DOM state | Requires framework-level ARIA focus management |
| **Maintenance Longevity** | Zero framework deprecation risk over 5–10 years | Framework version churn and breaking updates |

### Decision: Adopt Option A+ (Modular Zero-Dependency Design System)
**Rationale**:
WinHelm is a security-critical host agent running on local Windows endpoints. Adopting a third-party SPA framework adds significant supply-chain exposure, build friction, and packaging overhead without providing any capability that modern vanilla CSS custom properties, semantic HTML5, and vanilla TypeScript modules cannot deliver.

In Option A+:
1. The UI is broken down into structured, modular TypeScript components (`layout.ts`, `tokens.css.ts`, `components/*.ts`, `views/*.ts`).
2. Design tokens (colors, spacing, typography, elevation) are maintained in CSS custom properties supporting instant, flicker-free Light/Dark switching.
3. Client-side state transitions (tab navigation, approval actions, admin modal) use lightweight, readable vanilla JavaScript with strict escaping.
4. Strict CSP (`default-src 'none'; connect-src 'self'`) is preserved with zero compromises.

---

## 7. Parallel Lane Interface Contracts

### 7.1 Tranche A: Dynamic Internal Port Allocation Contract
- **Default Product Behavior**:
  - Normal users see: `Network / Internal Ports: Automatic (Healthy)`.
  - Numeric port numbers (e.g. 18820, 18821, 18822) are **hidden** from Home, Connections, and Settings.
  - The UI does not imply that dynamic port rotation causes disconnections or security risks.
- **Advanced / Diagnostics Progressive Disclosure**:
  - Advanced view exposes the resolved internal endpoints:
    - `Core Endpoint`: `http://127.0.0.1:<port>`
    - `R7 Subprocess Endpoint`: `http://127.0.0.1:<port>`
    - `R8 Local Ingress Endpoint`: `http://127.0.0.1:<port>`
    - `Allocation Mode`: `Automatic` vs `Fixed`
    - `Collision Recovery Status`: Last resolved generation, port retry count.
  - Backward compatibility: Fixed-port installations display `Mode: Fixed (Legacy compatibility)`.

### 7.2 Tranche B: Approval UX Contract
- **Native Toast Notification Availability**:
  - The Approvals panel and Home view surface notification availability:
    - `Windows Native Notifications: Active / Available`
    - `Windows Native Notifications: Unavailable / Needs Setup`
- **Sanitized Approval Payload Semantics**:
  - Approvals UI shares the identical sanitization schema as Tranche B native notifications:
    - Client / Origin
    - Tool Name & Action
    - Risk Level (Low / Medium / High / Critical)
    - Sanitized Target Path or Resource
    - Mandatory Confirmation Flag (`requiresConfirmation: boolean`)
    - Expiration duration
- **Fallback Guarantee**:
  - The web dashboard remains a 100% authoritative decision surface. Approving or denying in the dashboard immediately satisfies or terminates the approval engine.

### 7.3 Setup Assistant Companion Boundary
- **Separation of Concerns**:
  - The Setup Assistant (`D:\mcp\winhelm-setup-assistant-r1`) is a standalone companion product responsible for installing prerequisites, Windows services, and client configs.
  - The Dashboard **never duplicates the installation engine**.
- **Dashboard Surface**:
  - Provides a clean entry card: "Finish Setup", "Launch Setup Assistant", or "Repair Configuration".
  - Inspects companion installation state:
    - If detected: offers one-click launch button.
    - If not detected: provides manual instruction and link.

---

## 8. Remote Access & Security Floor Rules

1. **Explicit Remote Access Posture**:
   - Default is always `Remote Access: OFF (Local Only)`.
   - The UI must never display green "Connected" badges in a way that suggests WinHelm is exposed to the internet when only local loopback clients are configured.
   - Remote Access has three explicit states:
     - `OFF`: Local loopback only. Maximum isolation.
     - `ON`: Verified active tunnel/ingress with visible provider and hostname.
     - `NEEDS ATTENTION`: Tunnel configured but offline, encountering handshake errors, or credentials expired.
2. **Capability Profile vs Approval Mode Distinction**:
   - **Profile** defines *Capability Boundaries* (What tools exist: Safe = read-only; Balanced = sandboxed dev; Power = full system).
   - **Approval Mode** defines *Prompt Frequency* (When to prompt: Manual = all sensitive; Smart = boundary/high-risk; Trusted = routine allowed).
   - The UI will explicitly display a guidance callout: *"Capability Profile controls what actions can be executed. Approval Mode controls how often WinHelm prompts for permitted actions."*
   - "Trusted" mode must **never** be labeled as "Unrestricted" or "All Allowed".
   - "Dangerous" is **never** presented as an available product profile.
3. **AdminAuth Protection**:
   - Read-only daily monitoring is available without friction.
   - Privileged operations (profile changes, folder additions, token rotations, remote tunnel activation) contextually prompt for the one-time Admin Code.
   - Unlocked state is clearly indicated by an active admin pill with expiration countdown, allowing easy manual re-locking.

---

## 9. Phase 0 Milestone Disposition

This UX Architecture Specification formally fulfills all Phase 0 requirements outlined in the kickoff handoff.

```
================================================================================
MILESTONE REACHED:
WINHELM_V1_4_1_DASHBOARD_UI_REFRESH_PHASE0_UX_ARCHITECTURE_READY
================================================================================
```

Having confirmed no security or architecture escalations are required, the lane proceeds directly into **Phase 1: Visual System + Prototype**.
