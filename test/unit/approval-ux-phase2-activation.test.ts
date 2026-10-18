import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  issueDecisionCapability,
  readDecisionCapability,
  consumeDecisionCapability,
  capabilitiesDirectory,
} from "../../src/approval/decision-capability.js";
import {
  executeNativeDecision,
  parseApprovalProtocolUri,
} from "../../src/approval/decision-activator.js";
import {
  ApprovalEngine,
} from "../../src/approval/approval-engine.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
  initializeApprovalPersistence,
} from "../../src/approval/runtime.js";
import {
  runControlCliCommand,
} from "../../src/cli/commands.js";
import {
  consumeOwnedDecisions,
} from "../../src/approval/cross-process.js";

describe("Phase 2: Decision Capability Store — Lifecycle & Invariants", () => {
  it("issues a decision capability bound to exact jobId and fingerprint", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cap-test-"));
    const journalPath = path.join(dir, "approval-jobs.json");

    try {
      const job = {
        id: "job_cap_001",
        fingerprint: "sha256-fingerprint-abc",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };

      const issued = issueDecisionCapability(job, journalPath);
      assert.ok(issued);
      assert.strictEqual(issued.jobId, "job_cap_001");
      assert.strictEqual(issued.fingerprint, "sha256-fingerprint-abc");
      assert.ok(issued.nonce.length >= 32);

      const read = readDecisionCapability("job_cap_001", journalPath);
      assert.ok(read);
      assert.strictEqual(read.jobId, "job_cap_001");
      assert.strictEqual(read.nonce, issued.nonce);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces single-use consumption atomically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cap-test-"));
    const journalPath = path.join(dir, "approval-jobs.json");

    try {
      const job = {
        id: "job_cap_single_use",
        fingerprint: "fp-123",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };

      issueDecisionCapability(job, journalPath);

      // First consumption succeeds
      const first = consumeDecisionCapability("job_cap_single_use", journalPath);
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.capability.jobId, "job_cap_single_use");

      // Second consumption must fail with ALREADY_CONSUMED
      const second = consumeDecisionCapability("job_cap_single_use", journalPath);
      assert.strictEqual(second.ok, false);
      assert.strictEqual(second.code, "ALREADY_CONSUMED");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects expired decision capabilities", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cap-test-"));
    const journalPath = path.join(dir, "approval-jobs.json");

    try {
      const job = {
        id: "job_cap_expired",
        fingerprint: "fp-exp",
        createdAt: Date.now() - 10_000,
        expiresAt: Date.now() - 1_000, // already expired
      };

      issueDecisionCapability(job, journalPath);

      const outcome = consumeDecisionCapability("job_cap_expired", journalPath);
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(outcome.code, "EXPIRED");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns NOT_FOUND for unknown jobId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cap-test-"));
    const journalPath = path.join(dir, "approval-jobs.json");

    try {
      const outcome = consumeDecisionCapability("job_nonexistent", journalPath);
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(outcome.code, "NOT_FOUND");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Phase 2: Protocol URI Parsing", () => {
  it("parses winhelm-approval protocol URI with decision and jobId", () => {
    const uri = "winhelm-approval:decide?jobId=job_abc-123&decision=approved";
    const parsed = parseApprovalProtocolUri(uri);
    assert.strictEqual(parsed.jobId, "job_abc-123");
    assert.strictEqual(parsed.decision, "approved");

    const denyUri = "winhelm-approval://decide?jobId=job_xyz-999&decision=denied";
    const parsedDeny = parseApprovalProtocolUri(denyUri);
    assert.strictEqual(parsedDeny.jobId, "job_xyz-999");
    assert.strictEqual(parsedDeny.decision, "denied");
  });

  it("rejects invalid decisions in protocol URI", () => {
    const uri = "winhelm-approval:decide?jobId=job_1&decision=hacked";
    const parsed = parseApprovalProtocolUri(uri);
    assert.strictEqual(parsed.jobId, "job_1");
    assert.strictEqual(parsed.decision, undefined);
  });
});

describe("Phase 2: Secure Decision Execution — Local Engine Flow", () => {
  it("approves a local job through the narrow decision channel and executes tool", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-decide-local-"));
    const journalPath = path.join(dir, "approval-jobs.json");

    try {
      let toolExecuted = false;
      initializeApprovalPersistence(journalPath, {
        notifyApprovals: false,
      });

      const outcome = getApprovalEngine().request({
        tool: "file_write",
        args: { path: "D:\\test.txt" },
        sessionId: "sess-local",
        ttlMs: 60_000,
        maxPending: 5,
        execute: async () => {
          toolExecuted = true;
          return { written: true };
        },
      });

      assert.strictEqual(outcome.kind, "created");
      const jobId = outcome.job.id;

      // Issue capability
      issueDecisionCapability(outcome.job, journalPath);

      // Execute approval
      const decisionResult = await executeNativeDecision(jobId, "approved", {
        channel: "native_ux",
        journalPath,
        notifyOutcome: false,
      });

      assert.strictEqual(decisionResult.ok, true);
      assert.strictEqual(decisionResult.jobId, jobId);

      // Wait for async execution
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(toolExecuted, true);
      assert.strictEqual(getApprovalEngine().get(jobId)?.state, "completed");

      // Repeated activation fails due to single-use capability consumption
      const secondResult = await executeNativeDecision(jobId, "approved", {
        channel: "native_ux",
        journalPath,
        notifyOutcome: false,
      });
      assert.strictEqual(secondResult.ok, false);
      assert.strictEqual(secondResult.code, "ALREADY_CONSUMED");
    } finally {
      resetApprovalEngine();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("denies a local job through the narrow decision channel and NEVER executes tool", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-decide-deny-"));
    const journalPath = path.join(dir, "approval-jobs.json");

    try {
      let toolExecuted = false;
      initializeApprovalPersistence(journalPath);

      const outcome = getApprovalEngine().request({
        tool: "process_kill",
        args: { pid: 1234 },
        sessionId: "sess-deny",
        ttlMs: 60_000,
        maxPending: 5,
        execute: async () => {
          toolExecuted = true;
          return { killed: true };
        },
      });

      assert.strictEqual(outcome.kind, "created");
      const jobId = outcome.job.id;

      issueDecisionCapability(outcome.job, journalPath);

      const decisionResult = await executeNativeDecision(jobId, "denied", {
        channel: "native_ux",
        journalPath,
        notifyOutcome: false,
      });

      assert.strictEqual(decisionResult.ok, true);
      assert.strictEqual(decisionResult.state, "denied");

      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(toolExecuted, false); // Must never execute
      assert.strictEqual(getApprovalEngine().get(jobId)?.state, "denied");
    } finally {
      resetApprovalEngine();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Phase 2: CLI Activation Command (winhelm approval-activate)", () => {
  it("activates an approval decision from flags --job and --decision", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cli-activate-"));
    const journalPath = path.join(dir, "approval-jobs.json");
    const prevJournalEnv = process.env.WINHELM_APPROVAL_JOURNAL_PATH;
    process.env.WINHELM_APPROVAL_JOURNAL_PATH = journalPath;

    try {
      let toolExecuted = false;
      initializeApprovalPersistence(journalPath);

      const outcome = resetApprovalEngine().request({
        tool: "file_write",
        args: { path: "D:\\test.txt" },
        sessionId: "sess-cli",
        ttlMs: 60_000,
        maxPending: 5,
        execute: async () => {
          toolExecuted = true;
          return { ok: true };
        },
      });

      const jobId = outcome.job.id;
      issueDecisionCapability(outcome.job, journalPath);

      const result = await runControlCliCommand([
        "approval-activate",
        "--job",
        jobId,
        "--decision",
        "approved",
      ]);

      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output?.includes("Approved"));

      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(toolExecuted, true);
    } finally {
      resetApprovalEngine();
      if (prevJournalEnv === undefined) delete process.env.WINHELM_APPROVAL_JOURNAL_PATH;
      else process.env.WINHELM_APPROVAL_JOURNAL_PATH = prevJournalEnv;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("activates an approval decision directly from protocol URI argument", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cli-proto-"));
    const journalPath = path.join(dir, "approval-jobs.json");
    const prevJournalEnv = process.env.WINHELM_APPROVAL_JOURNAL_PATH;
    process.env.WINHELM_APPROVAL_JOURNAL_PATH = journalPath;

    try {
      let toolExecuted = false;
      initializeApprovalPersistence(journalPath);

      const outcome = resetApprovalEngine().request({
        tool: "file_write",
        args: { path: "D:\\test.txt" },
        sessionId: "sess-proto",
        ttlMs: 60_000,
        maxPending: 5,
        execute: async () => {
          toolExecuted = true;
          return { ok: true };
        },
      });

      const jobId = outcome.job.id;
      issueDecisionCapability(outcome.job, journalPath);

      const result = await runControlCliCommand([
        "approval-activate",
        `winhelm-approval:decide?jobId=${jobId}&decision=denied`,
      ]);

      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.output?.includes("Denied"));

      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(toolExecuted, false);
      assert.strictEqual(getApprovalEngine().get(jobId)?.state, "denied");
    } finally {
      resetApprovalEngine();
      if (prevJournalEnv === undefined) delete process.env.WINHELM_APPROVAL_JOURNAL_PATH;
      else process.env.WINHELM_APPROVAL_JOURNAL_PATH = prevJournalEnv;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fails safely when arguments are malformed or missing", async () => {
    const result = await runControlCliCommand(["approval-activate"]);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.error?.includes("Usage:"));
  });
});
