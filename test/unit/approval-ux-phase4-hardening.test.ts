import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  issueDecisionCapability,
  consumeDecisionCapability,
  invalidateDecisionCapability,
  sweepStaleCapabilities,
  capabilitiesDirectory,
  hardenCapabilitiesDirectory,
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
    let issuedToken: string | undefined;

    initializeApprovalPersistence(journalPath, {
      crossProcess: false,
      notifyApprovals: true,
      notifier: (_job, token) => {
        issuedToken = token;
      },
    });
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
    assert.ok(issuedToken, "Activation token must have been issued");

    // Simulate two concurrent activations (e.g. rapid double-click) with the issued token
    const [res1, res2] = await Promise.all([
      executeNativeDecision(jobId, "approved", issuedToken, { journalPath }),
      executeNativeDecision(jobId, "approved", issuedToken, { journalPath }),
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

  await t.test("2. Proof-of-Possession: jobId alone without token is rejected fail-closed", async () => {
    const journalPath = tempJournalPath("no-token");
    let executed = false;

    initializeApprovalPersistence(journalPath, { crossProcess: false });
    const engine = getApprovalEngine();

    const created = engine.request({
      tool: "edit_registry",
      args: { key: "HKCU\\Software\\Test" },
      sessionId: "session_no_token",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => {
        executed = true;
        return { success: true };
      },
    });
    assert.equal(created.kind, "created");
    const jobId = created.job.id;

    // Caller passes only jobId without token
    const result = await executeNativeDecision(jobId, "approved", undefined, {
      journalPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MISSING_ACTIVATION_TOKEN");

    // Passing empty string token
    const emptyResult = await executeNativeDecision(jobId, "approved", "   ", {
      journalPath,
    });
    assert.equal(emptyResult.ok, false);
    assert.equal(emptyResult.code, "MISSING_ACTIVATION_TOKEN");

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executed, false, "Tool must never run without activation token");

    cleanup(journalPath);
  });

  await t.test("3. Proof-of-Possession: wrong token is rejected and capability is consumed", async () => {
    const journalPath = tempJournalPath("wrong-token");
    let executed = false;
    let issuedToken: string | undefined;

    initializeApprovalPersistence(journalPath, {
      crossProcess: false,
      notifyApprovals: true,
      notifier: (_job, token) => {
        issuedToken = token;
      },
    });
    const engine = getApprovalEngine();

    const created = engine.request({
      tool: "delete_file",
      args: { path: "D:\\secret.txt" },
      sessionId: "session_wrong_token",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => {
        executed = true;
        return { success: true };
      },
    });
    assert.equal(created.kind, "created");
    const jobId = created.job.id;
    assert.ok(issuedToken);

    // Provide invalid guess token
    const wrongResult = await executeNativeDecision(jobId, "approved", "invalid_forged_token_xyz", {
      journalPath,
    });
    assert.equal(wrongResult.ok, false);
    assert.equal(wrongResult.code, "INVALID_CAPABILITY_TOKEN");

    // Capability is now consumed (.consumed), subsequent attempt with correct token fails
    const secondResult = await executeNativeDecision(jobId, "approved", issuedToken, {
      journalPath,
    });
    assert.equal(secondResult.ok, false);
    assert.equal(secondResult.code, "ALREADY_CONSUMED");

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executed, false, "Tool must never run with invalid token");

    cleanup(journalPath);
  });

  await t.test("4. Token Isolation: token for Job A cannot decide Job B", async () => {
    const journalPath = tempJournalPath("token-isolation");
    let tokenA: string | undefined;
    let tokenB: string | undefined;

    initializeApprovalPersistence(journalPath, {
      crossProcess: false,
      notifyApprovals: true,
      notifier: (job, token) => {
        if (job.tool === "tool_a") tokenA = token;
        if (job.tool === "tool_b") tokenB = token;
      },
    });
    const engine = getApprovalEngine();

    const jobA = engine.request({
      tool: "tool_a",
      args: { id: "a" },
      sessionId: "session_iso",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => ({ ok: true }),
    });
    const jobB = engine.request({
      tool: "tool_b",
      args: { id: "b" },
      sessionId: "session_iso",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => ({ ok: true }),
    });

    assert.equal(jobA.kind, "created");
    assert.equal(jobB.kind, "created");
    assert.ok(tokenA);
    assert.ok(tokenB);
    assert.notEqual(tokenA, tokenB);

    // Attempt to decide Job B using Token A
    const crossDecideResult = await executeNativeDecision(
      jobB.job.id,
      "approved",
      tokenA,
      { journalPath }
    );
    assert.equal(crossDecideResult.ok, false);
    assert.equal(crossDecideResult.code, "INVALID_CAPABILITY_TOKEN");

    // Job B was consumed by the failed attempt, Job A remains awaiting_approval
    assert.equal(engine.get(jobA.job.id)?.state, "awaiting_approval");

    // Now decide Job A with Token A -> must succeed
    const validAResult = await executeNativeDecision(
      jobA.job.id,
      "approved",
      tokenA,
      { journalPath }
    );
    assert.equal(validAResult.ok, true);

    cleanup(journalPath);
  });

  await t.test("5. Authoritative Binding: tampered fingerprint is rejected", async () => {
    const journalPath = tempJournalPath("tamper-binding");
    let issuedToken: string | undefined;

    initializeApprovalPersistence(journalPath, {
      crossProcess: false,
      notifyApprovals: true,
      notifier: (_job, token) => {
        issuedToken = token;
      },
    });
    const engine = getApprovalEngine();

    const created = engine.request({
      tool: "critical_command",
      args: { target: "production" },
      sessionId: "session_tamper",
      ttlMs: 60_000,
      maxPending: 10,
      execute: async () => ({ done: true }),
    });
    assert.equal(created.kind, "created");
    const jobId = created.job.id;
    assert.ok(issuedToken);

    // Tamper the fingerprint in the on-disk capability file
    const dir = capabilitiesDirectory(journalPath);
    const capPath = path.join(dir, `${jobId}.json`);
    const capData = JSON.parse(fs.readFileSync(capPath, "utf8"));
    capData.fingerprint = "tampered_fake_fingerprint";
    fs.writeFileSync(capPath, JSON.stringify(capData, null, 2), "utf8");

    // Attempt activation
    const result = await executeNativeDecision(jobId, "approved", issuedToken, {
      journalPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BINDING_MISMATCH");

    cleanup(journalPath);
  });

  await t.test("6. Expiration: expired capability fails closed and never executes", async () => {
    const journalPath = tempJournalPath("expired");
    let executed = false;
    let issuedToken: string | undefined;

    initializeApprovalPersistence(journalPath, {
      crossProcess: false,
      notifyApprovals: true,
      notifier: (_job, token) => {
        issuedToken = token;
      },
    });
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
    assert.ok(issuedToken);

    // Manually backdate the capability file to simulate expiry
    const dir = capabilitiesDirectory(journalPath);
    const capPath = path.join(dir, `${jobId}.json`);
    const capData = JSON.parse(fs.readFileSync(capPath, "utf8"));
    capData.expiresAt = Date.now() - 5000;
    fs.writeFileSync(capPath, JSON.stringify(capData, null, 2), "utf8");

    const result = await executeNativeDecision(jobId, "approved", issuedToken, {
      journalPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "EXPIRED");

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executed, false, "Expired job must never execute tool");

    cleanup(journalPath);
  });

  await t.test("7. Stale Toast on Engine Restart: recovered unknown jobs refuse activation", async () => {
    const journalPath = tempJournalPath("stale-restart");

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

    // Issue capability with token
    const issued = issueDecisionCapability(created.job, journalPath);
    assert.ok(issued);

    // Second instance: starts up and recovers from journal
    initializeApprovalPersistence(journalPath, { crossProcess: false });
    const engine2 = getApprovalEngine();
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

    // Clicking toast from earlier run with the token
    const result = await executeNativeDecision(jobId, "approved", issued.token, {
      journalPath,
    });
    assert.equal(result.ok, false);

    cleanup(journalPath);
  });

  await t.test("8. Dead Owner Process: cross-process activator fails closed if owning PID is dead", async () => {
    const journalPath = tempJournalPath("dead-owner");
    const jobId = "job_dead_owner_test_123";

    const dir = capabilitiesDirectory(journalPath);
    fs.mkdirSync(dir, { recursive: true });

    const rawToken = "dead_owner_test_token_1234567890";
    const tokenVerifier = crypto
      .createHash("sha256")
      .update(rawToken, "utf8")
      .digest("hex");

    const cap = {
      version: 2,
      jobId,
      fingerprint: "fp_dead",
      instanceId: "inst_dead",
      pid: 999999, // Dead PID
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
      tokenVerifier,
      allowedDecisions: ["approved", "denied"],
    };
    fs.writeFileSync(path.join(dir, `${jobId}.json`), JSON.stringify(cap, null, 2), "utf8");

    resetApprovalEngine();

    const result = await executeNativeDecision(jobId, "approved", rawToken, {
      journalPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "OWNER_UNAVAILABLE");

    cleanup(journalPath);
  });

  await t.test("9. Race Condition: Dashboard / CLI vs Native UX", async () => {
    const journalPath = tempJournalPath("race-dashboard");
    let issuedToken: string | undefined;

    initializeApprovalPersistence(journalPath, {
      crossProcess: false,
      auditDecisions: true,
      notifyApprovals: true,
      notifier: (_job, token) => {
        issuedToken = token;
      },
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
    assert.ok(issuedToken);

    // Dashboard denies first
    const denyOutcome = engine.deny(jobId, "dashboard");
    assert.equal(denyOutcome.ok, true);

    // Capability is invalidated proactively by onDecision hook
    const nativeResult = await executeNativeDecision(jobId, "approved", issuedToken, {
      journalPath,
    });
    assert.equal(nativeResult.ok, false);
    assert.equal(nativeResult.code, "ALREADY_CONSUMED");

    // Confirm job state remains denied
    assert.equal(engine.get(jobId)?.state, "denied");

    cleanup(journalPath);
  });

  await t.test("10. Protocol URI & Argument Sanitization / Path Traversal Rejection", async () => {
    const valid = parseApprovalProtocolUri(
      "winhelm-approval:decide?jobId=job_abc-123_XYZ&decision=approved&token=abc123token"
    );
    assert.equal(valid.jobId, "job_abc-123_XYZ");
    assert.equal(valid.decision, "approved");
    assert.equal(valid.token, "abc123token");

    // Invalid decision actions
    const invalidDecision = parseApprovalProtocolUri(
      "winhelm-approval:decide?jobId=job_123&decision=malicious_action&token=tok"
    );
    assert.equal(invalidDecision.decision, undefined);

    // Path traversal in jobId
    const pathTraversalResult = await executeNativeDecision(
      "job_../../etc/passwd",
      "approved",
      "tok"
    );
    assert.equal(pathTraversalResult.ok, false);
    assert.equal(pathTraversalResult.code, "INVALID_ARGUMENT");

    // Command injection in jobId
    const injectionResult = await executeNativeDecision(
      "job_123;rmdir /s /q C:\\",
      "approved",
      "tok"
    );
    assert.equal(injectionResult.ok, false);
    assert.equal(injectionResult.code, "INVALID_ARGUMENT");

    // Null byte injection
    const nullByteResult = await executeNativeDecision(
      "job_123\0admin",
      "approved",
      "tok"
    );
    assert.equal(nullByteResult.ok, false);
    assert.equal(nullByteResult.code, "INVALID_ARGUMENT");
  });

  await t.test("11. Windows ACL/DACL Verification: capability store enforces user-only permissions", async () => {
    if (process.platform !== "win32") return;

    const journalPath = tempJournalPath("windows-acl");
    const dir = capabilitiesDirectory(journalPath);
    fs.mkdirSync(dir, { recursive: true });

    // Explicitly harden directory ACL
    hardenCapabilitiesDirectory(dir);

    // Issue capability inside directory
    const issued = issueDecisionCapability(
      {
        id: "job_acl_test_001",
        fingerprint: "fp_acl",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      journalPath
    );
    assert.ok(issued);

    // Inspect actual Windows DACL using icacls.exe
    const icaclsOutput = execFileSync("icacls.exe", [dir], { encoding: "utf8" });
    const username = process.env.USERNAME;

    assert.ok(username, "USERNAME env must exist on Windows");
    // Verify current user has Full Control
    assert.ok(
      icaclsOutput.includes(username),
      "Directory ACL must explicitly include current Windows user"
    );
    assert.ok(
      icaclsOutput.includes("(OI)(CI)F") || icaclsOutput.includes("(OI)(CI)(F)"),
      "User permission must include Full Control inheritance"
    );

    // Verify record file inherits user permissions
    const recordFile = path.join(dir, "job_acl_test_001.json");
    const fileAcl = execFileSync("icacls.exe", [recordFile], { encoding: "utf8" });
    assert.ok(fileAcl.includes(username));

    cleanup(journalPath);
  });

  await t.test("12. Stale capability sweep cleans old records while keeping active ones", async () => {
    const journalPath = tempJournalPath("sweep");
    const dir = capabilitiesDirectory(journalPath);
    fs.mkdirSync(dir, { recursive: true });

    const recentPath = path.join(dir, "job_recent.json");
    const oldPath = path.join(dir, "job_old.consumed");

    fs.writeFileSync(recentPath, "{}", "utf8");
    fs.writeFileSync(oldPath, "{}", "utf8");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, twoHoursAgo, twoHoursAgo);

    sweepStaleCapabilities(journalPath);

    assert.equal(fs.existsSync(recentPath), true, "Recent capability must be preserved");
    assert.equal(fs.existsSync(oldPath), false, "Stale record (>1hr) must be swept");

    cleanup(journalPath);
  });
});
