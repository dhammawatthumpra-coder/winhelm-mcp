import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  issueDecisionCapability,
  consumeDecisionCapability,
  invalidateDecisionCapability,
  sweepStaleCapabilities,
  capabilitiesDirectory,
} from "../../src/approval/decision-capability.js";
import {
  executeNativeDecision,
  parseApprovalProtocolUri,
} from "../../src/approval/decision-activator.js";
import {
  initializeApprovalPersistence,
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";

function tempJournalPath(prefix: string): string {
  const dir = path.join(
    os.tmpdir(),
    `winhelm-phase4-${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "approval-journal.jsonl");
}

function cleanup(journalPath: string): void {
  try {
    fs.rmSync(path.dirname(journalPath), { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

test("Phase 4: Product & Security Hardening", async (t) => {
  await t.test("1. Replay & Concurrency: rapid duplicate clicks execute action exactly once", async () => {
    const journalPath = tempJournalPath("concurrency");
    let executionCount = 0;

    initializeApprovalPersistence(journalPath, { crossProcess: false });
    const engine = getApprovalEngine();

    const created = engine.request({
      tool: "execute_command",
      args: { command: "npm test" },
      sessionId: "session_concurrency",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => {
        executionCount++;
        return { success: true };
      },
    });

    assert.equal(created.kind, "created");
    const jobId = created.job.id;

    // Simulate two concurrent activations (e.g. rapid double-click)
    const [res1, res2] = await Promise.all([
      executeNativeDecision(jobId, "approved", { journalPath }),
      executeNativeDecision(jobId, "approved", { journalPath }),
    ]);

    // Exactly one should succeed, the other should be cleanly rejected
    const successes = [res1, res2].filter((r) => r.ok);
    const rejections = [res1, res2].filter((r) => !r.ok);

    assert.equal(successes.length, 1, "Exactly one decision must succeed");
    assert.equal(rejections.length, 1, "The concurrent call must be rejected");
    assert.equal(rejections[0].code, "ALREADY_CONSUMED");

    // Allow async execution to settle
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(executionCount, 1, "Tool execution callback must execute only once");
    const finalJob = engine.get(jobId);
    assert.equal(finalJob?.state, "completed");

    cleanup(journalPath);
  });

  await t.test("2. Expiration: expired capability fails closed and never executes", async () => {
    const journalPath = tempJournalPath("expired");
    let executed = false;

    initializeApprovalPersistence(journalPath, { crossProcess: false });
    const engine = getApprovalEngine();

    const created = engine.request({
      tool: "restart_service",
      args: { service: "spooler" },
      sessionId: "session_expired",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => {
        executed = true;
        return { success: true };
      },
    });

    assert.equal(created.kind, "created");
    const jobId = created.job.id;

    // Manually backdate the capability file to simulate expiry
    const dir = capabilitiesDirectory(journalPath);
    const capPath = path.join(dir, `${jobId}.json`);
    const capData = JSON.parse(fs.readFileSync(capPath, "utf8"));
    capData.expiresAt = Date.now() - 5000;
    fs.writeFileSync(capPath, JSON.stringify(capData, null, 2), "utf8");

    const result = await executeNativeDecision(jobId, "approved", { journalPath });
    assert.equal(result.ok, false);
    assert.equal(result.code, "EXPIRED");

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executed, false, "Expired job must never execute tool");

    // Second activation should also fail
    const secondResult = await executeNativeDecision(jobId, "approved", { journalPath });
    assert.equal(secondResult.ok, false);

    cleanup(journalPath);
  });

  await t.test("3. Stale Toast on Engine Restart: recovered unknown jobs refuse activation", async () => {
    const journalPath = tempJournalPath("stale-restart");

    // First instance: create job and crash/stop
    initializeApprovalPersistence(journalPath, { crossProcess: false });
    const engine1 = getApprovalEngine();

    const created = engine1.request({
      tool: "edit_registry",
      args: { key: "HKCU\\Software\\Test" },
      sessionId: "session_crash",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => ({ success: true }),
    });
    assert.equal(created.kind, "created");
    const jobId = created.job.id;

    // Second instance: starts up and recovers from journal
    // Interrupted awaiting jobs become state 'unknown'
    initializeApprovalPersistence(journalPath, { crossProcess: false });
    const engine2 = getApprovalEngine();
    // Simulate restored jobs
    engine2.restoreRecoveredJobs([
      {
        id: jobId,
        tool: "edit_registry",
        args: { key: "HKCU\\Software\\Test" },
        fingerprint: "fp_test",
        sessionId: "session_crash",
        state: "unknown",
        createdAt: Date.now() - 10000,
        expiresAt: Date.now() + 60000,
        updatedAt: Date.now(),
        requiresExplicitConfirmation: true,
      },
    ]);

    // Clicking toast from the earlier run
    const result = await executeNativeDecision(jobId, "approved", { journalPath });

    // Since the job is unknown in engine2 and capability pid was engine1
    // It must fail closed and never run
    assert.equal(result.ok, false);

    cleanup(journalPath);
  });

  await t.test("4. Dead Owner Process: cross-process activator fails closed if owning PID is dead", async () => {
    const journalPath = tempJournalPath("dead-owner");
    const jobId = "job_dead_owner_test_123";

    // Fake capability with non-existent PID
    const dir = capabilitiesDirectory(journalPath);
    fs.mkdirSync(dir, { recursive: true });
    const capPath = path.join(dir, `${jobId}.json`);
    const cap = {
      version: 1,
      jobId,
      fingerprint: "fp_dead",
      instanceId: "inst_dead",
      pid: 999999, // Unlikely to be alive
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
      nonce: "nonce_dead",
    };
    fs.writeFileSync(capPath, JSON.stringify(cap, null, 2), "utf8");

    // Local engine does not own this job
    resetApprovalEngine();

    const result = await executeNativeDecision(jobId, "approved", { journalPath });
    assert.equal(result.ok, false);
    assert.equal(result.code, "OWNER_UNAVAILABLE");

    cleanup(journalPath);
  });

  await t.test("5. Race Condition: Dashboard / CLI vs Native UX", async () => {
    const journalPath = tempJournalPath("race-dashboard");

    initializeApprovalPersistence(journalPath, {
      crossProcess: false,
      auditDecisions: true,
    });
    const engine = getApprovalEngine();

    const created = engine.request({
      tool: "write_file",
      args: { path: "C:\\Windows\\test.txt" },
      sessionId: "session_race",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => ({ success: true }),
    });
    assert.equal(created.kind, "created");
    const jobId = created.job.id;

    // Dashboard denies first
    const denyOutcome = engine.deny(jobId, "dashboard");
    assert.equal(denyOutcome.ok, true);

    // Capability is invalidated proactively by onDecision hook
    const nativeResult = await executeNativeDecision(jobId, "approved", {
      journalPath,
    });
    assert.equal(nativeResult.ok, false);
    assert.equal(nativeResult.code, "ALREADY_CONSUMED");

    // Confirm job state remains denied
    assert.equal(engine.get(jobId)?.state, "denied");

    cleanup(journalPath);
  });

  await t.test("6. Protocol URI & Argument Sanitization / Path Traversal Rejection", async () => {
    // Valid URI parsing
    const valid = parseApprovalProtocolUri(
      "winhelm-approval:decide?jobId=job_abc-123_XYZ&decision=approved"
    );
    assert.equal(valid.jobId, "job_abc-123_XYZ");
    assert.equal(valid.decision, "approved");

    const validDeny = parseApprovalProtocolUri(
      "winhelm-approval:decide?jobId=job_123&decision=denied"
    );
    assert.equal(validDeny.decision, "denied");

    // Invalid decision actions
    const invalidDecision = parseApprovalProtocolUri(
      "winhelm-approval:decide?jobId=job_123&decision=malicious_action"
    );
    assert.equal(invalidDecision.decision, undefined);

    // Path traversal in jobId
    const pathTraversalResult = await executeNativeDecision(
      "job_../../etc/passwd",
      "approved"
    );
    assert.equal(pathTraversalResult.ok, false);
    assert.equal(pathTraversalResult.code, "INVALID_ARGUMENT");

    // Command injection in jobId
    const injectionResult = await executeNativeDecision(
      "job_123;rmdir /s /q C:\\",
      "approved"
    );
    assert.equal(injectionResult.ok, false);
    assert.equal(injectionResult.code, "INVALID_ARGUMENT");

    // Null byte injection
    const nullByteResult = await executeNativeDecision(
      "job_123\0admin",
      "approved"
    );
    assert.equal(nullByteResult.ok, false);
    assert.equal(nullByteResult.code, "INVALID_ARGUMENT");
  });

  await t.test("7. Multiple Concurrent Pending Jobs Isolation", async () => {
    const journalPath = tempJournalPath("multi-jobs");
    const executedJobs: string[] = [];

    initializeApprovalPersistence(journalPath, { crossProcess: false });
    const engine = getApprovalEngine();

    const jobA = engine.request({
      tool: "command_a",
      args: { id: "a" },
      sessionId: "session_multi",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => {
        executedJobs.push("A");
        return { ok: true };
      },
    });
    const jobB = engine.request({
      tool: "command_b",
      args: { id: "b" },
      sessionId: "session_multi",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => {
        executedJobs.push("B");
        return { ok: true };
      },
    });
    const jobC = engine.request({
      tool: "command_c",
      args: { id: "c" },
      sessionId: "session_multi",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => {
        executedJobs.push("C");
        return { ok: true };
      },
    });

    assert.equal(jobA.kind, "created");
    assert.equal(jobB.kind, "created");
    assert.equal(jobC.kind, "created");

    // Approve Job A via Native UX
    const resA = await executeNativeDecision(jobA.job.id, "approved", { journalPath });
    assert.equal(resA.ok, true);

    // Deny Job B via Native UX
    const resB = await executeNativeDecision(jobB.job.id, "denied", { journalPath });
    assert.equal(resB.ok, true);

    // Job C remains awaiting_approval
    assert.equal(engine.get(jobC.job.id)?.state, "awaiting_approval");

    await new Promise((r) => setTimeout(r, 40));

    assert.deepEqual(executedJobs, ["A"], "Only Job A should have executed");
    assert.equal(engine.get(jobA.job.id)?.state, "completed");
    assert.equal(engine.get(jobB.job.id)?.state, "denied");
    assert.equal(engine.get(jobC.job.id)?.state, "awaiting_approval");

    // Later approve Job C
    const resC = await executeNativeDecision(jobC.job.id, "approved", { journalPath });
    assert.equal(resC.ok, true);

    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(executedJobs, ["A", "C"]);
    assert.equal(engine.get(jobC.job.id)?.state, "completed");

    cleanup(journalPath);
  });

  await t.test("8. Stale capability sweep cleans old records while keeping active ones", async () => {
    const journalPath = tempJournalPath("sweep");
    const dir = capabilitiesDirectory(journalPath);
    fs.mkdirSync(dir, { recursive: true });

    const recentPath = path.join(dir, "job_recent.json");
    const oldPath = path.join(dir, "job_old.consumed");

    fs.writeFileSync(recentPath, "{}", "utf8");
    fs.writeFileSync(oldPath, "{}", "utf8");

    // Modify mtime of old file to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, twoHoursAgo, twoHoursAgo);

    sweepStaleCapabilities(journalPath);

    assert.equal(fs.existsSync(recentPath), true, "Recent capability must be preserved");
    assert.equal(fs.existsSync(oldPath), false, "Stale record (>1hr) must be swept");

    cleanup(journalPath);
  });
});
