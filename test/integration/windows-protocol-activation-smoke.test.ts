import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ApprovalEngine,
} from "../../src/approval/approval-engine.js";
import {
  initializeApprovalPersistence,
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import {
  consumeOwnedDecisions,
  resetCrossProcessInstanceId,
} from "../../src/approval/cross-process.js";
import {
  notifyApprovalPending,
} from "../../src/approval/notify.js";

describe("Windows Protocol Activation Integration Smoke Test", () => {
  it("executes real Windows protocol activation -> WinHelm activation handler -> exact approval transition", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows-only protocol activation smoke test");
      return;
    }

    // 1. Capture Registry Pre-State
    let preStateExisted = false;
    try {
      execFileSync("reg.exe", ["query", "HKCU\\Software\\Classes\\winhelm-approval"], {
        stdio: "ignore",
      });
      preStateExisted = true;
    } catch {
      preStateExisted = false;
    }

    const regKey = "HKCU\\Software\\Classes\\winhelm-approval";
    const nodeExe = process.execPath;
    const distCli = path.resolve("dist/index.js");
    const commandString = `"${nodeExe}" "${distCli}" approval-activate "%1"`;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-smoke-proto-"));
    const journalPath = path.join(dir, "approval-jobs.json");
    const prevJournalEnv = process.env.WINHELM_APPROVAL_JOURNAL_PATH;
    process.env.WINHELM_APPROVAL_JOURNAL_PATH = journalPath;

    try {
      // 2. Set temporary per-user protocol registration
      execFileSync("reg.exe", [
        "add",
        regKey,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        "URL:WinHelm Approval Protocol",
        "/f",
      ]);
      execFileSync("reg.exe", [
        "add",
        regKey,
        "/v",
        "URL Protocol",
        "/t",
        "REG_SZ",
        "/d",
        "",
        "/f",
      ]);
      execFileSync("reg.exe", [
        "add",
        `${regKey}\\shell\\open\\command`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        commandString,
        "/f",
      ]);

      // 3. Initialize WinHelm approval engine with cross-process enabled
      resetCrossProcessInstanceId();
      let notifiedPayload: any = null;
      let toolExecuted = false;

      initializeApprovalPersistence(journalPath, {
        notifyApprovals: true,
        crossProcess: true,
        notifier: (job, activationToken) => {
          void notifyApprovalPending(job, {
            activationToken,
            journalPath,
            send: async (_url, payload) => {
              notifiedPayload = payload;
            },
          });
        },
      });

      // 4. Request action requiring approval
      const outcome = getApprovalEngine().request({
        tool: "restart_service",
        args: { service: "spooler" },
        sessionId: "smoke-protocol-session",
        ttlMs: 60_000,
        maxPending: 5,
        execute: async () => {
          toolExecuted = true;
          return { restarted: true };
        },
      });

      const jobId = outcome.job.id;

      // Allow notification to be composed
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(notifiedPayload, "Toast notification payload must be created");

      const approveAction = notifiedPayload.actions.find(
        (a: any) => a.content === "Approve"
      );
      assert.ok(approveAction, "Approve action must exist");
      const actionUri = approveAction.arguments;
      assert.ok(actionUri.startsWith("winhelm-approval:decide?"));
      assert.ok(actionUri.includes("&token="));
      assert.ok(actionUri.includes("&journal="));

      // 5. Trigger REAL Windows Shell protocol activation via Start-Process
      // Windows shell parses the URI, queries HKCU\Software\Classes\winhelm-approval,
      // and spawns `node dist/index.js approval-activate "<actionUri>"`
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Start-Process '${actionUri}'`,
      ]);

      // 6. Owning process coordination consumes the decision written by the external handler
      let transitioned = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 100));
        consumeOwnedDecisions(
          (id) => getApprovalEngine().ownsJob(id),
          (id, decision) => {
            if (decision === "approved") getApprovalEngine().approve(id, "native_toast");
            else getApprovalEngine().deny(id, "native_toast");
          },
          journalPath
        );

        const currentJob = getApprovalEngine().get(jobId);
        if (currentJob && currentJob.state === "completed") {
          transitioned = true;
          break;
        }
      }

      assert.strictEqual(
        transitioned,
        true,
        "Job must transition to completed via real Windows protocol activation"
      );
      assert.strictEqual(toolExecuted, true, "Tool callback must have executed");
    } finally {
      resetApprovalEngine();
      if (prevJournalEnv === undefined) delete process.env.WINHELM_APPROVAL_JOURNAL_PATH;
      else process.env.WINHELM_APPROVAL_JOURNAL_PATH = prevJournalEnv;

      // 7. Cleanup & Restore Pre-State faithfully
      if (!preStateExisted) {
        try {
          execFileSync("reg.exe", ["delete", regKey, "/f"], { stdio: "ignore" });
        } catch {
          // Best effort cleanup
        }
      }

      let postStateExisted = false;
      try {
        execFileSync("reg.exe", ["query", regKey], { stdio: "ignore" });
        postStateExisted = true;
      } catch {
        postStateExisted = false;
      }
      assert.strictEqual(
        postStateExisted,
        preStateExisted,
        "Registry pre-state must be faithfully restored"
      );

      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
