import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  processKillNeedsExternalApproval,
} from "../../src/permissions/process-kill.js";
import { registerTracedTool } from "../../src/tools/tool-wrapper.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import {
  approvalRequestFingerprint,
} from "../../src/approval/approval-engine.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import { taskManager } from "../../src/engine/task-manager.js";

async function waitForApprovalJob(
  tool: string,
  timeoutMs = 5000
): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getApprovalEngine()
      .list()
      .find(
        (candidate: any) =>
          candidate.tool === tool &&
          candidate.state === "awaiting_approval"
      );
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for approval job: " + tool);
}

describe("process_kill ownership policy", () => {
  it("allows one owned running PID without forced external approval", () => {
    assert.strictEqual(
      processKillNeedsExternalApproval(
        { pid: 1234 },
        {
          ownsRunningPid(pid) {
            return pid === 1234;
          },
        }
      ),
      false
    );
  });

  it("requires external approval for unowned, name-based, or ambiguous targets", () => {
    const ownership = {
      ownsRunningPid() {
        return false;
      },
    };

    assert.strictEqual(
      processKillNeedsExternalApproval(
        { pid: 9999 },
        ownership
      ),
      true
    );
    assert.strictEqual(
      processKillNeedsExternalApproval(
        { name: "node" },
        ownership
      ),
      true
    );
    assert.strictEqual(
      processKillNeedsExternalApproval(
        { pid: 1234, name: "node" },
        {
          ownsRunningPid() {
            return true;
          },
        }
      ),
      true
    );
    assert.strictEqual(
      processKillNeedsExternalApproval(
        {},
        ownership
      ),
      true
    );
  });

  it("escalates an auto external PID to approval and enriches the local approval payload", async () => {
    resetApprovalEngine();
    const manager = ConfigManager.resetInstance();
    const candidate = buildPresetConfig("power");
    candidate.toolPolicy.process_kill = "auto";
    await manager.updateConfig(candidate, false);

    let registered: any;
    let executions = 0;
    const server = {
      registerTool(name: string, config: any, handler: any) {
        registered = { name, config, handler };
      },
    };

    try {
      registerTracedTool(
        server as any,
        "process_kill",
        {},
        async () => {
          executions += 1;
          return {
            content: [
              { type: "text", text: "fixture execution" },
            ],
          };
        }
      );

      const call = registered.handler(
        { pid: process.pid },
        {
          sessionId: "process-policy-session",
          requestId: 71,
        }
      );

      const job = await waitForApprovalJob("process_kill");
      assert.strictEqual(executions, 0);
      assert.strictEqual(
        job.sessionId,
        "process-policy-session"
      );
      assert.strictEqual(job.args.pid, process.pid);
      // Probed identity is display metadata: it must not enter the retry
      // fingerprint, otherwise an equivalent retry would not be deduped.
      assert.strictEqual(
        job.fingerprint,
        approvalRequestFingerprint("process_kill", {
          pid: process.pid,
        })
      );
      assert.ok(Array.isArray(job.args.processIdentity));
      assert.strictEqual(
        job.args.processIdentity[0].pid,
        process.pid
      );
      assert.ok(
        typeof job.args.processIdentity[0].name === "string" &&
          job.args.processIdentity[0].name.length > 0
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(
          job.args.processIdentity[0],
          "publisher"
        )
      );

      const approved = getApprovalEngine().approve(job.id);
      assert.strictEqual(approved.ok, true);

      const result = await call;
      assert.strictEqual(executions, 1);
      assert.strictEqual(result.isError, undefined);
    } finally {
      getApprovalEngine().cancelSession(
        "process-policy-session"
      );
      resetApprovalEngine();
      ConfigManager.resetInstance();
    }
  });

  it("runs an owned running task PID under normal policy without approval", async () => {
    resetApprovalEngine();
    const manager = ConfigManager.resetInstance();
    const candidate = buildPresetConfig("power");
    candidate.toolPolicy.process_kill = "auto";
    await manager.updateConfig(candidate, false);

    const owned = taskManager.startTask(
      'Write-Output "owned"; Start-Sleep -Seconds 10'
    );

    let registered: any;
    let executions = 0;
    const server = {
      registerTool(name: string, config: any, handler: any) {
        registered = { name, config, handler };
      },
    };

    try {
      assert.strictEqual(
        taskManager.ownsRunningPid(owned.pid!),
        true
      );

      registerTracedTool(
        server as any,
        "process_kill",
        {},
        async () => {
          executions += 1;
          return {
            content: [
              { type: "text", text: "fixture execution" },
            ],
          };
        }
      );

      const result = await registered.handler(
        { pid: owned.pid },
        { sessionId: "owned-pid-session", requestId: 72 }
      );

      assert.strictEqual(executions, 1);
      assert.strictEqual(result.isError, undefined);
      assert.deepStrictEqual(
        getApprovalEngine()
          .list()
          .filter((job: any) => job.tool === "process_kill"),
        []
      );
    } finally {
      taskManager.killTask(owned.id);
      getApprovalEngine().cancelSession("owned-pid-session");
      resetApprovalEngine();
      ConfigManager.resetInstance();
    }
  });
});
