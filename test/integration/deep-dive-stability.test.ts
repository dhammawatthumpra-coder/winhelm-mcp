import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createServer } from "../../src/gateway/server.js";
import { taskManager } from "../../src/engine/task-manager.js";
import { execSync } from "node:child_process";

describe("Deep Dive System Stability & Concurrency Stress Test", () => {
  const STRESS_PORT = 8799;
  let server: Server;
  let stopServer: (s: Server) => Promise<void>;

  before(async () => {
    const { ConfigManager } = await import("../../src/config/config-manager.js");
    await ConfigManager.getInstance().updateConfig({ allowedDirectories: [process.cwd()] }, false);

    const gateway = createServer({
      port: STRESS_PORT,
      host: "127.0.0.1",
    });
    stopServer = gateway.stop;
    server = await gateway.start();
  });

  after(async () => {
    await stopServer(server);
    taskManager.killAll();
  });

  it("should handle 30 concurrent HTTP requests with zero failure and stable memory", async () => {
    const memBefore = process.memoryUsage().rss / (1024 * 1024);
    const endpoints = [
      `http://127.0.0.1:${STRESS_PORT}/health`,
      `http://127.0.0.1:${STRESS_PORT}/api/monitor/stats`,
      `http://127.0.0.1:${STRESS_PORT}/dashboard`,
      `http://127.0.0.1:${STRESS_PORT}/preview?path=package.json`,
    ];

    const requests = Array.from({ length: 30 }, (_, i) => {
      const url = endpoints[i % endpoints.length];
      return fetch(url).then(async (res) => {
        assert.strictEqual(res.status, 200, `Request to ${url} should return 200`);
        const text = await res.text();
        assert.ok(text.length > 0, "Response body should not be empty");
        return res.status;
      });
    });

    const results = await Promise.all(requests);
    assert.strictEqual(results.length, 30);
    assert.ok(results.every((s) => s === 200));

    const memAfter = process.memoryUsage().rss / (1024 * 1024);
    const memDelta = memAfter - memBefore;
    // Memory delta should not balloon after 30 concurrent requests
    assert.ok(memDelta < 50, `Memory delta (${memDelta.toFixed(2)} MB) should be under 50 MB`);
  });

  it("should start background tasks and terminate process trees with zero zombie processes", async () => {
    // Start long-running background task
    const t1 = taskManager.startTask("Start-Sleep -Seconds 60", process.cwd());
    assert.ok(t1.id, "Task ID should exist");
    assert.ok(t1.pid, "PID should exist");

    const pid = t1.pid;

    // Verify process is actually alive in Windows
    const isAliveBefore = () => {
      try {
        const out = execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`, {
          encoding: "utf-8",
        }).trim();
        return out === String(pid);
      } catch {
        return false;
      }
    };

    assert.strictEqual(isAliveBefore(), true, "Process should be alive in Windows before kill");

    // Kill task
    const killRes = taskManager.killTask(t1.id);
    assert.strictEqual(killRes.success, true);

    // Wait 500ms for OS to clean handle
    await new Promise((r) => setTimeout(r, 500));

    // Verify process is DEAD in Windows (no zombie)
    const isAliveAfter = isAliveBefore();
    assert.strictEqual(isAliveAfter, false, "Process must be completely dead with zero zombie leakage in Windows");
  });

  it("should gracefully stop server and immediately rebind without EADDRINUSE", async () => {
    const REBIND_PORT = 8791;
    const g1 = createServer({ port: REBIND_PORT, host: "127.0.0.1" });
    const s1 = await g1.start();

    // Verify s1 is responding
    const res1 = await fetch(`http://127.0.0.1:${REBIND_PORT}/health`);
    assert.strictEqual(res1.status, 200);

    // Stop s1
    await g1.stop(s1);
    await new Promise((r) => setTimeout(r, 100));

    // Immediately start s2 on the exact same port
    const g2 = createServer({ port: REBIND_PORT, host: "127.0.0.1" });
    let bindError: Error | null = null;
    let s2: Server | null = null;
    try {
      s2 = await g2.start();
      const res2 = await fetch(`http://127.0.0.1:${REBIND_PORT}/health`);
      assert.strictEqual(res2.status, 200);
    } catch (err) {
      bindError = err as Error;
    } finally {
      if (s2) await g2.stop(s2);
    }

    assert.strictEqual(bindError, null, "Server should immediately rebind without port collision");
  });
});
