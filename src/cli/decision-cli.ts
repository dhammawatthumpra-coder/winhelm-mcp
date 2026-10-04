import {
  listForeignRequests,
  readRequest,
  waitForCrossProcessOutcome,
  writeDecision,
} from "../approval/cross-process.js";
import { ApprovalJournal, defaultApprovalJournalPath } from "../approval/journal.js";

export interface SharedApprovalDecisionOutcome {
  ok: boolean;
  state?: string;
  message?: string;
}

/**
 * List approval jobs from the shared cross-process state so the CLI sees
 * work from every active WinHelm instance, not only the last process to own
 * the old control pipe. Pending mirrors are authoritative (single writer per
 * file, refreshed on every durable transition by the owning process); the
 * durable journal contributes recent terminal records.
 */
export function listSharedApprovalJobs(
  journalPath: string = defaultApprovalJournalPath()
): any[] {
  let journalJobs: any[] = [];
  try {
    const journal = new ApprovalJournal(journalPath);
    const loaded = journal.load();
    if (loaded.integrityFailure) {
      throw new Error(
        "The approval journal could not be trusted (" +
          loaded.integrityFailure +
          "); approval listing is refused until it is repaired."
      );
    }
    journalJobs = loaded.jobs;
  } catch (err) {
    if (err instanceof Error && /could not be trusted/.test(err.message)) {
      throw err;
    }
    // A missing/unreadable journal still allows the live mirror view.
    journalJobs = [];
  }
  const byId = new Map<string, any>();
  for (const job of journalJobs) byId.set(job.id, job);
  for (const record of listForeignRequests()) byId.set(record.job.id, record.job);
  return [...byId.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
}

/**
 * Record an approval decision for a job owned by any WinHelm instance and
 * wait for the owning process (the only executor) to observe it. Never
 * executes anything itself; fail-closed on every unusable state.
 */
export async function decideSharedApprovalJob(
  jobId: string,
  decision: "approved" | "denied",
  channel: string,
  journalPath: string = defaultApprovalJournalPath()
): Promise<SharedApprovalDecisionOutcome> {
  const mirror = readRequest(jobId, journalPath);
  if (!mirror) {
    return {
      ok: false,
      message:
        "Approval job not found among live WinHelm instances (its owner may have exited, or the record aged out). Run 'winhelm jobs' to list current jobs.",
    };
  }
  const durable = mirror.job;
  if (durable.state !== "awaiting_approval") {
    return {
      ok: false,
      message:
        "Approval job is no longer awaiting approval (state: " +
        durable.state +
        ").",
    };
  }
  if (Date.now() >= durable.expiresAt) {
    return {
      ok: false,
      message: "Approval job has already expired; it cannot be decided.",
    };
  }
  const written = writeDecision(jobId, decision, channel, journalPath);
  if (!written.ok) {
    return {
      ok: false,
      message:
        "This approval job was already decided (" +
        written.existing +
        "); the recorded decision stands.",
    };
  }
  const outcome = await waitForCrossProcessOutcome(jobId, 12000, journalPath);
  if (outcome && outcome.state !== "awaiting_approval") {
    return { ok: true, state: outcome.state };
  }
  return {
    ok: true,
    state: "pending",
    message:
      "Decision recorded; the owning instance has not confirmed it yet. Re-run 'winhelm jobs' to see the job state.",
  };
}
