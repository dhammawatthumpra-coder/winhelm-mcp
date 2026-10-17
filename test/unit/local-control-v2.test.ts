import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  getControlRegistryDir,
  LocalControlServer,
  type ControlMetadata,
} from "../../src/cli/control-server.js";
import { sendControlCommand } from "../../src/cli/control-client.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import {
  getAdminAuthManager,
  resetAdminAuthManager,
} from "../../src/admin/runtime.js";

async function withControl(
  fn: (metadataPath: string, metadata: ControlMetadata) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-control-"));
  const metadataPath = path.join(dir, "control.json");
  const server = new LocalControlServer({ metadataPath });
  resetApprovalEngine();
  resetAdminAuthManager();

  try {
    const metadata = await server.start();
    await fn(metadataPath, metadata);
  } finally {
    await server.close();
    resetApprovalEngine();
    resetAdminAuthManager();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function rawRequest(
  metadata: ControlMetadata,
  payload: Record<string, unknown>
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(metadata.pipeName);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(payload) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", reject);
  });
}

describe("Local WinHelm control channel", () => {
  it("writes primary and registry metadata and removes only its registry entry on close", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-control-meta-"));
    const metadataPath = path.join(dir, "control.json");
    const server = new LocalControlServer({
      metadataPath,
      instanceId: "metadata-instance",
    });

    try {
      const metadata = await server.start();
      const persisted = JSON.parse(
        await fs.readFile(metadataPath, "utf8")
      );
      assert.strictEqual(persisted.pipeName, metadata.pipeName);
      assert.strictEqual(persisted.capability, metadata.capability);
      assert.strictEqual(persisted.pid, process.pid);
      assert.strictEqual(persisted.instanceId, "metadata-instance");

      const registryDir = getControlRegistryDir(metadataPath);
      const beforeClose = await fs.readdir(registryDir);
      assert.strictEqual(beforeClose.length, 1);

      await server.close();

      const staleHint = JSON.parse(
        await fs.readFile(metadataPath, "utf8")
      );
      assert.strictEqual(staleHint.instanceId, "metadata-instance");
      const afterClose = await fs.readdir(registryDir);
      assert.deepStrictEqual(afterClose, []);
    } finally {
      await server.close().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a client that does not know the process capability", async () => {
    await withControl(async (_metadataPath, metadata) => {
      const response = await rawRequest(metadata, {
        capability: "wrong",
        command: "jobs",
      });
      assert.strictEqual(response.ok, false);
      assert.strictEqual(response.error.code, "UNAUTHORIZED");
    });
  });

  it("returns a read-only runtime status snapshot", async () => {
    await withControl(async (metadataPath) => {
      const status = await sendControlCommand(
        { command: "status" },
        { metadataPath }
      );
      assert.strictEqual(status.ok, true);
      assert.ok(status.status);
      assert.strictEqual(
        typeof status.status.schemaMode,
        "string"
      );
      assert.ok(status.status.profile);
      assert.ok(status.status.riskState);
      assert.ok(status.status.approval);
    });
  });

  it("lists jobs and approves an exactly-once action", async () => {
    await withControl(async (metadataPath) => {
      let executions = 0;
      const created = getApprovalEngine().request({
        tool: "fixture_action",
        args: { value: 1 },
        sessionId: "session-a",
        ttlMs: 30_000,
        maxPending: 5,
        execute: async () => {
          executions += 1;
          return "done";
        },
      });

      const jobs = await sendControlCommand(
        { command: "jobs" },
        { metadataPath }
      );
      assert.strictEqual(jobs.ok, true);
      assert.ok(jobs.jobs.some((job: any) => job.id === created.job.id));

      const approved = await sendControlCommand(
        { command: "approve", jobId: created.job.id },
        { metadataPath }
      );
      assert.strictEqual(approved.ok, true);

      const terminal = await getApprovalEngine().waitForTerminalOrReceipt(
        created.job.id,
        1_000
      );
      assert.strictEqual(terminal.kind, "terminal");
      assert.strictEqual(terminal.job.state, "completed");
      assert.strictEqual(executions, 1);

      const late = await sendControlCommand(
        { command: "approve", jobId: created.job.id },
        { metadataPath }
      );
      assert.strictEqual(late.ok, false);
      assert.strictEqual(late.error.status, 409);
      assert.strictEqual(executions, 1);
    });
  });

  it("denies a job without executing it", async () => {
    await withControl(async (metadataPath) => {
      let executions = 0;
      const created = getApprovalEngine().request({
        tool: "fixture_deny",
        args: {},
        sessionId: "session-a",
        ttlMs: 30_000,
        maxPending: 5,
        execute: async () => {
          executions += 1;
        },
      });

      const denied = await sendControlCommand(
        { command: "deny", jobId: created.job.id },
        { metadataPath }
      );
      assert.strictEqual(denied.ok, true);
      assert.strictEqual(
        getApprovalEngine().get(created.job.id)?.state,
        "denied"
      );
      assert.strictEqual(executions, 0);
    });
  });

  it("issues and refreshes admin codes inside the server process", async () => {
    await withControl(async (metadataPath) => {
      const first = await sendControlCommand(
        { command: "admin-code" },
        { metadataPath }
      );
      assert.strictEqual(first.ok, true);
      assert.ok(first.code);

      const refreshed = await sendControlCommand(
        { command: "admin-code", refresh: true },
        { metadataPath }
      );
      assert.strictEqual(refreshed.ok, true);
      assert.notStrictEqual(refreshed.code, first.code);

      assert.strictEqual(
        getAdminAuthManager().exchangeCode(first.code),
        undefined
      );
      assert.ok(
        getAdminAuthManager().exchangeCode(refreshed.code)
      );
    });
  });

  it("enforces the interactive-terminal gate in the standard client", async () => {
    await withControl(async (metadataPath) => {
      if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
        return;
      }

      await assert.rejects(
        () =>
          sendControlCommand(
            { command: "admin-code" },
            { metadataPath, requireInteractive: true }
          ),
        /interactive local terminal/i
      );
    });
  });

  it("fails over from a stale primary pointer to a live registry entry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-control-failover-"));
    const metadataPath = path.join(dir, "control.json");
    const server = new LocalControlServer({
      metadataPath,
      instanceId: "live-instance",
    });
    resetApprovalEngine();
    resetAdminAuthManager();

    try {
      await server.start();

      // Keep the PID apparently alive while poisoning only the transport
      // pointer. This proves fallback is driven by transport failure rather
      // than by a dead-PID shortcut alone.
      await fs.writeFile(
        metadataPath,
        JSON.stringify(
          {
            pipeName: `\\\\.\\pipe\\winhelm-dead-${Date.now()}`,
            capability: "stale-capability",
            pid: process.pid,
            createdAt: new Date().toISOString(),
            instanceId: "stale-instance",
          },
          null,
          2
        ),
        "utf8"
      );

      const status = await sendControlCommand(
        { command: "status" },
        { metadataPath, connectTimeoutMs: 250 }
      );
      assert.strictEqual(status.ok, true);
      assert.ok(status.status);
    } finally {
      await server.close();
      resetApprovalEngine();
      resetAdminAuthManager();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not let an older server close delete a newer server pointer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-control-race-"));
    const metadataPath = path.join(dir, "control.json");
    const older = new LocalControlServer({
      metadataPath,
      instanceId: "instance-older",
    });
    const newer = new LocalControlServer({
      metadataPath,
      instanceId: "instance-newer",
    });
    resetApprovalEngine();
    resetAdminAuthManager();

    try {
      await older.start();
      const newerMetadata = await newer.start();

      const beforeClose = JSON.parse(
        await fs.readFile(metadataPath, "utf8")
      );
      assert.strictEqual(beforeClose.instanceId, "instance-newer");

      await older.close();

      const afterOlderClose = JSON.parse(
        await fs.readFile(metadataPath, "utf8")
      );
      assert.strictEqual(afterOlderClose.instanceId, "instance-newer");
      assert.strictEqual(afterOlderClose.pipeName, newerMetadata.pipeName);

      const status = await sendControlCommand(
        { command: "status" },
        { metadataPath }
      );
      assert.strictEqual(status.ok, true);
    } finally {
      await older.close().catch(() => {});
      await newer.close().catch(() => {});
      resetApprovalEngine();
      resetAdminAuthManager();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
