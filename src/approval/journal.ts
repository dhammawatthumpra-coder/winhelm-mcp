import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeObject } from "../utils/sanitizer.js";
import type { RecoverableApprovalJob } from "./approval-engine.js";

const JOURNAL_VERSION = 1;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

const KNOWN_STATES = new Set([
  "awaiting_approval",
  "approved",
  "running",
  "completed",
  "failed",
  "denied",
  "expired",
  "cancelled",
  "unknown",
]);

export type ApprovalJournalIntegrityFailure = "corrupt" | "unreadable";

export interface ApprovalJournalLoadResult {
  jobs: RecoverableApprovalJob[];
  /**
   * `null` only when the snapshot was absent (clean first run) or fully valid.
   * Restart recovery must fail closed when this is set.
   */
  integrityFailure: ApprovalJournalIntegrityFailure | null;
  quarantinedPath: string | null;
}

export interface ApprovalJournalOptions {
  retentionMs?: number;
  maxEntries?: number;
}

/**
 * Durable approval journal location. The default sits inside the WinHelm data
 * directory, which is a protected path for every AI tool (read and write).
 */
export function defaultApprovalJournalPath(): string {
  const override = process.env.WINHELM_APPROVAL_JOURNAL_PATH;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), ".winhelm", "approval-jobs.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecoverableJob(value: unknown): value is RecoverableApprovalJob {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.tool !== "string") return false;
  if (typeof value.fingerprint !== "string") return false;
  if (typeof value.sessionId !== "string") return false;
  if (typeof value.state !== "string" || !KNOWN_STATES.has(value.state)) {
    return false;
  }
  for (const field of [
    "createdAt",
    "expiresAt",
    "updatedAt",
    "executionCount",
  ]) {
    if (
      typeof value[field] !== "number" ||
      !Number.isFinite(value[field] as number)
    ) {
      return false;
    }
  }
  return isRecord(value.args);
}

/**
 * Strip credentials before anything reaches disk. `sanitizeObject` also
 * sanitizes nested string values, so inline `Bearer ...`/`--password ...`
 * material is masked as well.
 */
function redactedJob(
  job: RecoverableApprovalJob
): RecoverableApprovalJob {
  return {
    ...job,
    args: sanitizeObject(job.args ?? {}),
    ...(job.result === undefined
      ? {}
      : { result: sanitizeObject(job.result) }),
    ...(job.error === undefined
      ? {}
      : { error: sanitizeObject(job.error) }),
  };
}

function renameReplacingSync(
  source: string,
  destination: string,
  attempts = 8
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      const transient =
        process.platform === "win32" &&
        TRANSIENT_RENAME_CODES.has(code);
      if (!transient || attempt >= attempts - 1) throw err;
    }
  }
}

/**
 * Synchronous atomic replace: temp file in the destination directory, fsync,
 * then rename. Persistence is synchronous on purpose so an approval transition
 * can refuse to proceed when the record is not durable yet.
 */
function writeAtomicSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const temporary = path.join(
    dir,
    `.${path.basename(targetPath)}.winhelm-${process.pid}-${randomUUID()}.tmp`
  );

  let handle: number | undefined;
  try {
    handle = fs.openSync(temporary, "wx");
    fs.writeFileSync(handle, content, { encoding: "utf8" });
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (err) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort cleanup of the temp file.
    }
    throw err;
  }

  try {
    renameReplacingSync(temporary, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort cleanup of the temp file.
    }
    throw err;
  }
}

/**
 * Snapshot journal for approval jobs.
 *
 * A missing file is a clean first run. A file that cannot be read or trusted is
 * never reported as "no jobs": it is quarantined (evidence preserved) and
 * reported as an integrity failure so the caller can fail closed.
 */
export class ApprovalJournal {
  private readonly filePath: string;
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private readonly snapshots = new Map<
    string,
    RecoverableApprovalJob
  >();

  constructor(
    filePath: string = defaultApprovalJournalPath(),
    options: ApprovalJournalOptions = {}
  ) {
    this.filePath = path.resolve(filePath);
    this.retentionMs = Math.max(
      0,
      options.retentionMs ?? DEFAULT_RETENTION_MS
    );
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  public get path(): string {
    return this.filePath;
  }

  public load(): ApprovalJournalLoadResult {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          jobs: [],
          integrityFailure: null,
          quarantinedPath: null,
        };
      }
      return {
        jobs: [],
        integrityFailure: "unreadable",
        quarantinedPath: null,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.quarantine();
    }

    if (
      !isRecord(parsed) ||
      parsed.version !== JOURNAL_VERSION ||
      !Array.isArray(parsed.jobs) ||
      !parsed.jobs.every(isRecoverableJob)
    ) {
      return this.quarantine();
    }

    const jobs = parsed.jobs as RecoverableApprovalJob[];
    this.snapshots.clear();
    for (const job of jobs) {
      this.snapshots.set(job.id, job);
    }

    return { jobs, integrityFailure: null, quarantinedPath: null };
  }

  /**
   * Make one job transition durable. Throws when the record cannot be written,
   * which the engine treats as "do not execute".
   */
  public persist(job: RecoverableApprovalJob): void {
    this.snapshots.set(job.id, redactedJob(job));
    writeAtomicSync(this.filePath, this.serialize());
  }

  public size(): number {
    return this.snapshots.size;
  }

  private serialize(): string {
    const now = Date.now();
    const retained = [...this.snapshots.values()]
      .filter((job) => now - job.updatedAt <= this.retentionMs)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, this.maxEntries);

    this.snapshots.clear();
    for (const job of retained) {
      this.snapshots.set(job.id, job);
    }

    return JSON.stringify(
      { version: JOURNAL_VERSION, jobs: retained },
      null,
      2
    );
  }

  private quarantine(): ApprovalJournalLoadResult {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${this.filePath}.corrupt-${stamp}`;
    let quarantinedPath: string | null = null;

    try {
      fs.renameSync(this.filePath, target);
      quarantinedPath = target;
    } catch {
      // Losing the quarantine rename must not downgrade the verdict.
    }

    this.snapshots.clear();
    return { jobs: [], integrityFailure: "corrupt", quarantinedPath };
  }
}
