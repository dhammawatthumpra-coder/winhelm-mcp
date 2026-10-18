import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultApprovalJournalPath } from "./journal.js";
import { crossProcessInstanceId } from "./cross-process.js";
import type { ApprovalJob } from "./approval-engine.js";

const CAPABILITIES_DIR = "decision-capabilities";
const CAPABILITY_VERSION = 1;
const STALE_CAPABILITY_GRACE_MS = 60 * 60 * 1000;

export interface DecisionCapability {
  version: number;
  jobId: string;
  fingerprint: string;
  instanceId: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
  nonce: string;
}

export function capabilitiesDirectory(
  journalPath: string = defaultApprovalJournalPath()
): string {
  const base = path.dirname(path.resolve(journalPath));
  return path.join(base, CAPABILITIES_DIR);
}

function safeJobId(jobId: string): string | null {
  return /^job_[A-Za-z0-9_-]+$/.test(jobId) ? jobId : null;
}

/**
 * Issue a short-lived decision capability bound to an exact approval job.
 * Stored inside ~/.winhelm/decision-capabilities/ with mode 0o600 so only
 * the current Windows user has read/write access.
 */
export function issueDecisionCapability(
  job: Pick<ApprovalJob, "id" | "fingerprint" | "createdAt" | "expiresAt">,
  journalPath: string = defaultApprovalJournalPath()
): DecisionCapability | null {
  const id = safeJobId(job.id);
  if (!id) return null;

  const dir = capabilitiesDirectory(journalPath);
  fs.mkdirSync(dir, { recursive: true });

  const capability: DecisionCapability = {
    version: CAPABILITY_VERSION,
    jobId: id,
    fingerprint: job.fingerprint,
    instanceId: crossProcessInstanceId(),
    pid: process.pid,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    nonce: crypto.randomBytes(24).toString("hex"),
  };

  const target = path.join(dir, `${id}.json`);
  const temporary = path.join(
    dir,
    `.${id}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.tmp`
  );

  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, JSON.stringify(capability, null, 2), "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    fs.renameSync(temporary, target);
    return capability;
  } catch (err) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort
    }
    return null;
  }
}

export function readDecisionCapability(
  jobId: string,
  journalPath: string = defaultApprovalJournalPath()
): DecisionCapability | null {
  const id = safeJobId(jobId);
  if (!id) return null;

  const dir = capabilitiesDirectory(journalPath);
  const target = path.join(dir, `${id}.json`);

  try {
    const raw = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.version === CAPABILITY_VERSION &&
      parsed.jobId === id
    ) {
      return parsed as DecisionCapability;
    }
    return null;
  } catch {
    return null;
  }
}

export type CapabilityConsumeResult =
  | { ok: true; capability: DecisionCapability }
  | {
      ok: false;
      code: "NOT_FOUND" | "EXPIRED" | "ALREADY_CONSUMED" | "INVALID_ARGUMENT";
    };

/**
 * Atomically consumes a decision capability, enforcing single-use and expiration.
 * The capability file is renamed to `.consumed` so subsequent calls fail immediately.
 */
export function consumeDecisionCapability(
  jobId: string,
  journalPath: string = defaultApprovalJournalPath()
): CapabilityConsumeResult {
  const id = safeJobId(jobId);
  if (!id) return { ok: false, code: "INVALID_ARGUMENT" };

  const dir = capabilitiesDirectory(journalPath);
  const target = path.join(dir, `${id}.json`);
  const consumed = path.join(dir, `${id}.consumed`);

  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    if (fs.existsSync(consumed)) {
      return { ok: false, code: "ALREADY_CONSUMED" };
    }
    return { ok: false, code: "NOT_FOUND" };
  }

  let capability: DecisionCapability;
  try {
    capability = JSON.parse(raw);
  } catch {
    return { ok: false, code: "NOT_FOUND" };
  }

  if (
    !capability ||
    capability.version !== CAPABILITY_VERSION ||
    capability.jobId !== id
  ) {
    return { ok: false, code: "NOT_FOUND" };
  }

  if (Date.now() >= capability.expiresAt) {
    try {
      fs.renameSync(target, consumed);
    } catch {
      // Best effort
    }
    return { ok: false, code: "EXPIRED" };
  }

  try {
    fs.renameSync(target, consumed);
  } catch {
    return { ok: false, code: "ALREADY_CONSUMED" };
  }

  return { ok: true, capability };
}

/**
 * Opportunistic sweep of expired or consumed capability records.
 */
export function sweepStaleCapabilities(
  journalPath: string = defaultApprovalJournalPath()
): void {
  const dir = capabilitiesDirectory(journalPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json") && !entry.endsWith(".consumed")) continue;
    const target = path.join(dir, entry);
    try {
      const stat = fs.statSync(target);
      if (now - stat.mtimeMs > STALE_CAPABILITY_GRACE_MS) {
        fs.unlinkSync(target);
      }
    } catch {
      // Best effort
    }
  }
}
