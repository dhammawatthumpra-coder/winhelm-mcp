import {
  ApprovalEngine,
  type ApprovalEngineOptions,
  type ApprovalJob,
  type RecoverableApprovalJob,
} from "./approval-engine.js";
import { notifyApprovalPending } from "./notify.js";
import {
  logApprovalDecision,
  type ApprovalDecision,
} from "./audit.js";
import {
  consumeOwnedDecisions,
  crossProcessInstanceId,
  isProcessAlive,
  isTerminalJobState,
  listForeignRequests,
  mirrorRequest,
  readRequest,
  sweepStaleCrossProcessState,
  waitForCrossProcessOutcome,
  writeDecision,
  type CrossProcessDecision,
  type CrossProcessRequestRecord,
} from "./cross-process.js";

const crossProcessInstanceIdValue = crossProcessInstanceId;

const defaultDecisionSink = (
  job: ApprovalJob,
  decision: ApprovalDecision,
  channel: string
): void => {
  logApprovalDecision(job, decision, { channel });
};
import {
  ApprovalJournal,
  defaultApprovalJournalPath,
  type ApprovalJournalIntegrityFailure,
} from "./journal.js";

export interface ApprovalPersistenceStatus {
  journalPath: string;
  recoveredJobs: number;
  unknownRecoveredJobs: number;
  integrityFailure: ApprovalJournalIntegrityFailure | null;
  quarantinedPath: string | null;
}

let engine = new ApprovalEngine();
let persistenceStatus: ApprovalPersistenceStatus | null = null;
let activeCrossProcessTimer: NodeJS.Timeout | null = null;

export function getApprovalEngine(): ApprovalEngine {
  return engine;
}

/**
 * Test/support hook. Production code should use the process-wide singleton so
 * approval jobs are shared across MCP sessions, dashboard/admin routes and
 * recovery tools in one WinHelm process.
 */
export function resetApprovalEngine(
  options: ApprovalEngineOptions = {}
): ApprovalEngine {
  engine = new ApprovalEngine(options);
  persistenceStatus = null;
  return engine;
}

export interface ApprovalPersistenceOptions {
  /**
   * Send a desktop notification when a job is queued. Off by default so tests
   * and library callers never touch the desktop.
   */
  notifyApprovals?: boolean;
  /** Notification adapter; defaults to WinHelm's own desktop toast. */
  notifier?: (job: ApprovalJob) => void;
  /**
   * Write an audit record for every terminal approval decision, including the
   * decision latency. Off by default so tests and library callers do not append
   * to the audit log.
   */
  auditDecisions?: boolean;
  /** Audit sink; defaults to the append-only audit log. */
  decisionSink?: (
    job: ApprovalJob,
    decision: ApprovalDecision,
    channel: string
  ) => void;
  /**
   * Enable cross-process approval coordination (DEF-02): pending jobs are
   * mirrored for other WinHelm processes (Dashboard) and decisions recorded
   * by those processes are applied through this engine, which stays the only
   * executor. Off by default so tests and library callers stay in-memory.
   */
  crossProcess?: boolean;
  /**
   * Owner-computed display metadata for a mirrored job (clientInfo, risk,
   * folder access, provenance). Computed by the owning process so remote
   * surfaces render the requesting client's own context.
   */
  requestMetaProvider?: (job: ApprovalJob) => Record<string, unknown>;
}

/**
 * Wire the durable approval journal. This is an explicit production bootstrap:
 * the default engine stays in-memory so tests never write to the user's WinHelm
 * data directory.
 *
 * Recovered jobs are restored into memory so retries after a restart are
 * deduped instead of re-executed. Interrupted jobs are restored as `unknown`
 * and are never re-run. A journal that cannot be trusted fails closed.
 */
export function initializeApprovalPersistence(
  journalPath: string = defaultApprovalJournalPath(),
  options: ApprovalPersistenceOptions = {}
): ApprovalPersistenceStatus {
  const journal = new ApprovalJournal(journalPath);
  const loaded = journal.load();

  const mirrorJob = options.crossProcess
    ? (job: RecoverableApprovalJob): void => {
        mirrorRequest(
          job,
          options.requestMetaProvider
            ? options.requestMetaProvider(job)
            : {},
          journalPath
        );
      }
    : undefined;

  engine = new ApprovalEngine({
    persist: (job: RecoverableApprovalJob) => {
      journal.persist(job);
      mirrorJob?.(job);
    },
    journalIntegrityFailed: loaded.integrityFailure !== null,
    ...(options.notifyApprovals
      ? {
          onCreated: (job: ApprovalJob) => {
            (options.notifier ?? notifyApprovalPending)(job);
          },
        }
      : {}),
    ...(options.auditDecisions
      ? {
          onDecision: (
            job: ApprovalJob,
            decision: ApprovalDecision,
            channel: string
          ) => {
            (options.decisionSink ?? defaultDecisionSink)(
              job,
              decision,
              channel
            );
          },
        }
      : {}),
  });

  if (loaded.jobs.length > 0) {
    engine.restoreRecoveredJobs(loaded.jobs);
  }

  let crossProcessTimer: NodeJS.Timeout | null = null;
  if (activeCrossProcessTimer) {
    clearInterval(activeCrossProcessTimer);
    activeCrossProcessTimer = null;
  }
  if (options.crossProcess) {
    // Clean up only this instance's own stale mirrors (previous runs).
    // Mirrors written by other instances belong to those instances: an
    // awaiting job recovered from the shared journal is owned by whoever
    // holds its executor, not by us.
    for (const job of loaded.jobs) {
      const existing = readRequest(job.id, journalPath);
      if (existing && existing.instanceId === crossProcessInstanceIdValue()) {
        mirrorJob?.(job);
      }
    }

    crossProcessTimer = setInterval(
      (() => {
        let sweepCounter = 0;
        return (): void => {
          try {
            // The engine reference is read live: tests may reset the engine.
            const active = engine;
            consumeOwnedDecisions(
              (jobId) => active.ownsJob(jobId),
              (jobId, decision) => {
                if (decision === "approved") active.approve(jobId, "dashboard");
                else active.deny(jobId, "dashboard");
              },
              journalPath
            );
            if (++sweepCounter % 1200 === 0) {
              sweepStaleCrossProcessState(journalPath);
            }
          } catch {
            // Coordination failures must never break the owning flow.
          }
        };
      })(),
      250
    );
    crossProcessTimer.unref?.();
    activeCrossProcessTimer = crossProcessTimer;
  }

  persistenceStatus = {
    journalPath: journal.path,
    recoveredJobs: loaded.jobs.length,
    unknownRecoveredJobs: engine
      .list()
      .filter((job) => job.state === "unknown").length,
    integrityFailure: loaded.integrityFailure,
    quarantinedPath: loaded.quarantinedPath,
  };

  return persistenceStatus;
}

export function getApprovalPersistenceStatus(): ApprovalPersistenceStatus | null {
  return persistenceStatus;
}

export type RemoteDecisionOutcome =
  | { kind: "applied"; job: RecoverableApprovalJob }
  | { kind: "pending"; jobId: string }
  | { kind: "conflict"; code: string; job: RecoverableApprovalJob | null }
  | { kind: "unavailable"; code: string };

export interface CrossProcessApprovalSurface {
  listForeignRequests: () => CrossProcessRequestRecord[];
  decideRemote: (
    jobId: string,
    decision: CrossProcessDecision,
    channel: string,
    timeoutMs?: number
  ) => Promise<RemoteDecisionOutcome>;
}

/**
 * Cross-process decision surface for admin surfaces (Dashboard, CLI). Returns
 * null unless cross-process coordination is enabled. The owning process
 * remains the only executor: this layer records the decision and observes the
 * owner's durable outcome, it never runs a tool callback.
 */
export function getCrossProcessApprovalSurface(): CrossProcessApprovalSurface | null {
  if (!activeCrossProcessTimer) return null;
  return {
    listForeignRequests: () => listForeignRequests(),
    decideRemote: async (
      jobId: string,
      decision: CrossProcessDecision,
      channel: string,
      timeoutMs = 12000
    ): Promise<RemoteDecisionOutcome> => {
      // The owner's per-job mirror is the authoritative cross-process view
      // (single writer per file). Fail closed when it is missing: without a
      // live owner there is nobody who could ever execute the action.
      const mirror = readRequest(jobId);
      if (!mirror) {
        return { kind: "conflict", code: "OWNER_UNAVAILABLE", job: null };
      }
      const durable = mirror.job;
      if (durable.state !== "awaiting_approval") {
        return { kind: "conflict", code: "CONFLICT", job: durable };
      }
      if (Date.now() >= durable.expiresAt) {
        return { kind: "conflict", code: "CONFLICT", job: durable };
      }
      if (!isProcessAlive(mirror.pid)) {
        return { kind: "conflict", code: "OWNER_UNAVAILABLE", job: durable };
      }
      const written = writeDecision(jobId, decision, channel);
      if (!written.ok) {
        return { kind: "conflict", code: "ALREADY_DECIDED", job: durable };
      }
      const outcome = await waitForCrossProcessOutcome(jobId, timeoutMs);
      // "applied" means the owner reached a final state. An in-flight claim
      // (running) is reported as pending so callers do not treat a
      // non-terminal state as a finished decision.
      if (outcome && isTerminalJobState(outcome.state)) {
        return { kind: "applied", job: outcome };
      }
      return { kind: "pending", jobId };
    },
  };
}
