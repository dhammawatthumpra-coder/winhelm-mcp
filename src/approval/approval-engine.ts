import crypto from "node:crypto";

export type ApprovalJobState =
  | "awaiting_approval"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "expired"
  | "cancelled"
  | "unknown";

export interface ApprovalJob<T = unknown> {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  fingerprint: string;
  sessionId: string;
  requestId?: string | number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  state: ApprovalJobState;
  executionCount: number;
  result?: T;
  error?: string;
}

export interface ApprovalRequest<T = unknown> {
  tool: string;
  args: Record<string, unknown>;
  /**
   * Canonical args used for retry fingerprinting/dedupe. Defaults to `args`.
   * Callers that add non-deterministic display metadata (for example probed
   * process identity) must pass the caller's original args here, otherwise an
   * equivalent retry would compute a different fingerprint and could execute
   * the same irreversible action twice.
   */
  fingerprintArgs?: Record<string, unknown>;
  sessionId: string;
  requestId?: string | number;
  ttlMs: number;
  maxPending: number;
  execute: () => Promise<T>;
}

export type ApprovalRequestOutcome<T = unknown> =
  | { kind: "created"; job: ApprovalJob<T> }
  | { kind: "deduped_pending"; job: ApprovalJob<T> }
  | { kind: "recent_equivalent"; job: ApprovalJob<T> };

export type ApprovalTransitionOutcome<T = unknown> =
  | { ok: true; job: ApprovalJob<T> }
  | { ok: false; status: 404 | 409 | 503; code: string; job?: ApprovalJob<T> };

export type ApprovalWaitOutcome<T = unknown> =
  | { kind: "terminal"; job: ApprovalJob<T> }
  | { kind: "receipt"; job: ApprovalJob<T> };

export interface RecoverableApprovalJob<T = unknown> extends ApprovalJob<T> {
  idempotencyKeyDigest?: string;
}

interface InternalJob<T = unknown> extends ApprovalJob<T> {
  executeFn: () => Promise<T>;
  idempotencyKeyDigest?: string;
}

export interface ApprovalEngineOptions {
  now?: () => number;
  retryRetentionMs?: number;
  persist?: (job: RecoverableApprovalJob) => void;
  /**
   * Set when the durable journal could not be trusted at startup. Creating new
   * approval jobs is then refused, because retry protection cannot be
   * guaranteed while earlier transitions are unreadable.
   */
  journalIntegrityFailed?: boolean;
}

const TERMINAL_STATES = new Set<ApprovalJobState>([
  "completed",
  "failed",
  "denied",
  "expired",
  "cancelled",
  "unknown",
]);

function isTerminal(state: ApprovalJobState): boolean {
  return TERMINAL_STATES.has(state);
}

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForFingerprint);
  }

  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (key.toLowerCase() === "idempotencykey") continue;
      output[key] = normalizeForFingerprint(input[key]);
    }
    return output;
  }

  if (typeof value === "string") {
    return value.normalize("NFKC");
  }

  return value;
}

export function approvalRequestFingerprint(
  tool: string,
  args: Record<string, unknown>
): string {
  const canonical = JSON.stringify({
    tool: tool.normalize("NFKC"),
    args: normalizeForFingerprint(args),
  });

  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function publicJob<T>(job: InternalJob<T>): ApprovalJob<T> {
  const {
    executeFn: _executeFn,
    idempotencyKeyDigest: _idempotencyKeyDigest,
    ...visible
  } = job;
  const args = structuredClone(visible.args);
  // The client idempotency key is used internally for lookup only. Keeping the
  // digest is enough for recovery, so the raw value never reaches an API
  // payload, a dashboard response or the on-disk journal.
  for (const key of Object.keys(args)) {
    if (key.toLowerCase() === "idempotencykey") delete args[key];
  }
  return {
    ...visible,
    args,
  };
}

function recoverableJob<T>(job: InternalJob<T>): RecoverableApprovalJob<T> {
  return {
    ...publicJob(job),
    idempotencyKeyDigest: job.idempotencyKeyDigest,
  };
}

function optionalIdempotencyDigest(
  args: Record<string, unknown>
): string | undefined {
  const value = args.idempotencyKey;
  if (typeof value !== "string" || value.length === 0) return undefined;
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * In-memory approval state machine.
 *
 * JavaScript state changes are performed synchronously before any await, so
 * approved -> running acts as the compare-and-set claim for one process.
 * Durable journal/restart recovery is layered on top later; this engine never
 * auto-reruns a job.
 */
export class ApprovalEngine {
  private readonly jobs = new Map<string, InternalJob<any>>();
  private readonly now: () => number;
  private readonly retryRetentionMs: number;
  private readonly persist?: (job: RecoverableApprovalJob) => void;
  private readonly journalIntegrityFailed: boolean;

  constructor(options: ApprovalEngineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.retryRetentionMs = options.retryRetentionMs ?? 60_000;
    this.persist = options.persist;
    this.journalIntegrityFailed = options.journalIntegrityFailed ?? false;
  }

  request<T>(request: ApprovalRequest<T>): ApprovalRequestOutcome<T> {
    if (this.journalIntegrityFailed) {
      throw new ApprovalEngineError(
        "JOURNAL_INTEGRITY_FAILED",
        "The approval journal could not be trusted after restart; new approval-gated actions are refused until it is repaired."
      );
    }

    this.expireDueJobs();
    this.pruneRecentHistory();

    const now = this.now();
    const fingerprint = approvalRequestFingerprint(
      request.tool,
      request.fingerprintArgs ?? request.args
    );

    const sameSessionPending = [...this.jobs.values()]
      .filter(
        (job) =>
          job.sessionId === request.sessionId &&
          job.fingerprint === fingerprint &&
          job.state === "awaiting_approval"
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0] as
      | InternalJob<T>
      | undefined;

    if (sameSessionPending) {
      return {
        kind: "deduped_pending",
        job: publicJob(sameSessionPending),
      };
    }

    const recentEquivalent = [...this.jobs.values()]
      .filter(
        (job) =>
          job.fingerprint === fingerprint &&
          now - job.updatedAt <= this.retryRetentionMs
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] as
      | InternalJob<T>
      | undefined;

    if (recentEquivalent) {
      return {
        kind: "recent_equivalent",
        job: publicJob(recentEquivalent),
      };
    }

    const pendingCount = [...this.jobs.values()].filter(
      (job) => job.state === "awaiting_approval"
    ).length;

    if (pendingCount >= request.maxPending) {
      throw new ApprovalEngineError(
        "LIMIT_EXCEEDED",
        `Maximum pending approval jobs reached (${request.maxPending}).`
      );
    }

    const id = `job_${crypto.randomUUID()}`;
    const job: InternalJob<T> = {
      id,
      tool: request.tool,
      args: structuredClone(request.args),
      fingerprint,
      sessionId: request.sessionId,
      requestId: request.requestId,
      createdAt: now,
      expiresAt: now + request.ttlMs,
      updatedAt: now,
      state: "awaiting_approval",
      executionCount: 0,
      executeFn: request.execute,
      idempotencyKeyDigest: optionalIdempotencyDigest(request.args),
    };

    this.jobs.set(job.id, job);
    try {
      this.persistJob(job);
    } catch (err) {
      this.jobs.delete(job.id);
      throw new ApprovalEngineError(
        "JOURNAL_UNAVAILABLE",
        "Approval journal write failed; the action was not queued."
      );
    }
    return { kind: "created", job: publicJob(job) };
  }

  restoreRecoveredJobs(jobs: RecoverableApprovalJob[]): void {
    const now = this.now();

    for (const recovered of jobs) {
      const interrupted =
        recovered.state === "awaiting_approval" ||
        recovered.state === "approved" ||
        recovered.state === "running";
      const recoveredState = interrupted
        ? "unknown"
        : recovered.state;

      const job: InternalJob = {
        ...structuredClone(recovered),
        state: recoveredState,
        updatedAt: interrupted
          ? Math.max(recovered.updatedAt, now)
          : recovered.updatedAt,
        ...(interrupted
          ? {
              error:
                "WinHelm restarted before this approval job reached a recorded outcome; the result is unknown and the action was not re-run.",
            }
          : {}),
        executeFn: async () => {
          throw new Error("Recovered approval jobs cannot be auto-executed.");
        },
        idempotencyKeyDigest: recovered.idempotencyKeyDigest,
      };

      this.jobs.set(job.id, job);
    }
  }

  get(jobId: string): ApprovalJob | undefined {
    this.expireDueJobs();
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : undefined;
  }

  getForSession(jobId: string, sessionId: string): ApprovalJob | undefined {
    const job = this.get(jobId);
    if (!job || job.sessionId !== sessionId) return undefined;
    return job;
  }

  findForSessionByIdempotencyKey(
    idempotencyKey: string,
    sessionId: string
  ): ApprovalJob | undefined {
    this.expireDueJobs();
    const match = [...this.jobs.values()]
      .filter(
        (job) =>
          job.sessionId === sessionId &&
          (job.args.idempotencyKey === idempotencyKey ||
            job.idempotencyKeyDigest ===
              crypto.createHash("sha256").update(idempotencyKey, "utf8").digest("hex"))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return match ? publicJob(match) : undefined;
  }

  list(): ApprovalJob[] {
    this.expireDueJobs();
    return [...this.jobs.values()]
      .map((job) => publicJob(job))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  approve(jobId: string): ApprovalTransitionOutcome {
    this.expireDueJobs();
    const job = this.jobs.get(jobId);
    if (!job) {
      return { ok: false, status: 404, code: "NOT_FOUND" };
    }
    if (job.state !== "awaiting_approval") {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        job: publicJob(job),
      };
    }

    job.state = "approved";
    job.updatedAt = this.now();
    try {
      this.persistJob(job);
    } catch {
      return this.journalUnavailable(job);
    }

    void this.executeApproved(job);

    // The executor claims the job (approved -> running) and writes the
    // pre-execution record synchronously before this line. A journal failure
    // there must be reported as a failed approval, never as success.
    if (this.claimWasRefused(job)) {
      return this.journalUnavailable(job);
    }

    return { ok: true, job: publicJob(job) };
  }

  deny(jobId: string): ApprovalTransitionOutcome {
    return this.transitionAwaitingToTerminal(jobId, "denied");
  }

  cancel(jobId: string): ApprovalTransitionOutcome {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { ok: false, status: 404, code: "NOT_FOUND" };
    }

    if (job.state !== "awaiting_approval" && job.state !== "approved") {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        job: publicJob(job),
      };
    }

    job.state = "cancelled";
    job.updatedAt = this.now();
    this.persistBestEffort(job);
    return { ok: true, job: publicJob(job) };
  }

  cancelSession(sessionId: string): ApprovalJob[] {
    const cancelled: ApprovalJob[] = [];
    for (const job of this.jobs.values()) {
      if (
        job.sessionId === sessionId &&
        (job.state === "awaiting_approval" || job.state === "approved")
      ) {
        job.state = "cancelled";
        job.updatedAt = this.now();
        this.persistBestEffort(job);
        cancelled.push(publicJob(job));
      }
    }
    return cancelled;
  }

  async waitForTerminalOrReceipt<T>(
    jobId: string,
    holdMs: number,
    signal?: AbortSignal
  ): Promise<ApprovalWaitOutcome<T>> {
    const startedAt = this.now();

    while (true) {
      const job = this.jobs.get(jobId) as InternalJob<T> | undefined;
      if (!job) {
        throw new ApprovalEngineError("NOT_FOUND", `Approval job not found: ${jobId}`);
      }

      this.expireJobIfDue(job);

      if (isTerminal(job.state)) {
        return { kind: "terminal", job: publicJob(job) };
      }

      if (signal?.aborted) {
        if (job.state === "awaiting_approval" || job.state === "approved") {
          job.state = "cancelled";
          job.updatedAt = this.now();
          this.persistBestEffort(job);
        }
        return { kind: "terminal", job: publicJob(job) };
      }

      if (this.now() - startedAt >= holdMs) {
        return { kind: "receipt", job: publicJob(job) };
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  private transitionAwaitingToTerminal(
    jobId: string,
    state: "denied" | "expired"
  ): ApprovalTransitionOutcome {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { ok: false, status: 404, code: "NOT_FOUND" };
    }

    if (job.state !== "awaiting_approval") {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        job: publicJob(job),
      };
    }

    job.state = state;
    job.updatedAt = this.now();
    this.persistBestEffort(job);
    return { ok: true, job: publicJob(job) };
  }

  private async executeApproved<T>(job: InternalJob<T>): Promise<void> {
    // CAS claim: any session-close/cancel that changed state before this line
    // wins and prevents execution.
    if (job.state !== "approved") return;

    job.state = "running";
    job.updatedAt = this.now();
    job.executionCount += 1;

    try {
      this.persistJob(job);
    } catch {
      this.journalUnavailable(job);
      return;
    }

    try {
      const result = await job.executeFn();
      job.result = result;
      job.state = "completed";
      job.updatedAt = this.now();
      this.persistBestEffort(job);
    } catch (err) {
      job.error = (err as Error).message || String(err);
      job.state = "failed";
      job.updatedAt = this.now();
      this.persistBestEffort(job);
    }
  }

  private expireDueJobs(): void {
    for (const job of this.jobs.values()) {
      this.expireJobIfDue(job);
    }
  }

  private expireJobIfDue(job: InternalJob): void {
    if (
      job.state === "awaiting_approval" &&
      this.now() >= job.expiresAt
    ) {
      job.state = "expired";
      job.updatedAt = this.now();
      this.persistBestEffort(job);
    }
  }

  /**
   * Read through a method because the executor mutates the job inside the
   * `void` call above; local control-flow narrowing cannot see that.
   */
  private claimWasRefused(job: InternalJob): boolean {
    return job.state === "unknown";
  }

  private journalUnavailable<T>(
    job: InternalJob<T>
  ): {
    ok: false;
    status: 503;
    code: string;
    job: ApprovalJob<T>;
  } {
    job.state = "unknown";
    job.error =
      "Approval journal became unavailable before execution; action was not run.";
    job.updatedAt = this.now();
    return {
      ok: false,
      status: 503,
      code: "JOURNAL_UNAVAILABLE",
      job: publicJob(job),
    };
  }

  private persistJob(job: InternalJob): void {
    this.persist?.(recoverableJob(job));
  }

  private persistBestEffort(job: InternalJob): void {
    try {
      this.persistJob(job);
    } catch {
      // Fail-closed in memory. If the durable snapshot cannot be updated,
      // restart recovery will treat any prior nonterminal record as unknown.
    }
  }

  private pruneRecentHistory(): void {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (
        isTerminal(job.state) &&
        now - job.updatedAt > this.retryRetentionMs
      ) {
        this.jobs.delete(id);
      }
    }
  }
}

export class ApprovalEngineError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApprovalEngineError";
  }
}
