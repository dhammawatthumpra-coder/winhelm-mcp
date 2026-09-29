import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { taskManager } from "../../src/engine/task-manager.js";
import { ConfigManager } from "../../src/config/config-manager.js";

describe("TaskManager (Background Terminal Engine)", () => {
  before(async () => {
    await ConfigManager.getInstance().updateConfig({ allowedDirectories: [process.cwd()] }, false);
  });

  after(() => {
    taskManager.killAll();
  });

  it("should start a background command and list it", async () => {
    // Start a ping command running in background
    const summary = taskManager.startTask('Write-Output "Task running"; Start-Sleep -Seconds 5; Write-Output "Task finished"');
    assert.ok(summary.id);
    assert.strictEqual(summary.status, "running");

    const tasks = taskManager.listTasks();
    const found = tasks.find((t) => t.id === summary.id);
    assert.ok(found);
    assert.strictEqual(found.status, "running");

    // Wait for output to arrive in buffer (with polling for reliable CI/heavy CPU loads)
    let logs = "";
    const startWait = Date.now();
    while (Date.now() - startWait < 10000) {
      const logRes = taskManager.getTaskLogs(summary.id);
      logs = logRes.logs;
      if (logs.includes("Task running")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(logs.includes("Task running"));

    // Kill task
    const killRes = taskManager.killTask(summary.id);
    assert.strictEqual(killRes.success, true);
  });

  it("should reject blocked commands in background tasks", () => {
    assert.throws(
      () => {
        taskManager.startTask("Format-Volume -DriveLetter C");
      },
      /blocked by security policy/
    );
  });
});
