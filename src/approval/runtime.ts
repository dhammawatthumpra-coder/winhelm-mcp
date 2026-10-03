import {
  ApprovalEngine,
  type ApprovalEngineOptions,
  type ApprovalJob,
  type RecoverableApprovalJob,
} from "./approval-engine.js";
import { notifyApprovalPending } from "./notify.js";
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

  engine = new ApprovalEngine({
    persist: (job: RecoverableApprovalJob) => journal.persist(job),
    journalIntegrityFailed: loaded.integrityFailure !== null,
    ...(options.notifyApprovals
      ? {
          onCreated: (job: ApprovalJob) => {
            (options.notifier ?? notifyApprovalPending)(job);
          },
        }
      : {}),
  });

  if (loaded.jobs.length > 0) {
    engine.restoreRecoveredJobs(loaded.jobs);
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
