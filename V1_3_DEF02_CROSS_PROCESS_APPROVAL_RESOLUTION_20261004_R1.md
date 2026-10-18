# WinHelm v1.3 — DEF-02 Cross-Process Approval Resolution Report (R1)

Date: 2026-10-04
Branch: `feat/v1.3-implementation-baseline`
Starting HEAD: `f4d0c997b5c90e92a1054102cd2ce0bdeebff264`
Ending HEAD: `9a9aaaa` (4 commits, listed below)
Inputs: `V1_3_OWNER_GUI_SMOKE_20261004_R1.md` (GUI smoke that found DEF-02)

No secrets are recorded in this report.

---

## 1. Root cause (DEF-02)

Claude Desktop and Cursor each run WinHelm as their own stdio process. Approval
jobs lived only in the owning process's in-memory `ApprovalEngine`
(`src/approval/approval-engine.ts`, `jobs` map). The Dashboard HTTP process
resolves jobs only from its own engine (`/admin/approvals` →
`getApprovalEngine().list()`), so jobs created by stdio clients were invisible
and undecidable there. Connectivity was the second half: stdio mode never set
a runtime effective port, so the approval toast carried no deep link, and
`~/.winhelm/control.json` is a single last-writer-wins slot, so the local
control CLI could address the wrong or a dead pipe (this last part is
DEF-02a, reproduced live during the earlier smoke).

## 2. Selected architecture

A file-based coordination layer beside the existing durable journal, inside
the same protected `~/.winhelm` tree (`src/approval/cross-process.ts`):

- **`approval-requests/<jobId>.json`** — written by the **owning** process on
  every durable transition (same choke point as the journal write:
  `ApprovalEngine.persist` → `runtime.mirrorRequest`). Single writer per file,
  so no whole-file clobber across processes. Carries the sanitized public job
  plus **owner-computed** display metadata (`clientInfo`, `risk`,
  `dataDisclosure`, `folderAccess`, `provenance`) and the owner `pid`/
  `instanceId`. Terminal states are retained (a decider must be able to
  observe the outcome) and swept after a grace period.
- **`approval-decisions/<jobId>.json`** — created **first-writer-wins**
  (`open wx` + `link` + `unlink`) by whichever surface decides (Dashboard or
  local CLI). The owning process consumes it in a 250 ms tick and applies it
  through **its own engine**.

The owning process remains the **only executor**. The Dashboard never invokes
a tool callback. Every pre-existing guard still runs on the owner side:
state check, expiry, `approved → running` CAS claim, journal durability
before execution, audit, and the recovered-job `unknown` path.

Why per-job files rather than reusing the journal as the shared view: the
journal is written **whole-file** by each process (`ApprovalJournal.persist` →
one atomic replace of the entire snapshot), so two active instances clobber
each other's records. That was observed directly while building this fix and
is why the single-writer per-job mirror — not the journal — is the
authoritative cross-process view.

## 3. Atomic / exactly-once invariant

1. The owner mirrors only after `persistJob` succeeds, so the mirror never
   claims a transition the journal did not durably record.
2. A decision is recorded at most once per job (exclusive file creation);
   a conflicting second decision is rejected (`ALREADY_DECIDED`).
3. The owner applies the decision via `engine.approve/deny`, whose
   `job.state !== "awaiting_approval"` check plus the `approved → running`
   CAS gives exactly one claim; `executionCount` cannot exceed 1.
4. A decision for a missing/expired/terminal job is refused before writing
   (`OWNER_UNAVAILABLE` / `CONFLICT`), verified against the owner's mirror
   and `isProcessAlive(mirror.pid)`.
5. A decision nobody consumes can never execute anything — only the owning
   process applies decisions, so a dead owner's decision file is inert and
   swept later.
6. `decideRemote` reports `applied` only when the owner reached a **terminal**
   state; an in-flight claim is reported `pending`.

## 4. Files changed / commits

| Commit | Subject |
| --- | --- |
| `e158b66` | fix(approval): coordinate approvals across WinHelm processes |
| `010e1ba` | fix(session): publish stdio client identity to the approval surface |
| `ac9663b` | test(approval): pin Dashboard cross-process approve and deny routing |
| `9a9aaaa` | fix(admin): verify the admin code across WinHelm processes (DEF-02b) |

Files:
- added `src/approval/cross-process.ts`, `src/cli/decision-cli.ts`,
  `src/admin/admin-code-store.ts`
- `src/approval/runtime.ts` (mirror on persist, decision tick, decision surface)
- `src/approval/approval-engine.ts` (`ownsJob`, exact owner set)
- `src/approval/notify.ts` (loopback Dashboard-port fallback for stdio toasts)
- `src/admin/auth.ts` (shared admin-code digest store; DEF-02b)
- `src/admin/routes.ts` (merge foreign jobs into `/admin/approvals`; route
  approve/deny to the owner when local engine lacks the job)
- `src/cli/commands.ts` (jobs/approve/deny from shared state, no control-pipe
  dependency for approval routing — DEF-02a)
- `src/index.ts` (enable cross-process + owner display metadata; publish stdio
  clientInfo; enable shared admin code store)
- tests: `test/integration/cross-process-approval.test.ts` (A–J),
  `test/integration/def02-dashboard-approval.test.ts`,
  `test/unit/admin-code-store.test.ts`,
  `test/integration/harness/cross-process-owner.mjs`,
  updated `cli-control-v2` and `approval-notify-v2`

## 5. Automated multi-process evidence

`test/integration/cross-process-approval.test.ts` runs real separate OS
processes (Node child processes via a harness), not mocks:

| Leg | Asserted |
| --- | --- |
| A+B | foreign job visible with sanitized metadata; approve executes exactly once in owner; `executionCount = 1`; no idempotency-key leak |
| C | cross-process deny → owner callback not run; `executionCount = 0` |
| D | owner decides expiry; late approve cannot execute |
| E | two concurrent approves → at most one transition, one execution |
| F | decision for a dead owner refused (`OWNER_UNAVAILABLE`), nothing executes |
| G | owner dies after claim → recovered job is `unknown`, never replayed |
| H | two owners listed; decisions route to the correct owner, no cross-routing |
| I | routing ignores poisoned/stale control metadata entirely |
| J | a real stdio server process publishes the client's announced clientInfo to the mirror |

`test/integration/def02-dashboard-approval.test.ts` drives the **real HTTP
admin plane** (`/admin/auth/exchange` → `/admin/approvals` →
`/admin/approvals/:id/approve|deny`) against two live owning processes: the
Dashboard lists both foreign jobs with owner-computed `clientInfo`/`risk`
(`source: "remote"`), approve routes to one owner and deny to the other, and
exactly one side effect occurs across both (`executionCount` 1 and 0).

`test/unit/admin-code-store.test.ts` (DEF-02b): a code issued by one instance
is exchangeable by a different instance through the protected digest store;
single-use; digest-only (raw code never on disk); expiry and refresh honored.

Cross-process suite stability: 5 consecutive clean runs before commit.

## 6. Full checkpoint

`--test-concurrency 1` (the repo's default parallel runner is flaky on this
loaded machine — see §8):

| Check | Result |
| --- | --- |
| `npm run type-check` | PASS |
| `npm run lint:tools` | PASS (41 tools) |
| `npm run build` | PASS |
| tests | **580 / 132 suites / 580 pass / 0 fail / 0 skipped** |

Baseline before this work: 565/129. Added: 10 cross-process (Legs A–J,
including stdio-clientInfo Leg J) + 1 dashboard routing + 4 shared-admin-code
= 15 new tests (with 2 pre-existing tests updated, none removed).

## 7. GUI rerun results

Real clients, real processes, RC-smoke schema-v2 config:

- **Claude Desktop chat** created an approval-gated `clipboard_set` call; the
  job appeared in the shared mirror with
  `clientInfo = {"name":"Claude Desktop","version":"1.0"}` — PASS (this is
  the gap that made the Dashboard show "client: null" before `010e1ba`).
- **Cursor agent** created a `clipboard_set` job; mirror showed
  `clientInfo = {"name":"cursor-vscode","version":"1.0"}` bound to Cursor's
  own instance pid, distinct from Claude's — PASS for client identity and
  session isolation.
- **Dashboard unlock across instances (DEF-02b)**: a code obtained through the
  local control pipe (the human channel) unlocked the Dashboard served by a
  different process — HTTP 200 — PASS. Before `9a9aaaa` this returned 401.
- **Dashboard Approve leg (Claude Desktop)** (real stdio client process + real HTTP
  admin plane): the Dashboard listed the pending job as
  `state=awaiting_approval tool=clipboard_set
  client={"name":"Claude Desktop","version":"1.0"} source=remote
  risk={"class":"R3","level":"elevated"} expiresIn=104s`; Approve returned
  `success:true` and the job became `completed` with `executionCount: 1` — PASS.
- **Dashboard Deny leg (Cursor / cursor-vscode)**: a second job from a `cursor-vscode` client
  was listed the same way; Deny made the owner reach `denied` with `executionCount: 0`
  (approve job stays `completed`, exec 1) — PASS.
- No duplicate execution and no secret leakage observed; session ids are shown
  redacted (`sessionId":"************"`).

## 8. Remaining limitations / deviations

1. **DEF-02b (found and FIXED in this pass): admin-code was process-local.**
   Admin code issuance runs only through the local control pipe
   (`winhelm admin-code`), which every instance publishes into the single
   `~/.winhelm/control.json` slot, while `AdminAuthManager` kept the pending
   code in memory. Reproduced live: a code issued via the control pipe was
   **rejected by the Dashboard (HTTP 401)**. Fixed by mirroring only the
   code's SHA-256 **digest** + expiry into a protected `~/.winhelm` file
   (`src/admin/admin-code-store.ts`) that any instance can consume once;
   issuance still requires the local human channel and no HTTP surface was
   added. Re-verified live: control-pipe code → Dashboard unlock **200**.
   Commit `9a9aaaa`.
2. GUI approve/deny were exercised through the Dashboard's real HTTP admin
   endpoints (unlock with a real single-use control-pipe code), driven by an
   agent script rather than a physical mouse click. All routed metadata and
   the exactly-once outcome are real; the physical click remains owner-side.
3. `--test-concurrency 1` used for the reported checkpoint: the default
   parallel runner intermittently crashes an unrelated fixed-port suite
   (`server.test.ts` / `dashboard-locale-v2.test.ts`) under load on this
   machine. Pre-existing (reproduced on the unmodified baseline); also
   amplified by leftover test processes, which is handled by killing
   stragglers before a checkpoint run.
4. Stdio clientInfo reports the version the client announces (`1.0` /
   `1.0.0`), not the client's product version.
5. Expired mirror records linger for the 1-hour grace period (intentional)
   and appear in `winhelm jobs` as terminal history rather than being
   removed immediately.

## 9. Disposition

**`V1_3_RC_ACCEPTED`** (proposed for owner adjudication).

DEF-02 is fixed and proven: cross-process visibility, decision delivery,
exactly-once execution, fail-closed handling of dead owners, and client
identity, all verified by automated multi-process tests plus a real-HTTP
Dashboard routing test, and re-confirmed with real Claude Desktop and Cursor
processes. DEF-02b — the last blocker for the human click-through — was
found during the GUI rerun and fixed, then verified live (control-pipe code
unlocks the Dashboard; Dashboard lists a real stdio client's job with
`clientInfo`, `risk`, `folderAccess` and expiry; Approve → `completed`
`executionCount 1`; Deny → `denied` `executionCount 0`). Full checkpoint:
580 tests / 132 suites / 0 fail / 0 skipped.

Owner-side remaining action: one physical mouse click on the Dashboard
Approve/Deny button (the automation used a real admin code over the real
endpoints, but the click itself was scripted), plus the documentation
synchronization phase that only starts after adjudication.

Rollback/evidence material retained: both client config backups, smoke-config
backups, `~/.winhelm/approval-jobs.json.rc-smoke-archive-20261004.json`,
`<RECOVERY_ROOT>\_acl-recovery`, the pre-token-migration backup, and the GUI
screenshots referenced by the GUI smoke report. Working tree has no
uncommitted tracked changes.