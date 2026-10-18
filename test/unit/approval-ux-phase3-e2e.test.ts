import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ApprovalEngine,
} from "../../src/approval/approval-engine.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
  initializeApprovalPersistence,
} from "../../src/approval/runtime.js";
import {
  executeNativeDecision,
} from "../../src/approval/decision-activator.js";
import {
  runControlCliCommand,
} from "../../src/cli/commands.js";
import {
  consumeOwnedDecisions,
  readRequest,
  writeDecision,
  crossProcessPaths,
  resetCrossProcessInstanceId,
} from "../../src/approval/cross-process.js";
import {
  notifyApprovalPending,
  approvalJobUrl,
} from "../../src/approval/notify.js";
import {
  issueDecisionCapability,
} from "../../src/approval/decision-capability.js";
import {
  runToolWithHybridApproval,
} from "../../src/approval/tool-flow.js";

describe("Phase 3: End-to-End Native Approval UX — Local Jobs", () => {
  it("proves complete E2E flow: request -> notification -> native approve -> governed execution -> completed outcome", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-p3-local-approve-"));
    const journalPath = path.join(dir, "approval-jobs.json");
    const prevJournalEnv = process.env.WINHELM_APPROVAL_JOURNAL_PATH;
    process.env.WINHELM_APPROVAL_JOURNAL_PATH = journalPath;

    try {
      let notifiedPayload: any = null;
      let toolExecuted = false;

      // 1. Initialize runtime with notification enabled
      initializeApprovalPersistence(journalPath, {
        notifyApprovals: true,
        notifier: (job) => {
          void notifyApprovalPending(job, {
            send: async (_url, payload) => {
              notifiedPayload = payload;
            },
          });
        },
      });

      // 2. Client initiates an action requiring approval
      const engine = getApprovalEngine();
      const clientExecutionPromise = runToolWithHybridApproval({
        engine,
        tool: "file_write",
        args: {
          path: "D:\\workspace\\project\\data.json",
          content: "important data",
        },
        approval: {
          jobTtlMs: 60_000,
          maxPending: 5,
        },
        context: {
          sessionId: "local-client-session",
        },
        execute: async () => {
          toolExecuted = true;
          return { status: "success", bytes: 14 };
        },
      });

      // Give async notification hook a tick
      await new Promise((r) => setTimeout(r, 20));

      // 3. Verify notification presentation
      assert.ok(notifiedPayload, "Notification payload must be created");
      assert.strictEqual(notifiedPayload.title, "WinHelm Approval: file_write");
      assert.ok(notifiedPayload.message?.includes("Target: D:\\workspace\\project\\data.json"));
      assert.ok(notifiedPayload.actions?.length >= 2);

      const approveAction = notifiedPayload.actions.find(
        (a: any) => a.content === "Approve"
      );
      assert.ok(approveAction, "Approve action button must exist");

      // 4. Human chooses Approve via native URI activation
      const activateResult = await runControlCliCommand([
        "approval-activate",
        approveAction.arguments,
      ]);

      assert.strictEqual(activateResult.handled, true);
      assert.strictEqual(activateResult.exitCode, 0);

      // 5. Governed tool execution runs to completion
      const clientResult = await clientExecutionPromise;
      assert.strictEqual(toolExecuted, true);
      assert.deepStrictEqual(clientResult, { status: "success", bytes: 14 });

      // 6. Verify terminal state in engine
      const pendingJobs = engine.list();
      assert.strictEqual(pendingJobs.length, 1);
      assert.strictEqual(pendingJobs[0].state, "completed");
    } finally {
      resetApprovalEngine();
      if (prevJournalEnv === undefined) delete process.env.WINHELM_APPROVAL_JOURNAL_PATH;
      else process.env.WINHELM_APPROVAL_JOURNAL_PATH = prevJournalEnv;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("proves complete E2E flow: request -> notification -> native deny -> action cancelled -> tool never runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-p3-local-deny-"));
    const journalPath = path.join(dir, "approval-jobs.json");
    const prevJournalEnv = process.env.WINHELM_APPROVAL_JOURNAL_PATH;
    process.env.WINHELM_APPROVAL_JOURNAL_PATH = journalPath;

    try {
      let notifiedPayload: any = null;
      let toolExecuted = false;

      initializeApprovalPersistence(journalPath, {
        notifyApprovals: true,
        notifier: (job) => {
          void notifyApprovalPending(job, {
            send: async (_url, payload) => {
              notifiedPayload = payload;
            },
          });
        },
      });

      const engine = getApprovalEngine();
      const clientExecutionPromise = runToolWithHybridApproval({
        engine,
        tool: "process_kill",
        args: { processId: 4444 },
        approval: {
          jobTtlMs: 60_000,
          maxPending: 5,
        },
        context: {
          sessionId: "local-client-session-deny",
        },
        execute: async () => {
          toolExecuted = true;
          return { killed: true };
        },
      });

      await new Promise((r) => setTimeout(r, 20));

      assert.ok(notifiedPayload);
      const denyAction = notifiedPayload.actions.find(
        (a: any) => a.content === "Deny"
      );
      assert.ok(denyAction);

      // Human clicks Deny
      const activateResult = await runControlCliCommand([
        "approval-activate",
        denyAction.arguments,
      ]);

      assert.strictEqual(activateResult.handled, true);
      assert.strictEqual(activateResult.exitCode, 0);

      const clientResult = await clientExecutionPromise;
      // Client should receive structured APPROVAL_DENIED error
      assert.strictEqual(toolExecuted, false);
      assert.strictEqual(clientResult.isError, true);
      assert.ok(clientResult.content[0].text.includes("APPROVAL_DENIED"));

      const pendingJobs = engine.list();
      assert.strictEqual(pendingJobs.length, 1);
      assert.strictEqual(pendingJobs[0].state, "denied");
    } finally {
      resetApprovalEngine();
      if (prevJournalEnv === undefined) delete process.env.WINHELM_APPROVAL_JOURNAL_PATH;
      else process.env.WINHELM_APPROVAL_JOURNAL_PATH = prevJournalEnv;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Phase 3: End-to-End Native Approval UX — Cross-Process Jobs (DEF-02)", () => {
  it("proves cross-process approval: Stdio Instance owns job -> Decider activates -> Stdio consumes & executes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-p3-crossproc-"));
    const journalPath = path.join(dir, "approval-jobs.json");
    const prevJournalEnv = process.env.WINHELM_APPROVAL_JOURNAL_PATH;
    process.env.WINHELM_APPROVAL_JOURNAL_PATH = journalPath;

    try {
      let toolExecuted = false;

      // 1. Setup Instance A (Simulating Stdio Client owning the tool callback)
      resetCrossProcessInstanceId();
      const stdioEngine = new ApprovalEngine();
      let stdioNotifiedPayload: any = null;

      initializeApprovalPersistence(journalPath, {
        notifyApprovals: true,
        crossProcess: true,
        notifier: (job) => {
          void notifyApprovalPending(job, {
            send: async (_url, payload) => {
              stdioNotifiedPayload = payload;
            },
          });
        },
      });

      const outcome = getApprovalEngine().request({
        tool: "file_write",
        args: { path: "C:\\important\\stdio.txt" },
        sessionId: "stdio-session",
        ttlMs: 60_000,
        maxPending: 5,
        execute: async () => {
          toolExecuted = true;
          return { done: true };
        },
      });

      const jobId = outcome.job.id;
      issueDecisionCapability(outcome.job, journalPath);

      // Verify cross-process mirror was written
      const mirror = readRequest(jobId, journalPath);
      assert.ok(mirror, "Request mirror must be published for other instances");
      assert.strictEqual(mirror.job.id, jobId);

      // 2. Setup Instance B (Simulating Decider process that does NOT own the job in memory)
      // We simulate this by switching processInstanceId or running approval-activate CLI
      // Because CLI runs as a separate process context, it acts as Instance B!

      // Decider clicks Approve
      const activatePromise = runControlCliCommand([
        "approval-activate",
        `winhelm-approval:decide?jobId=${jobId}&decision=approved`,
      ]);

      // 3. Instance A background coordination poll consumes the decision
      await new Promise((r) => setTimeout(r, 50));
      consumeOwnedDecisions(
        (id) => getApprovalEngine().ownsJob(id),
        (id, decision) => {
          if (decision === "approved") getApprovalEngine().approve(id, "native_ux");
          else getApprovalEngine().deny(id, "native_ux");
        },
        journalPath
      );

      // 4. Decider completes with confirmed outcome
      const activateResult = await activatePromise;
      assert.strictEqual(activateResult.handled, true);
      assert.strictEqual(activateResult.exitCode, 0);

      // Wait for execution to settle
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(toolExecuted, true);
      assert.strictEqual(getApprovalEngine().get(jobId)?.state, "completed");
    } finally {
      resetApprovalEngine();
      if (prevJournalEnv === undefined) delete process.env.WINHELM_APPROVAL_JOURNAL_PATH;
      else process.env.WINHELM_APPROVAL_JOURNAL_PATH = prevJournalEnv;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
