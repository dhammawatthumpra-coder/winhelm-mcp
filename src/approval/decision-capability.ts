import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultApprovalJournalPath } from "./journal.js";
import { crossProcessInstanceId } from "./cross-process.js";
import type { ApprovalJob } from "./approval-engine.js";

const CAPABILITIES_DIR = "decision-capabilities";
export const CAPABILITY_VERSION = 2;
const STALE_CAPABILITY_GRACE_MS = 60 * 60 * 1000;

export type ApprovalDecisionVerb = "approved" | "denied";

export interface DecisionCapabilityRecord {
  version: number;
  jobId: string;
  fingerprint: string;
  instanceId: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
  tokenVerifier: string; // SHA-256 hex digest of the opaque token
  allowedDecisions: ApprovalDecisionVerb[];
}

export interface IssuedDecisionCapability {
  record: DecisionCapabilityRecord;
  token: string;
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
 * Hardens directory ACLs on Windows so only the current Windows user,
 * SYSTEM, and Administrators have read/write access.
 */
export function hardenCapabilitiesDirectory(dir: string): void {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort on POSIX
    }
    return;
  }

  const username = process.env.USERNAME;
  if (!username) return;

  try {
    execFileSync(
      "icacls.exe",
      [
        dir,
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-18:(OI)(CI)F",
        "/grant:r",
        "*S-1-5-32-544:(OI)(CI)F",
        "/grant:r",
        `${username}:(OI)(CI)F`,
      ],
      { stdio: "ignore" }
    );
  } catch {
    // Best effort if icacls is restricted in current execution context
  }
}

/**
 * Issue a cryptographically random, short-lived, single-use opaque activation capability.
 * Bound to the exact approval job, fingerprint, issuer identity, and expiry.
 *
 * CRITICAL SECURITY INVARIANT:
 * The plaintext token is NEVER persisted to disk. Only its SHA-256 digest (tokenVerifier)
 * is stored in the capability file, while the token is returned in-memory for delivery
 * to the presentation layer (Windows Toast notification).
 */
export function issueDecisionCapability(
  job: Pick<ApprovalJob, "id" | "fingerprint" | "createdAt" | "expiresAt">,
  journalPath: string = defaultApprovalJournalPath()
): IssuedDecisionCapability | null {
  const id = safeJobId(job.id);
  if (!id) return null;

  const dir = capabilitiesDirectory(journalPath);
  fs.mkdirSync(dir, { recursive: true });
  hardenCapabilitiesDirectory(dir);

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenVerifier = crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");

  const record: DecisionCapabilityRecord = {
    version: CAPABILITY_VERSION,
    jobId: id,
    fingerprint: job.fingerprint,
    instanceId: crossProcessInstanceId(),
    pid: process.pid,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    tokenVerifier,
    allowedDecisions: ["approved", "denied"],
  };

  const target = path.join(dir, `${id}.json`);
  const temporary = path.join(
    dir,
    `.${id}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.tmp`
  );

  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, JSON.stringify(record, null, 2), "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    fs.renameSync(temporary, target);
    return { record, token };
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
): DecisionCapabilityRecord | null {
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
      return parsed as DecisionCapabilityRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export type CapabilityConsumeResult =
  | { ok: true; capability: DecisionCapabilityRecord }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "EXPIRED"
        | "ALREADY_CONSUMED"
        | "INVALID_ARGUMENT"
        | "MISSING_ACTIVATION_TOKEN"
        | "DECISION_NOT_ALLOWED"
        | "INVALID_CAPABILITY_TOKEN";
    };

/**
 * Atomically consumes a decision capability, enforcing proof-of-possession,
 * single-use, decision verb validity, and expiration.
 *
 * The capability file is renamed to `.consumed` immediately, ensuring exactly-once
 * execution and preventing any token brute-forcing.
 */
export function consumeDecisionCapability(
  jobId: string,
  token: string | undefined,
  decision: string,
  journalPath: string = defaultApprovalJournalPath()
): CapabilityConsumeResult {
  const id = safeJobId(jobId);
  if (!id) return { ok: false, code: "INVALID_ARGUMENT" };

  if (!token || typeof token !== "string" || !token.trim()) {
    return { ok: false, code: "MISSING_ACTIVATION_TOKEN" };
  }

  if (decision !== "approved" && decision !== "denied") {
    return { ok: false, code: "INVALID_ARGUMENT" };
  }

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

  let record: DecisionCapabilityRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, code: "NOT_FOUND" };
  }

  if (
    !record ||
    record.version !== CAPABILITY_VERSION ||
    record.jobId !== id
  ) {
    return { ok: false, code: "NOT_FOUND" };
  }

  // Atomically consume first (single use, prevents replay & guess retries)
  try {
    fs.renameSync(target, consumed);
  } catch {
    return { ok: false, code: "ALREADY_CONSUMED" };
  }

  // Check expiration
  if (Date.now() >= record.expiresAt) {
    return { ok: false, code: "EXPIRED" };
  }

  // Check allowed decision semantics
  if (
    !Array.isArray(record.allowedDecisions) ||
    !record.allowedDecisions.includes(decision as ApprovalDecisionVerb)
  ) {
    return { ok: false, code: "DECISION_NOT_ALLOWED" };
  }

  // Verify proof-of-possession token using constant-time comparison
  const actualVerifier = crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");

  const actualBuf = Buffer.from(actualVerifier, "utf8");
  const expectedBuf = Buffer.from(record.tokenVerifier, "utf8");

  const isValidToken =
    actualBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(actualBuf, expectedBuf);

  if (!isValidToken) {
    return { ok: false, code: "INVALID_CAPABILITY_TOKEN" };
  }

  return { ok: true, capability: record };
}

/**
 * Proactively invalidates a decision capability when the corresponding job
 * reaches any terminal state (e.g. approved/denied via Dashboard, expired, cancelled).
 */
export function invalidateDecisionCapability(
  jobId: string,
  journalPath: string = defaultApprovalJournalPath()
): boolean {
  const id = safeJobId(jobId);
  if (!id) return false;

  const dir = capabilitiesDirectory(journalPath);
  const target = path.join(dir, `${id}.json`);
  const consumed = path.join(dir, `${id}.consumed`);

  try {
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(consumed);
      } catch {
        // Ignored
      }
      fs.renameSync(target, consumed);
      return true;
    }
  } catch {
    // Best effort
  }
  return false;
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
