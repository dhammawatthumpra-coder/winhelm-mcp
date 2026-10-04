import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeObject } from "../utils/sanitizer.js";
import type { RecoverableApprovalJob } from "./approval-engine.js";
import { defaultApprovalJournalPath } from "./journal.js";

/**
 * Cross-process approval coordination (DEF-02).
 *
 * WinHelm's ApprovalEngine lives entirely inside the process that owns the
 * tool callbacks, so approval jobs created by stdio MCP clients (Claude
 * Desktop, Cursor, ...) are invisible to the Dashboard process. This module
 * adds a file-based coordination layer beside the existing durable journal:
 *
 * - `approval-requests/<jobId>.json` — written by the owning process when a
 *   job is queued and refreshed on every durable transition; removed when the
 *   job reaches a terminal state. Carries the sanitized public job plus
 *   owner-computed display metadata (clientInfo, risk, folder access) so the
 *   Dashboard renders the requesting client's own context.
 * - `approval-decisions/<jobId>.json` — written once (`wx`) by a deciding
 *   surface (Dashboard, local CLI). The first decision wins; a conflicting
 *   later decision is rejected at creation time. The owning process consumes
 *   the decision and applies it through its own engine, so the owning process
 *   remains the only executor and every existing fail-closed invariant
 *   (state checks, expiry, CAS claim, journal persistence) still applies.
 *
 * Both files live inside `~/.winhelm`, which is a same-user protected path;
 * the trust boundary is identical to the previous control pipe. Raw
 * idempotency keys and secrets never reach these files (sanitized public job
 * only). Decisions for jobs whose owner died are simply never consumed — no
 * other process can execute them — and are swept after a grace period.
 */

const REQUESTS_DIR = "approval-requests";
const DECISIONS_DIR = "approval-decisions";
const STATE_VERSION = 1;
/** Decision files for jobs nobody consumed are swept after this long. */
const STALE_DECISION_GRACE_MS = 60 * 60 * 1000;

export type CrossProcessDecision = "approved" | "denied";

export interface CrossProcessRequestRecord {
  version: number;
  job: RecoverableApprovalJob;
  instanceId: string;
  pid: number;
  /** Owner-computed display metadata (clientInfo, risk, folderAccess, ...). */
  display: Record<string, unknown>;
}

export interface CrossProcessDecisionRecord {
  version: number;
  jobId: string;
  decision: CrossProcessDecision;
  channel: string;
  decidedAt: number;
  instanceId: string;
}

let processInstanceId = crypto.randomUUID();

/** Stable identity of this WinHelm process instance (per run, not per boot). */
export function crossProcessInstanceId(): string {
  return processInstanceId;
}

/**
 * Best-effort owner liveness. `process.kill(pid, 0)` throws ESRCH when the
 * pid is gone; EPERM means the process exists but is not ours. Used only to
 * refuse decisions toward vanished owners — execution safety never depends
 * on it (a decision an owner never consumes can never execute anything).
 */
export function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Test hook: force a distinct instance identity. */
export function resetCrossProcessInstanceId(): void {
  processInstanceId = crypto.randomUUID();
}

export interface CrossProcessPaths {
  requestsDir: string;
  decisionsDir: string;
}

export function crossProcessPaths(
  journalPath: string = defaultApprovalJournalPath()
): CrossProcessPaths {
  const base = path.dirname(path.resolve(journalPath));
  return {
    requestsDir: path.join(base, REQUESTS_DIR),
    decisionsDir: path.join(base, DECISIONS_DIR),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJsonFile(
  target: string,
  payload: unknown,
  exclusive: boolean
): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}-${crypto
      .randomUUID()
      .slice(0, 8)}.tmp`
  );
  const content = JSON.stringify(payload, null, 2);
  let handle: number | undefined;
  try {
    // `wx` makes decision creation a first-writer-wins atomic transition.
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, content, { encoding: "utf8" });
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (err) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Original failure is the one worth reporting.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort.
    }
    throw err;
  }
  try {
    if (exclusive) {
      // renameSync clobbers by default; exclusive creation needs the final
      // file to not exist. link + unlink is the portable atomic create.
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
  } catch (err) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort.
    }
    throw err;
  }
}

function readJsonFile<T>(target: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeJobId(jobId: string): string | null {
  // Only ever derived from engine-generated ids; guards against traversal
  // should an untrusted id ever reach this layer.
  return /^job_[A-Za-z0-9-]+$/.test(jobId) ? jobId : null;
}

const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "denied",
  "expired",
  "cancelled",
  "unknown",
]);

/** True when a job state is final and will not transition again. */
export function isTerminalJobState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Mirror a durable job transition into the shared request state. Called from
 * the same choke point as the journal write, so the mirror only ever reflects
 * a transition that is already durable in the journal. The mirror file is
 * single-writer (the owning process); deciding surfaces only read it, which
 * is why it — not the whole-file journal — is the authoritative cross-process
 * view. Terminal jobs keep their final state for a grace period (a deciding
 * surface must be able to observe the outcome) and are removed later by the
 * stale sweep. A mirror failure is advisory (the journal remains the
 * execution safety net) and must not break the owning flow.
 */
export function mirrorRequest(
  job: RecoverableApprovalJob,
  display: Record<string, unknown>,
  journalPath: string = defaultApprovalJournalPath()
): void {
  const id = safeJobId(job.id);
  if (!id) return;
  const { requestsDir } = crossProcessPaths(journalPath);
  const target = path.join(requestsDir, `${id}.json`);
  try {
    writeJsonFile(
      target,
      {
        version: STATE_VERSION,
        job: sanitizeObject(job as unknown as Record<string, unknown>),
        instanceId: crossProcessInstanceId(),
        pid: process.pid,
        display: sanitizeObject(display),
      },
      false
    );
  } catch {
    // Advisory visibility only; the journal remains authoritative.
  }
}

export function readRequest(
  jobId: string,
  journalPath: string = defaultApprovalJournalPath()
): CrossProcessRequestRecord | null {
  const id = safeJobId(jobId);
  if (!id) return null;
  const { requestsDir } = crossProcessPaths(journalPath);
  const raw = readJsonFile<Record<string, unknown>>(
    path.join(requestsDir, `${id}.json`)
  );
  if (!isRecord(raw) || raw.version !== STATE_VERSION || !isRecord(raw.job)) {
    return null;
  }
  return raw as unknown as CrossProcessRequestRecord;
}

/**
 * List pending jobs mirrored by OTHER WinHelm instances. Records belonging to
 * this instance are skipped (its own engine already knows them).
 */
export function listForeignRequests(
  journalPath: string = defaultApprovalJournalPath()
): CrossProcessRequestRecord[] {
  const { requestsDir } = crossProcessPaths(journalPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(requestsDir);
  } catch {
    return [];
  }
  const records: CrossProcessRequestRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = readJsonFile<Record<string, unknown>>(
      path.join(requestsDir, entry)
    );
    if (
      !isRecord(record) ||
      record.version !== STATE_VERSION ||
      !isRecord(record.job)
    ) {
      continue;
    }
    if (record.instanceId === crossProcessInstanceId()) continue;
    records.push(record as unknown as CrossProcessRequestRecord);
  }
  return records;
}

export type DecisionWriteOutcome =
  | { ok: true }
  | { ok: false; code: "ALREADY_DECIDED"; existing: CrossProcessDecision };

/**
 * Record a decision for a job owned by another process. First decision wins:
 * a second, conflicting decision file cannot be created. A repeat of the
 * same decision is reported as already-decided so retries stay idempotent.
 */
export function writeDecision(
  jobId: string,
  decision: CrossProcessDecision,
  channel: string,
  journalPath: string = defaultApprovalJournalPath()
): DecisionWriteOutcome {
  const id = safeJobId(jobId);
  if (!id) return { ok: false, code: "ALREADY_DECIDED", existing: "denied" };
  const { decisionsDir } = crossProcessPaths(journalPath);
  const target = path.join(decisionsDir, `${id}.json`);
  const existing = readJsonFile<CrossProcessDecisionRecord>(target);
  if (existing && existing.version === STATE_VERSION) {
    return existing.decision === decision
      ? { ok: true }
      : { ok: false, code: "ALREADY_DECIDED", existing: existing.decision };
  }
  writeJsonFile(
    target,
    {
      version: STATE_VERSION,
      jobId: id,
      decision,
      channel,
      decidedAt: Date.now(),
      instanceId: crossProcessInstanceId(),
    },
    true
  );
  return { ok: true };
}

/**
 * Apply decisions addressed to jobs this process owns. `apply` is invoked
 * with (jobId, decision) for every decision whose job is known locally;
 * consumed decisions are removed afterwards. Decision files for unknown jobs
 * (other instances) are left untouched. Applies must go through the local
 * engine so every existing guard (state, expiry, CAS claim, journal
 * durability, audit) runs unchanged.
 */
export function consumeOwnedDecisions(
  owns: (jobId: string) => boolean,
  apply: (jobId: string, decision: CrossProcessDecision) => void,
  journalPath: string = defaultApprovalJournalPath()
): void {
  const { decisionsDir } = crossProcessPaths(journalPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(decisionsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = readJsonFile<CrossProcessDecisionRecord>(
      path.join(decisionsDir, entry)
    );
    if (
      !isRecord(record) ||
      record.version !== STATE_VERSION ||
      typeof record.jobId !== "string" ||
      (record.decision !== "approved" && record.decision !== "denied")
    ) {
      // Unreadable/foreign-format files: leave them for the sweep.
      continue;
    }
    if (!owns(record.jobId)) continue;
    try {
      apply(record.jobId, record.decision);
    } finally {
      try {
        fs.unlinkSync(path.join(decisionsDir, entry));
      } catch {
        // If unlink fails the apply is re-run later; every engine guard makes
        // that idempotent (non-awaiting jobs cannot transition again).
      }
    }
  }
}

/**
 * Read one job's current durable state straight from the shared journal.
 * Single attempt: transient IO errors (another process is mid atomic-replace
 * of the journal) yield null, and async callers retry on their own cadence.
 */
export function readJournalJob(
  jobId: string,
  journalPath: string = defaultApprovalJournalPath()
): RecoverableApprovalJob | null {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    return jobs.find((job: any) => job && job.id === jobId) ?? null;
  } catch {
    // Genuinely corrupt/unreadable content: fail closed.
    return null;
  }
}

const JOURNAL_RETRY_CODES = new Set(["ENOENT", "EPERM", "EACCES", "EBUSY"]);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Async variant that rides out transient IO errors while other processes
 * atomically replace the shared journal. A genuine parse failure (corrupt
 * content) still returns null immediately so callers fail closed.
 */
export async function readJournalJobReliable(
  jobId: string,
  journalPath: string = defaultApprovalJournalPath(),
  attempts = 12,
  delayMs = 75
): Promise<RecoverableApprovalJob | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let raw: string | null = null;
    let transientFailure = false;
    try {
      raw = fs.readFileSync(journalPath, "utf8");
    } catch (err) {
      transientFailure = JOURNAL_RETRY_CODES.has(
        (err as NodeJS.ErrnoException).code ?? ""
      );
    }
    if (!transientFailure && raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
        return jobs.find((job: any) => job && job.id === jobId) ?? null;
      } catch {
        return null;
      }
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return null;
}

/**
 * Bounded wait for the owning process to observe a recorded decision and
 * drive the job to a terminal state (or past expiry). Polls the owner's
 * per-job mirror (single-writer, race-free) first and the shared journal as
 * a fallback. Resolves with the latest known state, or null on timeout.
 */
export function waitForCrossProcessOutcome(
  jobId: string,
  timeoutMs: number,
  journalPath: string = defaultApprovalJournalPath()
): Promise<RecoverableApprovalJob | null> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      const mirror = readRequest(jobId, journalPath);
      const job = mirror?.job ?? readJournalJob(jobId, journalPath);
      if (job && TERMINAL_STATES.has(job.state)) {
        resolve(job);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(job);
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

/**
 * Opportunistic cleanup: decision files nobody consumed (owner died) and
 * pending-job mirrors whose owner vanished long ago are removed after a
 * grace period. Purely hygienic — a stale decision can never execute
 * anything because only the owning process applies decisions.
 */
export function sweepStaleCrossProcessState(
  journalPath: string = defaultApprovalJournalPath()
): void {
  const { requestsDir, decisionsDir } = crossProcessPaths(journalPath);
  const cutoff = Date.now() - STALE_DECISION_GRACE_MS;
  for (const dir of [requestsDir, decisionsDir]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const target = path.join(dir, entry);
      try {
        const stat = fs.statSync(target);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(target);
      } catch {
        // Best effort.
      }
    }
  }
}
