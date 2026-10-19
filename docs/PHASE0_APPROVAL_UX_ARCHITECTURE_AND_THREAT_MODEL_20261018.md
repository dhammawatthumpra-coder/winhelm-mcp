# WINHELM v1.4.1 APPROVAL UX — PHASE 0 ARCHITECTURE & THREAT MODEL

**Date:** 2026-10-18 (+07)  
**Revision:** R1  
**Lane:** WINHELM_V1_4_1_APPROVAL_UX (Tranche B)  
**Target Disposition:** `WINHELM_V1_4_1_APPROVAL_UX_PHASE0_ARCHITECTURE_READY_FOR_IMPLEMENTATION`  
**Reference Baseline:** `8d40cdbd228acef737a59a2cae09bdc1c194561a` (WinHelm v1.4.0 Final RC)  
**Isolated Workspace:** `D:\mcp\winhelm-v1.4.1-approval-ux-r1`  
**Branch:** `feat/v1.4.1-approval-ux`

---

## 1. Executive Summary & Product Objective

The primary product objective of WinHelm v1.4.1 Tranche B is:
> **OWNER CAN HANDLE ROUTINE WINHELM APPROVALS FROM A CLEAR NATIVE WINDOWS UX WITHOUT RETURNING TO A TERMINAL, WHILE ALL EXISTING SECURITY FLOORS REMAIN NON-BYPASSABLE.**

Currently, when WinHelm requires human approval for a sensitive tool (under Manual or Smart approval mode, or when Mandatory Confirmation is required), the user must either:
1. Open PowerShell and run `winhelm jobs` followed by `winhelm approve <jobId>`, OR
2. Click the toast notification, which opens the Web Dashboard in a browser, obtain an admin code from CLI (`winhelm admin-code`), enter the admin code, and click Approve on the web interface.

This creates substantial friction for routine daily workflows. WinHelm v1.4.1 introduces an actionable native Windows approval experience that allows the user to review a sanitized summary of the pending action and make an immediate Approve or Deny decision directly from the desktop, without typing an admin code and without switching contexts to a terminal or browser.

At the same time, the overarching security invariant is maintained:
> **WINDOWS TOAST / NOTIFICATION IS PRESENTATION, NOT AUTHORITY.**

Notifications are untrusted presentation surfaces. Notification text, query parameters, mutable temp files, or unverified local processes can never authorize tool execution. All decisions must route through the verified local decision channel into the existing v1.4.0 Approval Engine and cross-process coordination system.

---

## 2. Current Approval Lifecycle Inventory

### 2.1 ApprovalEngine Core State Machine
The core engine (`src/approval/approval-engine.ts`) enforces the following states:
- `awaiting_approval`: Initial pending state for any action requiring human consent.
- `approved`: Transitioned synchronously upon verified approval decision.
- `running`: Synchronously claimed by the owning process executor (`executeApproved`).
- `completed`: Successfully executed tool output recorded.
- `failed`: Execution failed, error recorded.
- `denied`: Transitioned upon explicit denial decision; tool execution is never called.
- `expired`: Transitioned when `now() >= expiresAt`; cannot be approved thereafter.
- `cancelled`: Transitioned upon session cancellation or request abort.
- `unknown`: Set upon startup recovery for any uncompleted job from a previous run; never auto-executed.

### 2.2 Invariant Checks on Request Creation
Before creating an approval job:
1. Journal integrity is verified (`journalIntegrityFailed` fails closed).
2. Deduplication is performed:
   - Same-session equivalent pending job returns `deduped_pending`.
   - Recently completed/failed equivalent within retention window returns `recent_equivalent`.
3. Concurrency limit is checked (`maxPending`).
4. Job ID is generated as `job_<UUID>`.
5. Job is synchronously recorded to durable journal (`~/.winhelm/approvals.json`).
6. Advisory hook `onCreated(job)` is fired.

### 2.3 Existing DEF-02 Cross-Process Coordination
WinHelm instances (HTTP Gateway, stdio MCP clients such as Claude Desktop or Cursor, background services) coordinate approvals across processes via file-based state inside `~/.winhelm/`:
- `approval-requests/<jobId>.json`: Single-writer mirror published by the owning process, containing sanitized job metadata and owner-computed display context (`clientInfo`, `risk`, `folderAccess`).
- `approval-decisions/<jobId>.json`: Written atomically with exclusive creation (`wx`, mode `0o600`) by a deciding surface. First writer wins; conflicting decisions are rejected at write time.
- `consumeOwnedDecisions`: Polled every 250ms by the owning process. Only the instance that owns the in-memory executor applies the decision via its local `ApprovalEngine`. Unlinks the decision file after applying.

---

## 3. Existing Notification Capability & Limitations Analysis

### 3.1 Existing Implementation (`src/engine/system.ts`)
WinHelm v1.4.0 sends an advisory Windows toast notification via `sendWinHelmApprovalNotification(activationUrl)`:
- Invoked via `notifyApprovalPending` in `src/approval/notify.ts`.
- Generates WinRT Toast XML (`ToastGeneric` template).
- Uses PowerShell to call `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("WinHelm").Show($toast)`.
- Falls back to `System.Windows.Forms.NotifyIcon.ShowBalloonTip` if ToastNotificationManager throws.

### 3.2 Limitations Identified
1. **Generic Content Only:** Only displays static strings `notify.approval.title` and `notify.approval.body`. The user cannot see which tool is requesting execution, what target path is targeted, or what the risk rating is.
2. **Non-Actionable Toast:** Contains only a single link button ("Review & Decide") launching an HTTP URL in the default browser. There are no direct "Approve" or "Deny" buttons.
3. **AdminAuth Barrier:** Clicking the toast opens the browser to `/approvals/:jobId`, but performing an approval requires full AdminAuth (admin code exchange, session cookie, and CSRF token), forcing the user back to the terminal anyway.
4. **Offline/Stdio Misalignment:** Stdio instances default to port 8788 in deep links; if the HTTP Gateway is not running, the link fails to load.

---

## 4. AdminAuth and Local-Control Trust Boundaries

### 4.1 Separation of Concerns
| Surface | Authority Scope | Authentication Requirement | Allowed Operations |
|---|---|---|---|
| **Web Dashboard / Admin API** | Broad Administrative Authority | Admin Code exchange -> Session Cookie + CSRF | Change profile presets, modify folder permissions, configure ChatGPT tunnel, rotate tokens, approve/deny any job |
| **Local CLI (`winhelm approve`)** | Approval Authority + Diagnostics | Interactive TTY + Local User File Permissions | List jobs, approve/deny specific job, view status, issue admin code |
| **Approval UX (Native Windows)** | **Narrow Single-Job Decision Authority** | **Local User Possession + Single-Use Capability Token** | **Approve or Deny EXACT current job only** |

### 4.2 Non-Bypassable Rule
- The native approval UX path introduces **only narrowly scoped authority** sufficient to decide the exact current approval job.
- It **CANNOT**:
  - Alter configuration or profiles.
  - Modify folder permissions.
  - Configure or toggle tunnels.
  - Issue or reveal admin codes or bearer tokens.
  - Grant broad admin session access to the browser or external callers.
- AdminAuth for general administrative settings remains strictly intact.

---

## 5. Actionable Windows Notification Feasibility

### 5.1 Reality Check: WinRT Event Subscription
Direct verification confirmed:
`Register-ObjectEvent : Windows PowerShell cannot subscribe to Windows RT events.`
Windows PowerShell cannot act as an in-process WinRT event listener for toast notifications.

### 5.2 Supported Windows Activation Models
Windows Toast Notifications support two primary activation mechanisms for desktop applications:

1. **Protocol Activation (`activationType="protocol"`):**
   - Registered custom URI scheme: `winhelm-approval:decide?jobId=<id>&decision=<approved|denied>`
   - Dispatched by Windows directly to the registered handler: `winhelm.cmd approval-activate ...`
   - Pros: Native OS dispatch, no browser window opened.
   - Constraint: Must not place secrets in command line arguments (observable by other processes).
2. **Interactive Native Notification Flyout (Desktop Helper):**
   - WinHelm spawns a lightweight, transient native desktop notification card (using Windows Presentation Framework / Windows Forms via PowerShell or compiled helper).
   - Displayed seamlessly on the user's active desktop with full styling, countdown timer, sanitized tool details, and [Approve] / [Deny] buttons.
   - Runs in the user's interactive logon session with direct access to local user state (`~/.winhelm/`).
   - When clicked, immediately validates and writes the decision locally, provides instant visual feedback ("Approved" / "Denied"), and exits cleanly in < 150ms.
3. **Dual-Channel Presentation Architecture (Selected):**
   - **Primary Actionable Surface:** Interactive Native Desktop Notification Flyout displayed at approval creation. Gives immediate 1-click Approve/Deny directly on the screen without opening browser or terminal.
   - **Persistent Notification Surface:** Windows Toast Notification posted to Windows Action Center with sanitized summary and protocol/dashboard actions for asynchronous/delayed review.

---

## 6. Secure Activation & Decision Channel Architecture

```
+-----------------------------------------------------------------------------------+
| WinHelm Process (Stdio MCP / HTTP Gateway / Service)                              |
|                                                                                   |
|  1. Tool requires approval                                                        |
|  2. ApprovalEngine.request() -> job_uuid (state: awaiting_approval)               |
|  3. Issue Scoped Decision Capability:                                             |
|     - jobId, fingerprint, instanceId, expiresAt, secretNonce                      |
|     - Write to ~/.winhelm/decision-capabilities/job_uuid.json (mode 0o600)        |
|  4. Publish Cross-Process Request:                                                |
|     - Write to ~/.winhelm/approval-requests/job_uuid.json (DEF-02 mirror)         |
|  5. Trigger Native Notification Presentation (Advisory onCreated hook)            |
+----------------------------------------+------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| Native Windows Notification (Presentation Layer)                                  |
|                                                                                   |
|  - Sanitized tool name (e.g. file_write)                                          |
|  - Sanitized target scope (e.g. D:\workspace\config.json [Read/Write])            |
|  - Risk classification & Mandatory Confirmation warning                           |
|  - Expiry countdown                                                               |
|  - Interactive Choices: [ APPROVE ]   [ DENY ]   [ Review in Dashboard ]          |
+----------------------------------------+------------------------------------------+
                                         |
                               User clicks [ APPROVE ]
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| Verified Local Decision Channel                                                   |
|                                                                                   |
|  1. Locality & User Verification:                                                 |
|     - Caller must be running as the same Windows user                             |
|     - Accesses ~/.winhelm/decision-capabilities/job_uuid.json                     |
|  2. Capability Validation:                                                        |
|     - Job exists and is awaiting_approval                                         |
|     - now() < expiresAt                                                           |
|     - Secret nonce matches                                                        |
|  3. Atomic Single-Use Consumption:                                                |
|     - Unlinks or renames capability file with exclusive lock                      |
|  4. Governed Decision Submission:                                                 |
|     - Writes ~/.winhelm/approval-decisions/job_uuid.json (wx, exclusive)          |
|     - Channel: "native_ux"                                                        |
+----------------------------------------+------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| Owning WinHelm Instance (consumeOwnedDecisions)                                   |
|                                                                                   |
|  1. Consumes decision file from ~/.winhelm/approval-decisions/                    |
|  2. Checks ownsJob(jobId)                                                         |
|  3. Calls ApprovalEngine.approve(jobId, "native_ux")                              |
|  4. Engine verifies state == awaiting_approval (synchronous CAS)                  |
|  5. State -> approved -> running -> executes tool callback                        |
|  6. Terminal outcome recorded in durable journal and audit log                    |
|  7. Visual feedback toast: "Approved: file_write completed"                       |
+-----------------------------------------------------------------------------------+
```

---

## 7. Threat Modeling & Security Invariants

### 7.1 Threat Vectors & Mitigations
| Threat Vector | Attack Scenario | Defense & Mitigation |
|---|---|---|
| **T1: Toast / Notification Impersonation** | Malicious local app crafts a fake toast mimicking WinHelm to trick user or trigger actions. | Toast is presentation only. The user clicking Approve on a fake notification cannot trigger execution unless a valid, matching job and capability exist in `~/.winhelm/decision-capabilities/`. |
| **T2: Job ID Guessing / Traversal** | Attacker tries `job_../../../etc` or guesses a UUID to approve actions. | Job IDs are strictly validated against `/^job_[A-Za-z0-9-]+$/`. Capability files are keyed by sanitized UUID and stored in protected user profile. |
| **T3: Replay / Double-Execution** | Attacker replays an approval decision or clicks multiple times. | Single-use consumption: Capability file is atomically removed/consumed upon first decision. ApprovalEngine synchronous CAS transition prevents any second execution. Duplicate decision returns idempotent `ALREADY_DECIDED`. |
| **T4: Stale / Expired Execution** | User clicks an old toast hours later or after system restart. | Expiry check enforces `now() < expiresAt`. Engine marks uncompleted recovered jobs as `unknown` upon restart; expired jobs cannot transition to approved. Stale decision returns `EXPIRED`. |
| **T5: Unprivileged Local Process Snooping** | Unprivileged or other user accounts attempt to read approval tokens. | All coordination files live in `~/.winhelm/` with DACL / permissions restricted to the current Windows user (mode `0o600`). Cross-user access is denied by OS file system security. |
| **T6: Secret Leakage in Logs / Command Lines** | Passwords, tokens, or private file content exposed in notifications or process arguments. | Notifications display only sanitized, truncated summaries produced by `sanitizeObject` and `describeRequestFolderAccess`. Raw arguments, idempotency keys, and capability nonces NEVER appear in toast XML, Action Center history, process command lines, or logs. |
| **T7: Owner Death / Abandoned Job** | The WinHelm process owning the tool callback crashes or is killed before decision. | Decider verifies owner process liveness (`isProcessAlive(pid)`). If owner is dead, decision fails closed with `OWNER_UNAVAILABLE`. No other process can execute the tool. |
| **T8: Bypassing Absolute Deny** | User attempts to approve a tool or path that is prohibited by capability profile or protected paths. | Policy denial occurs BEFORE approval request creation. Disallowed tools or paths are rejected unconditionally at the gate; an approval job is NEVER created for them. Native UX cannot create or approve what policy forbids. |
| **T9: Bypassing Mandatory Confirmation** | User attempts to use Trusted Mode to bypass critical execution prompt. | Policy floor invariant: Mandatory Confirmation items ALWAYS require explicit human approval, regardless of whether Approval Mode is Manual, Smart, or Trusted. Native UX clearly highlights `[MANDATORY CONFIRMATION]`. |

### 7.2 Non-Bypassable Security Floors
1. **Capability/Profile Denial:** Always enforced upstream of approval.
2. **Absolute Deny:** Unconditional block; never creates an approvable job.
3. **Protected Paths/Objects:** Root, system, and out-of-boundary paths rejected.
4. **Mandatory Confirmation Floor:** Trusted mode cannot bypass.
5. **Native Boundary Validation:** Path resolution, symlink, and reparse checks preserved.
6. **Journal Integrity Fail-Closed:** Corrupt/missing journal stops new approvals.
7. **Single Executor:** Only the process owning the in-memory callback can execute.

---

## 8. Exact Job Binding & Anti-Replay Model

1. **Cryptographic Binding:**
   - Each capability record binds:
     - `jobId`: Exact UUID.
     - `fingerprint`: SHA-256 canonical hash of tool + arguments.
     - `instanceId`: Process instance ID of the creator.
     - `createdAt` & `expiresAt`: Millisecond epoch timestamps.
     - `secretNonce`: 32-byte crypto-random token.
2. **Single-Use Consumption:**
   - The decision submitter atomically renames or deletes the capability file before writing the decision file.
   - If the file is already consumed or missing, the decision is refused.
3. **First-Writer-Wins Decision Lock:**
   - Decision file `approval-decisions/<jobId>.json` is written with exclusive flag (`wx`).
   - If a conflicting decision already exists, the second write fails immediately with `ALREADY_DECIDED`.

---

## 9. Sanitized Display Schema

To prevent data exfiltration via notification history or desktop shoulder-surfing, the notification payload is strictly filtered:
```typescript
export interface SanitizedApprovalDisplay {
  jobId: string;
  tool: string;
  summary: string;           // Bounded <= 120 chars, e.g. "Write to D:\workspace\report.txt"
  folderAccess?: string;     // e.g. "D:\workspace [Read/Write]"
  clientName?: string;       // e.g. "Claude Desktop"
  riskLevel: "low" | "medium" | "high" | "critical";
  isMandatoryConfirmation: boolean;
  expiresInSeconds: number;
}
```
**Sanitization Rules:**
- Redact all tokens, passwords, keys, authorization headers.
- Truncate long commands or paths with clean middle/tail ellipsis (`...`).
- Omit file body contents or raw binary payloads.
- Explicitly prefix title with `[MANDATORY CONFIRMATION]` when applicable.

---

## 10. Multi-Instance & Cross-Process Routing

WinHelm v1.4.0 introduced DEF-02 cross-process approval routing. The Approval UX integrates directly with this mechanism:
1. **Stdio Clients (Claude Desktop / Cursor):**
   - The stdio process creates the job and publishes the request mirror to `approval-requests/<jobId>.json`.
   - The native notification is displayed to the user.
   - When the user clicks Approve, the decision is written to `approval-decisions/<jobId>.json`.
   - The stdio process's background timer (`consumeOwnedDecisions`) reads the decision, executes the tool, and returns the result to Claude Desktop.
2. **HTTP Gateway / Service Instances:**
   - Same flow; the Gateway consumes decisions addressed to its own jobs.
3. **Foreign Job Visibility:**
   - If the user opens the Web Dashboard, `listForeignRequests` already shows jobs from all active instances with owner-computed display context.

---

## 11. Stale Notification & Lifecycle Handling

- **Normal Flow:** Created -> Native Prompt -> User Approves -> Executed -> Outcome Toast -> Cleaned up.
- **Expiry:** Job expires after TTL (default 120s). Capability file expires. If user clicks later -> "Job Expired" error notification shown; execution refused.
- **Process Crash:** If owning instance dies before decision -> decider detects dead PID via `isProcessAlive` -> fails closed with `OWNER_UNAVAILABLE`.
- **System Reboot:** Any jobs in `awaiting_approval` recovered from journal are marked `unknown`. Capability files from previous boots are purged by stale sweep.
- **Action Center Stale Activation:** Clicking a stale notification from Windows Action Center after the job is resolved evaluates the current state and harmlessly reports "Already Decided" or "Expired".

---

## 12. Fallback Behavior & Discoverability

- The native approval UX is an additive operational improvement.
- **Fallback 1 (Web Dashboard):** The notification includes a "Review in Dashboard" link (`/approvals/<jobId>`). The Web Dashboard remains fully functional for inspecting full details and deciding jobs.
- **Fallback 2 (Local CLI):** `winhelm jobs` and `winhelm approve <jobId>` / `winhelm deny <jobId>` continue to function as the canonical terminal fallback.
- **Transport Failure:** If the native toast/notification fails to display (e.g. headless environment or notifications disabled), the approval job remains valid in `awaiting_approval` and can be resolved via Dashboard or CLI.

---

## 13. Packaging & Installation Requirements

- **Zero Additional Native Binaries Required:** The solution builds on WinHelm's existing native boundary addon (`winhelm_native.node`), Node.js standard libraries, and native Windows PowerShell/WinRT facilities.
- **Protocol Scheme Registration:** An optional helper command `winhelm register-approval-protocol` can register `winhelm-approval:` in HKCU (no admin privileges required).
- **Graceful Degradation:** If the protocol is not registered, the native flyout prompt and toast fallback operate smoothly without error.

---

## 14. Batch Approval Decision

**Evaluation:**
- The kickoff handoff permits evaluating batch approval, but strictly forbids "Approve all pending" and mandates that Mandatory Confirmation items preserve explicit individual confirmation.
- **Architectural Decision for v1.4.1 Tranche B:**
  - **Batch approval is DEFERRED to follow-on v1.4.2+.**
  - **Rationale:** Routine daily work predominantly requires deciding single approvals as they occur in context. Batch approval introduces substantial security risks (grouping false positives, accidental inclusion of mandatory items, complex equivalence matching) that could jeopardize the stability and focus of the v1.4.1 operational UX release.
  - v1.4.1 focuses exclusively on rock-solid, single-job native approval with zero friction and guaranteed security floors.

---

## 15. Collision Analysis

### 15.1 Dynamic Internal Port Allocation Lane (`winhelm-v1.4.1-dynamic-internal-ports-r1`)
- **Isolation:** Approval UX relies on file-based capabilities (`~/.winhelm/decision-capabilities/`) and cross-process coordination (`~/.winhelm/approval-decisions/`). It does NOT depend on a fixed HTTP port.
- **Integration Boundary:** When Dynamic Port Tranche A stabilizes, the optional Web Dashboard URL in notifications can query the dynamic port registry. Until then, it uses the standard v1.4.0 port resolution without conflict.
- **No Workspace Contamination:** No edits made to Tranche A files or workspaces.

### 15.2 Setup Assistant Lane (`winhelm-setup-assistant-r1`)
- **Isolation:** Setup Assistant is a standalone companion. Approval UX does not edit or require Setup Assistant.
- **Future Integration:** Approval UX exposes status flags in `winhelm_status` (`approvalUxAvailable`, `nativeNotificationsEnabled`) that Setup Assistant can report when integrated.

---

## 16. Comprehensive Test Matrix

| Category | Test Case | Target Verification |
|---|---|---|
| **Security Floors** | Absolute Deny bypass attempt | Never creates approval job; tool call returns error immediately. |
| **Security Floors** | Capability Profile denial | Disallowed tool rejected before approval queue. |
| **Security Floors** | Mandatory Confirmation invariant | Trusted mode cannot bypass; prompt clearly displays Mandatory Confirmation. |
| **Security Floors** | Secret leakage audit | Capability nonces, tokens, passwords absent from notifications and logs. |
| **Lifecycle** | Standard Approve | `awaiting_approval` -> `approved` -> `running` -> `completed`. |
| **Lifecycle** | Standard Deny | `awaiting_approval` -> `denied`; executor never invoked. |
| **Lifecycle** | Job Expiry | Exceeded TTL transitions to `expired`; late decision rejected. |
| **Lifecycle** | Replay / Duplicate Click | Second click returns idempotent `ALREADY_DECIDED`; no second run. |
| **Lifecycle** | Stale Action after Reboot | Recovered jobs in `unknown` state reject decisions safely. |
| **Multi-Instance** | Stdio to Native UX | Job created in stdio client decided via native UX; stdio client receives result. |
| **Multi-Instance** | Owner Death | If owning process dies, decider reports `OWNER_UNAVAILABLE`; fails closed. |
| **Presentation** | Sanitization & Truncation | Path sanitized, long strings truncated, HTML/XML escaped cleanly. |
| **Fallback** | Transport Unavailable | Toast failure does not break approval job; CLI/Dashboard decide normally. |

---

## 17. Phase 0 Disposition & Recommendation

All required Phase 0 architectural components, threat models, security floors, display schemas, multi-instance contracts, and test specifications are fully coherent and resolved without requiring any expansion of administrative authority or mutation of frozen baselines.

**Official Phase 0 Disposition:**
```
WINHELM_V1_4_1_APPROVAL_UX_PHASE0_ARCHITECTURE_READY_FOR_IMPLEMENTATION
```

Under Workflow v2, with Phase 0 coherent and requiring no L2 authority expansion, the lane proceeds directly into **Phase 1: Native Notification Presentation**.
