import crypto from "node:crypto";

export type ApprovalJobState =
  | "awaiting_approval"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "expired"
  | "cancelled";

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
  | { ok: false; status: 404 | 409; code: string; job?: ApprovalJob<T> };

export type ApprovalWaitOutcome<T = unknown> =
  | { kind: "terminal"; job: ApprovalJob<T> }
  | { kind: "receipt"; job: ApprovalJob<T> };

interface InternalJob<T = unknown> extends ApprovalJob<T> {
  executeFn: () => Promise<T>;
}

export interface ApprovalEngineOptions {
  now?: () => number;
  retryRetentionMs?: number;
}

const TERMINAL_STATES = new Set<ApprovalJobState>([
  "completed",
  "failed",
  "denied",
  "expired",
  "cancelled",
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
  const { executeFn: _executeFn, ...visible } = job;
  return {
    ...visible,
    args: structuredClone(visible.args),
  };
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

  constructor(options: ApprovalEngineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.retryRetentionMs = options.retryRetentionMs ?? 60_000;
  }

  request<T>(request: ApprovalRequest<T>): ApprovalRequestOutcome<T> {
    this.expireDueJobs();
    this.pruneRecentHistory();

    const now = this.now();
    const fingerprint = approvalRequestFingerprint(request.tool, request.args);

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
    };

    this.jobs.set(job.id, job);
    return { kind: "created", job: publicJob(job) };
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
    void this.executeApproved(job);
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
      const result = await job.executeFn();
      job.result = result;
      job.state = "completed";
      job.updatedAt = this.now();
    } catch (err) {
      job.error = (err as Error).message || String(err);
      job.state = "failed";
      job.updatedAt = this.now();
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
