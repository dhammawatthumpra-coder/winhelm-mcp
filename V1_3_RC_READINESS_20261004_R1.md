# WinHelm v1.3 — RC Readiness Report (R1)

Date: 2026-10-04
Branch: `feat/v1.3-implementation-baseline`
HEAD at review start: `a9f2438` (`git rev-parse` verified)
HEAD at report time: unchanged — see Git section below.

---

## 1. Scope of this pass

Owner Review / Release Candidate preparation only. No feature work, no
Spike 0.3 reopen, no v1.4 scope. Security-critical commits reviewed first,
remaining commits reviewed risk-based (grouped, not line-by-line).

## 2. Security-critical commits reviewed

| Commit | Area | Verdict |
| --- | --- | --- |
| `9555402` | `process_kill` ownership / approval / retry dedupe | PASS |
| `280aec8` | Approval journal / restart fail-closed | PASS |
| `1b5b089` | Legacy wildcard protected-path fix | PASS |
| `f8dbd0d` | Dashboard client list with hashed session ids | PASS |
| `80982a7` | Auth token / protected secret store / rotation | PASS |

### Evidence highlights

- **`9555402`** — `processKillNeedsExternalApproval` allows policy-only
  execution solely for one concrete integer PID that `TaskManager` reports as
  a currently-running task it started (completed/killed task PIDs excluded,
  guarding against PID reuse). Name-based and ambiguous targets always
  escalate. The probed process identity (name/PID/publisher) reaches the
  approval dialog only as display metadata; `fingerprintArgs` passes the
  caller's original args, so an equivalent retry dedupes instead of
  re-arming a second kill. Identity probe runs read-only PowerShell with
  arguments passed via environment variables (no injection surface).
- **`280aec8`** — all 11 dispatched invariants hold:
  1. request/approve/pre-execution-claim all `persistJob` synchronously
     (temp file + fsync + rename) and refuse to proceed on write failure
     (`JOURNAL_UNAVAILABLE` / `claimWasRefused`).
  2. Restart recovery restores `awaiting_approval`/`approved`/`running`
     records as terminal `unknown`; `executeFn` for recovered jobs throws,
     so no auto replay.
  3. Interrupted jobs land in `unknown` (terminal-safe).
  4. `approve()` refuses any non-`awaiting_approval` job (409 CONFLICT);
     retry lookup returns `APPROVAL_UNKNOWN` instead of re-running.
  5. Corrupt/malformed journal is quarantined (`*.corrupt-<stamp>`, evidence
     preserved) and `journalIntegrityFailed` refuses new approval jobs
     (`JOURNAL_INTEGRITY_FAILED`).
  6. Persist failure on queueing deletes the job and throws; no executor
     path runs without a durability record.
  7. Late/duplicate approve → 409; deny/expire/cancel paths unchanged and
     terminal; all fail closed.
  8. `publicJob()` strips raw `idempotencyKey` from every API/dashboard
     payload; only a SHA-256 digest is kept (payload, memory, journal).
  9. Retry matching accepts session-scoped digest match, not just the raw
     client key; retention does not depend on the client key alone.
  10. Recovered jobs never touch `executionCount` and report
      `APPROVAL_UNKNOWN`; no fabricated success.
  11. The journal lives in `~/.winhelm/` which is a protected tree for every
      AI tool in **both** legacy and schema-v2 modes (see `1b5b089`).
- **`1b5b089`** — legacy `allowedDirectories:["*"]` compatibility preserved
  for ordinary paths; WinHelm config file, `~/.winhelm` data tree and log
  dir are denied read+write in legacy mode via the same canonicalizing rule
  matcher as schema-v2 (`canonicalizeExistingAware`, reparse-aware).
  Install-root rule intentionally stays schema-v2 only (documented v1.2.1
  workflow compatibility). Pinned by
  `test/unit/protected-paths-legacy-v2.test.ts`.
- **`80982a7`** — rotation persists the new 32-byte token atomically to
  `~/.winhelm/auth-token` **before** applying it live; startup precedence is
  `--auth` → store → legacy config field; an unreadable/invalid store is a
  fatal startup error (no silent weaker-credential fallback); every auth
  comparison reads the live token so rotation takes effect immediately;
  raw token never logged (verified against server + audit logs, §4).

## 3. Defects found

None. No code changes were required in this pass; therefore no fix commits
were created and the working tree carried no implementation diff.

## 4. Plaintext `authToken` deviation — CLOSED

Initial state (verified before any change): `winhelm.local.json` contained a
64-character plaintext `authToken`; no `~/.winhelm` store existed; the live
server (PID 61924, `node dist/index.js` built at HEAD) had resolved its
token from the config at startup.

Closure performed via the supported runtime path only:

1. Backed up the config to
   `temp/winhelm.local.json.pre-token-migration-20261004.json`
   (`temp/` is gitignored).
2. Rotated to a fresh 32-byte token using the shipping code
   (`generateAuthToken` + `writeStoredAuthToken` → `~/.winhelm/auth-token`,
   atomic write). Token material was never printed, copied or echoed.
3. Restarted the server. Verified by HTTP probe (status codes only):
   store token accepted; previous config token → **401** (store precedence).
4. Removed the plaintext `authToken` key from `winhelm.local.json`;
   verified the key and any token material are gone from the file.
5. Restarted again: store token still accepted; no-token request → 401.
6. Scanned `temp/server-*.log` and all 10 files in `logs/` for the raw
   token: not present.

The runtime now uses the protected secret store as the auth source of truth.
The old token is invalid. MCP client configs are unaffected by design
(the connect flow embeds one-time exchange tokens, not the master token).

## 5. Automated full checkpoint

All commands re-run fresh at HEAD in this session:

| Check | Result |
| --- | --- |
| `npm run type-check` | PASS |
| `npm run lint:tools` | PASS — 41 tools checked, metadata lint OK |
| `npm run build` | PASS |
| `npm test` | **553 tests / 128 suites / 553 pass / 0 fail / 0 skipped** |

Matches the reported implementation baseline exactly (no tests added or
removed; no code changed). AC evidence sweep was not re-run: no code
changed, existing AC evidence remains valid.

## 6. Remaining commits — risk-based review

Grouped review, no defects found:

- **Permission / filesystem / network** — `@alias` + single-folder relative
  resolution, `AMBIGUOUS_PATH`, protected paths, `file_list "."`, SSRF
  guards (per-hop redirect re-validation, credential stripping on
  cross-origin redirect, effective-port checks), `command_run` no-shell
  contract (`shell: false`, shell-metacharacter rejection, interpreter and
  `.cmd`-shim refusal), legacy/schema-v2 source-of-truth separation.
- **Approval / Admin / Dashboard** — approval dialog shows clientInfo, risk,
  target, folder+permission, expandable args, provenance, expiry;
  text-only rendering with sanitizer; CSRF + loopback-origin enforcement on
  every mutation route; admin session auth separate from MCP bearer auth;
  keyboard shortcuts (Enter/Escape) act only when **exactly one** job is
  pending (`pendingApprovalShortcuts.length !== 1` → no-op), so a shortcut
  can never approve/deny the wrong job.
- **Wizard / migration / client connection** — profile semantics preserved
  (non-governed settings retained; `2e67b33`), explicit legacy migration,
  Claude/Cursor config: preview → backup → atomic write, invalid JSON fails
  closed, other MCP servers preserved, no token embedding, absolute Node +
  entrypoint required before apply.
- **Audit / i18n / metadata** — approval decisions audited with latency,
  hashed session ids in the client list, permission changes recorded with
  from→to, audit events sanitized; English canonical + Thai parity; 41-tool
  metadata coverage enforced by `lint:tools`.

## 7. Manual RC smoke — `MANUAL_PENDING_OWNER`

Not fabricated: this session has no Claude Desktop / Cursor GUI client.
Checklist for the owner (each step: record PASS/FAIL + note):

### Claude Desktop
1. `node dist/index.js connect claude --dry-run` — inspect preview, confirm
   no token embedded, other MCP servers preserved.
2. Apply the connection (same command without `--dry-run`); confirm backup
   file created next to the Claude config.
3. Restart Claude Desktop; confirm WinHelm tool discovery (41 tools).
4. Call one read-only tool (e.g. `file_list`); expect normal result.
5. Call one approval-gated action (e.g. `process_kill` on an external PID
   such as a spawned `notepad.exe`); expect an approval prompt instead of
   execution.
6. Approve via Dashboard/Admin UI; confirm the action executes and the
   result returns to Claude.
7. Confirm provenance + clientInfo in the approval dialog are correct.
8. Repeat the same tool call with the same idempotency intent; confirm no
   duplicate execution (retry dedupes).

### Cursor
Repeat steps 1–8 with `connect cursor`.

### Safety smoke
- [ ] Denied approval → tool returns DENIED, no side effect.
- [ ] Expired approval (let TTL lapse) → tool returns EXPIRED, no side
      effect.
- [ ] External `process_kill` (PID not started by WinHelm) → approval
      required; owned PID (task started via WinHelm) → normal policy.
- [ ] Attempt (via an AI tool session) to read or write
      `winhelm.local.json`, `~/.winhelm/auth-token`,
      `~/.winhelm/approval-jobs.json` → `FOLDER_PROTECTED_PATH` denial.
- [ ] Old rotated token → 401 (already verified server-side in §4; re-check
      from a client if desired).
- [ ] New token → accepted; restart WinHelm → still accepted.

## 8. Non-blocking items (not v1.3 RC blockers)

Unchanged from the owner dispatch: Spike 0.3, hybrid timing experiment,
`count_tokens` without a provider tokenizer, SSE `/api/events`, full
Dashboard i18n, tray, `.mcpb`, dangerous mode, v1.4 work,
installer/signing/SBOM pending release decision/cert.

## 9. Git state

- No history rewrite; no force push; nothing squashed.
- Single RC preparation commit adds this readiness file (see `git log`).
- `HANDOFF_V1_3_AGENT_CONTINUATION_20261003.md` remains **untracked** by
  owner instruction (not committed).
- `winhelm.local.json` pre-migration backup kept at
  `temp/winhelm.local.json.pre-token-migration-20261004.json` (gitignored).

## 10. Disposition

**`V1_3_RC_READY_FOR_OWNER_MANUAL_SMOKE`**

The branch is RC-ready pending the owner-run manual smoke in §7. This is
not a release: no `RELEASED`/`FINAL`/`PRODUCTION_READY` claim and no
release tag.
