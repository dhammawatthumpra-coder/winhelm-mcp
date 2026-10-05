/**
 * Spec 3.4 A4 — server-owned durable run manager.
 *
 * The MCP session holds authorization; THIS manager owns the native Job
 * Object handle through the promoted native boundary:
 * - durable opaque run_id per launch;
 * - MCP session disconnect never cancels a running command;
 * - server lifetime owns every contained process (server termination closes
 *   the job tree);
 * - startup reconciliation marks previously-running records aborted/unknown
 *   and never replays them;
 * - command_wait is a non-cancelling wait with session ownership enforced.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  GovernedContainedProcess,
} from "../../native/index.js";

export type RunState = "running" | "exited" | "timed_out" | "aborted";

export interface RunRecord {
  run_id: string;
  session_id: string;
  command: string;
  started_at_utc: string;
  state: RunState;
  ended_at_utc?: string;
  exit_code?: number;
  timed_out?: boolean;
}

export interface RunFinalResult {
  run_id: string;
  status: "exited";
  exit_code: number;
  timed_out: boolean;
  started_at_utc: string;
  ended_at_utc: string;
  wall_seconds: number;
  stdout: string;
  stdout_bytes: number;
  stdout_truncated: boolean;
  stdout_sha256: string | null;
  stderr: string;
  stderr_bytes: number;
  stderr_truncated: boolean;
  stderr_sha256: string | null;
  peak_rss_bytes: number | null;
}

export interface LiveRun extends RunRecord {
  native: GovernedContainedProcess;
  settlement: Promise<"exited" | "timeout">;
  settle: (outcome: "exited" | "timeout") => void;
  exitCodeFromWait?: number;
  /** Set by the sync timeout path before terminate(). */
  timedOut?: boolean;
  finalized?: boolean;
  finalRecord?: RunRecord;
}

export function defaultRunJournalPath(): string {
  return path.join(os.homedir(), ".winhelm", "run-journal.jsonl");
}

let journalPathOverride: string | undefined;

/** Test-only seam; production callers never set this. */
export function setRunJournalPathForTesting(journalPath: string | undefined): void {
  journalPathOverride = journalPath;
}

export function runJournalPath(): string {
  return journalPathOverride ?? defaultRunJournalPath();
}

export class RunManager {
  private readonly live = new Map<string, LiveRun>();
  private readonly finished = new Map<string, RunRecord>();
  private readonly finalResults = new Map<string, RunFinalResult>();
  private static readonly MAX_RETAINED_FINAL_RESULTS = 256;

  /**
   * Startup reconciliation: journal records still marked `running` belonged
   * to a previous server process whose termination closed the Job handles
   * (or whose runs were killed with it). They become aborted/unknown and are
   * never replayed.
   */
  async reconcileFromJournal(): Promise<number> {
    const journalFile = runJournalPath();
    const records: RunRecord[] = [];
    let reconciledCount = 0;
    if (existsSync(journalFile)) {
      try {
        const raw = await fs.readFile(journalFile, "utf8");
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as RunRecord;
            if (
              parsed &&
              typeof parsed.run_id === "string" &&
              typeof parsed.state === "string"
            ) {
              if (parsed.state === "running") {
                parsed.state = "aborted";
                reconciledCount += 1;
              }
              records.push(parsed);
            }
          } catch {
            // A corrupted line never fabricates a run record.
          }
        }
      } catch {
        // An unreadable journal contributes no records (fail-closed honesty).
      }
    }

    await this.writeJournal(records);
    for (const record of records) {
      this.finished.set(record.run_id, record);
    }
    return reconciledCount;
  }

  private async writeJournal(records: RunRecord[]): Promise<void> {
    const journalFile = runJournalPath();
    await fs.mkdir(path.dirname(journalFile), { recursive: true });
    const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await fs.writeFile(journalFile, body, "utf8");
  }

  private async appendJournalRecord(record: RunRecord): Promise<void> {
    const journalFile = runJournalPath();
    await fs.mkdir(path.dirname(journalFile), { recursive: true });
    await fs.appendFile(journalFile, JSON.stringify(record) + "\n", "utf8");
  }

  registerLaunch(input: {
    sessionId: string;
    command: string;
    native: GovernedContainedProcess;
  }): LiveRun {
    const runId = `run_${randomBytes(6).toString("hex")}`;
    const startedAtUtc = new Date().toISOString();

    let settle!: (outcome: "exited" | "timeout") => void;
    const settlement = new Promise<"exited" | "timeout">((resolve) => {
      settle = resolve;
    });

    const record: RunRecord = {
      run_id: runId,
      session_id: input.sessionId,
      command: input.command,
      started_at_utc: startedAtUtc,
      state: "running",
    };

    const live: LiveRun = {
      ...record,
      native: input.native,
      settlement,
      settle,
    };
    this.live.set(runId, live);
    void this.appendJournalRecord(record).catch(() => {
      // Journal failures never abort a governed run; the in-memory record
      // stays authoritative for this process lifetime.
    });

    // Server-owned settlement watcher. The INFINITE sentinel value is an
    // internal-only NB1 wait boundary; it never crosses a public API here.
    // The watcher is the single source of truth for completion: it
    // finalizes the record (journal + maps) exactly once for every run.
    void input.native.waitAsync(4_294_967_295).then((result) => {
      if (result.status === "exited") {
        live.exitCodeFromWait = result.exitCode;
      }
      settle(result.status === "exited" ? "exited" : "timeout");
      this.finalizeRun(live);
    });

    return live;
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  getLive(runId: string): LiveRun | undefined {
    return this.live.get(runId);
  }

  getFinished(runId: string): RunRecord | undefined {
    return this.finished.get(runId);
  }

  requireOwnedRun(runId: string, sessionId: string): LiveRun | RunRecord {
    const live = this.live.get(runId);
    if (live) {
      if (live.session_id !== sessionId) {
        throw new RunOwnershipError();
      }
      return live;
    }
    const finished = this.finished.get(runId);
    if (finished) {
      if (finished.session_id !== sessionId) {
        throw new RunOwnershipError();
      }
      return finished;
    }
    throw new RunNotFoundError();
  }

  /**
   * Idempotent completion transition. `timedOut` is read from the live run
   * (set by the sync timeout path before terminate) so the journal records
   * the honest terminal state.
   */
  private finalizeRun(run: LiveRun): RunRecord {
    if (run.finalized) return run.finalRecord!;
    run.finalized = true;
    const endedAtUtc = new Date().toISOString();
    const timedOut = run.timedOut === true;
    const record: RunRecord = {
      run_id: run.run_id,
      session_id: run.session_id,
      command: run.command,
      started_at_utc: run.started_at_utc,
      state: timedOut ? "timed_out" : "exited",
      ended_at_utc: endedAtUtc,
      ...(run.exitCodeFromWait !== undefined
        ? { exit_code: run.exitCodeFromWait }
        : {}),
      timed_out: timedOut,
    };
    run.finalRecord = record;
    // Capture the full stream result while the native object is still final.
    const finalResult = this.collectFinalResult(run);
    this.finalResults.set(record.run_id, finalResult);
    if (this.finalResults.size > RunManager.MAX_RETAINED_FINAL_RESULTS) {
      const oldest = this.finalResults.keys().next().value;
      if (oldest !== undefined) this.finalResults.delete(oldest);
    }
    this.live.delete(run.run_id);
    this.finished.set(record.run_id, record);
    void this.appendJournalRecord(record).catch(() => {});
    return record;
  }

  /**
   * Full final result for a settled run: the retained capture when
   * available, otherwise recomputed from the live native object.
   */
  async getFinalResult(run: LiveRun): Promise<RunFinalResult> {
    const retained = this.finalResults.get(run.run_id);
    if (retained) return retained;
    return this.collectFinalResult(run);
  }

  getStoredFinalResult(runId: string): RunFinalResult | undefined {
    return this.finalResults.get(runId);
  }

  /**
   * Non-cancelling wait: resolves to the final result when the run settles
   * within timeoutMs, otherwise reports still_running WITHOUT killing,
   * cancelling, or mutating run state. Later waits remain valid.
   */
  async waitForRun(run: LiveRun, timeoutMs: number): Promise<RunFinalResult | { status: "still_running"; run_id: string; started_at_utc: string }> {
    let resolveWaitTimer!: (value: "wait-timeout") => void;
    const timerPromise = new Promise<"wait-timeout">((resolve) => {
      resolveWaitTimer = resolve;
    });
    const timer = setTimeout(() => resolveWaitTimer("wait-timeout"), timeoutMs);
    timer.unref?.();
    const settled = await Promise.race([
      run.settlement.then((outcome) => ({ outcome })),
      timerPromise,
    ]);
    clearTimeout(timer);

    if (settled === "wait-timeout") {
      return {
        status: "still_running",
        run_id: run.run_id,
        started_at_utc: run.started_at_utc,
      };
    }

    return this.getFinalResult(run);
  }

  collectFinalResult(run: LiveRun): RunFinalResult {
    const native = run.native;
    const endedAtUtc = new Date().toISOString();
    const stdoutState = native.streamState("stdout");
    const stderrState = native.streamState("stderr");
    const stdoutCapture = native.streamCapture("stdout");
    const stderrCapture = native.streamCapture("stderr");

    let peakRss: number | null = null;
    try {
      peakRss = native.peakRss();
    } catch {
      peakRss = null;
    }

    const startedMs = Date.parse(run.started_at_utc);
    const endedMs = Date.parse(endedAtUtc);
    const wallSeconds = Number.isFinite(startedMs)
      ? Math.max(0, (endedMs - startedMs) / 1000)
      : 0;

    return {
      run_id: run.run_id,
      status: "exited",
      exit_code: run.exitCodeFromWait ?? 0,
      timed_out: run.timedOut === true,
      started_at_utc: run.started_at_utc,
      ended_at_utc: endedAtUtc,
      wall_seconds: wallSeconds,
      stdout: stdoutCapture.toString("utf8"),
      stdout_bytes: stdoutState.totalBytes,
      stdout_truncated: stdoutState.truncated,
      stdout_sha256: stdoutState.sha256,
      stderr: stderrCapture.toString("utf8"),
      stderr_bytes: stderrState.totalBytes,
      stderr_truncated: stderrState.truncated,
      stderr_sha256: stderrState.sha256,
      peak_rss_bytes: peakRss,
    };
  }

  /** Terminate one contained run (sync command_run timeout path). */
  terminate(run: LiveRun, exitCode = 1): void {
    try {
      run.native.terminate(exitCode);
    } catch {
      // The native Job containment still owns the tree; a failed terminate
      // is resolved by finalization below.
    }
  }

  /** Server shutdown: close every contained process tree. */
  shutdownAll(): void {
    for (const run of this.live.values()) {
      this.terminate(run);
    }
    for (const run of this.live.values()) {
      try {
        run.native.close();
      } catch {
        // close() is best-effort; Job kill-on-close covers the tree.
      }
    }
    this.live.clear();
  }
}

export class RunNotFoundError extends Error {
  constructor() {
    super("The requested run_id was not found in this server's run manager.");
    this.name = "RunNotFoundError";
  }
}

export class RunOwnershipError extends Error {
  constructor() {
    super("The current session does not own the requested run_id.");
    this.name = "RunOwnershipError";
  }
}

let defaultManager: RunManager | null = null;

export function getRunManager(): RunManager {
  if (!defaultManager) defaultManager = new RunManager();
  return defaultManager;
}

export function resetRunManager(): void {
  if (defaultManager) defaultManager.shutdownAll();
  defaultManager = new RunManager();
}

/**
 * Startup reconciliation entry point for the server process.
 */
export async function initializeRunManager(): Promise<number> {
  return getRunManager().reconcileFromJournal();
}
