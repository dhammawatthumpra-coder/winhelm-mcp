import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ApprovalMode,
  SchemaV2PermissionConfig,
} from "../../src/config/schema-v2.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import {
  setPreapprovalNetworkResolverForTesting,
} from "../../src/permissions/preapproval-absolute-deny.js";
import { registerTracedTool } from "../../src/tools/tool-wrapper.js";
import { registerNetworkTools } from "../../src/tools/network-tools.js";
import { registerTerminalTools } from "../../src/tools/terminal-tools.js";
import { registerCommandTools } from "../../src/tools/command-tools.js";
import { registerFileTools } from "../../src/tools/file-tools.js";
import { createZip } from "../../src/engine/filesystem.js";
import { taskManager } from "../../src/engine/task-manager.js";
import { parseToolErrorPayload } from "../../src/errors/tool-error.js";

type Handler = (args: any, extra: any) => Promise<any>;

function mockServer(): {
  server: any;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    server: {
      registerTool(name: string, _config: any, handler: Handler) {
        handlers.set(name, handler);
      },
      registerResource() {
        // file-tools also exposes a read-only MCP resource; irrelevant here.
      },
    },
  };
}

async function makeConfig(
  mode: ApprovalMode,
  options: {
    terminalMode?: SchemaV2PermissionConfig["terminal"]["mode"];
    toolPolicy?: Record<string, "auto" | "ask" | "off">;
    allowLoopback?: boolean;
  } = {}
): Promise<{ manager: ConfigManager; root: string; config: SchemaV2PermissionConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-preflight-"));
  const config = buildPresetConfig("balanced", {
    folders: [root],
    approvalMode: mode,
  });
  config.approval.blockHoldMs = 1_000;
  config.approval.jobTtlMs = 30_000;
  if (options.terminalMode) {
    config.terminal.mode = options.terminalMode;
  }
  if (options.toolPolicy) {
    Object.assign(config.toolPolicy, options.toolPolicy);
  }
  if (typeof options.allowLoopback === "boolean") {
    config.network.allowLoopback = options.allowLoopback;
  }

  const manager = ConfigManager.resetInstance();
  await manager.updateConfig(config as any, false);
  return { manager, root, config };
}

async function cleanupConfig(root: string): Promise<void> {
  ConfigManager.resetInstance();
  await fs.rm(root, { recursive: true, force: true });
}

function installObservedEngine(): {
  persisted: () => number;
  created: () => number;
} {
  let persistCount = 0;
  let createdCount = 0;
  resetApprovalEngine({
    persist: () => {
      persistCount += 1;
    },
    onCreated: () => {
      createdCount += 1;
    },
  });
  return {
    persisted: () => persistCount,
    created: () => createdCount,
  };
}

async function waitForPendingJob(): Promise<ReturnType<typeof getApprovalEngine>["list"] extends () => infer T ? T extends Array<infer U> ? U : never : never> {
  for (let i = 0; i < 100; i++) {
    const pending = getApprovalEngine()
      .list()
      .find((job) => job.state === "awaiting_approval");
    if (pending) return pending as any;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for approval job.");
}

function fakeWrappedTool(
  toolName: string,
  onExecute: () => void
): { handler: Handler } {
  const { server, handlers } = mockServer();
  registerTracedTool(server, toolName, {}, async () => {
    onExecute();
    return { content: [{ type: "text", text: "executed" }] };
  });
  const handler = handlers.get(toolName);
  assert.ok(handler, `${toolName} should be registered`);
  return { handler };
}

afterEach(() => {
  setPreapprovalNetworkResolverForTesting(undefined);
  resetApprovalEngine();
  ConfigManager.resetInstance();
});

describe("M1 R2 pre-approval Absolute-Deny recovery", () => {
  it("Balanced + Smart metadata http_ping denies immediately with zero job/persist/notification/action", async () => {
    const { root } = await makeConfig("smart");
    const observed = installObservedEngine();
    let actions = 0;
    try {
      const { handler } = fakeWrappedTool("http_ping", () => {
        actions += 1;
      });
      const result = await handler(
        { url: "http://169.254.169.254/latest/meta-data/" },
        { sessionId: "r2-metadata-ping" }
      );
      const error = parseToolErrorPayload(result);
      assert.strictEqual(error?.code, "NETWORK_METADATA_BLOCKED");
      assert.strictEqual(actions, 0);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
      assert.strictEqual(observed.persisted(), 0);
      assert.strictEqual(observed.created(), 0);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("Balanced + Smart metadata http_request denies immediately with zero job and zero action", async () => {
    const { root } = await makeConfig("smart");
    installObservedEngine();
    let actions = 0;
    try {
      const { handler } = fakeWrappedTool("http_request", () => {
        actions += 1;
      });
      const result = await handler(
        { url: "http://169.254.169.254/latest/meta-data/", method: "GET" },
        { sessionId: "r2-metadata-request" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "NETWORK_METADATA_BLOCKED"
      );
      assert.strictEqual(actions, 0);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("initial loopback target is denied before approval when loopback is disabled", async () => {
    const { root } = await makeConfig("smart", { allowLoopback: false });
    installObservedEngine();
    let actions = 0;
    try {
      const { handler } = fakeWrappedTool("http_ping", () => {
        actions += 1;
      });
      const result = await handler(
        { url: "http://127.0.0.1:43210/" },
        { sessionId: "r2-loopback" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "NETWORK_LOOPBACK_BLOCKED"
      );
      assert.strictEqual(actions, 0);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("active WinHelm effective-port self target is denied before approval", async () => {
    const { manager, root } = await makeConfig("smart");
    manager.setRuntimeEffectivePort(8788);
    installObservedEngine();
    let actions = 0;
    try {
      const { handler } = fakeWrappedTool("http_ping", () => {
        actions += 1;
      });
      const result = await handler(
        { url: "https://example.test:8788/health" },
        { sessionId: "r2-self-port" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "NETWORK_SELF_PORT_BLOCKED"
      );
      assert.strictEqual(actions, 0);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("hostname resolving to prohibited address is denied through deterministic DNS seam", async () => {
    const { root } = await makeConfig("smart");
    setPreapprovalNetworkResolverForTesting(async () => [
      { address: "169.254.169.254", family: 4 },
    ]);
    installObservedEngine();
    let actions = 0;
    try {
      const { handler } = fakeWrappedTool("http_ping", () => {
        actions += 1;
      });
      const result = await handler(
        { url: "https://metadata-fixture.test/" },
        { sessionId: "r2-dns-prohibited" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "NETWORK_METADATA_BLOCKED"
      );
      assert.strictEqual(actions, 0);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("permitted Balanced + Smart R2 target still creates ASK approval state", async () => {
    const { root } = await makeConfig("smart");
    setPreapprovalNetworkResolverForTesting(async () => [
      { address: "203.0.113.10", family: 4 },
    ]);
    installObservedEngine();
    let actions = 0;
    try {
      const { handler } = fakeWrappedTool("http_ping", () => {
        actions += 1;
      });
      const pendingResult = handler(
        { url: "https://allowed-fixture.test/" },
        { sessionId: "r2-network-ask" }
      );
      const job = await waitForPendingJob();
      assert.strictEqual(job.tool, "http_ping");
      assert.strictEqual(job.executionCount, 0);
      assert.strictEqual(actions, 0);
      assert.strictEqual(getApprovalEngine().list().length, 1);
      getApprovalEngine().deny(job.id, "test");
      await pendingResult;
    } finally {
      await cleanupConfig(root);
    }
  });

  it("execution-time redirect target remains denied after approval", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader(
        "Location",
        "http://169.254.169.254/latest/meta-data/"
      );
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address() as AddressInfo;

    const { root } = await makeConfig("smart", { allowLoopback: true });
    installObservedEngine();
    try {
      const { server: mcp, handlers } = mockServer();
      registerNetworkTools(mcp);
      const promise = handlers.get("http_request")!(
        { url: `http://127.0.0.1:${address.port}/start`, method: "GET" },
        { sessionId: "r2-redirect-execution" }
      );
      const job = await waitForPendingJob();
      const approved = getApprovalEngine().approve(job.id, "test");
      assert.strictEqual(approved.ok, true);
      const result = await promise;
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "NETWORK_METADATA_BLOCKED"
      );
      const finalJob = getApprovalEngine().get(job.id);
      assert.strictEqual(finalJob?.executionCount, 1);
      assert.strictEqual(finalJob?.state, "completed");
    } finally {
      server.close();
      await cleanupConfig(root);
    }
  });

  it("blocked terminal_run denies before approval and does not execute handler", async () => {
    const { root } = await makeConfig("smart");
    installObservedEngine();
    let actions = 0;
    try {
      const { handler } = fakeWrappedTool("terminal_run", () => {
        actions += 1;
      });
      const result = await handler(
        { command: "Format-Volume -DriveLetter C" },
        { sessionId: "r2-terminal-block" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "COMMAND_SECURITY_BLOCKED"
      );
      assert.strictEqual(actions, 0);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("blocked terminal_task_start creates zero approval jobs and zero background tasks", async () => {
    const { root } = await makeConfig("smart");
    installObservedEngine();
    const beforeTasks = taskManager.listTasks().length;
    try {
      const { server, handlers } = mockServer();
      registerTerminalTools(server);
      const result = await handlers.get("terminal_task_start")!(
        { command: "Format-Volume -DriveLetter C", cwd: root },
        { sessionId: "r2-task-block" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "COMMAND_SECURITY_BLOCKED"
      );
      assert.strictEqual(taskManager.listTasks().length, beforeTasks);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("blocked direct command_run denies before approval using the runner's shared display-command policy", async () => {
    const { root } = await makeConfig("smart", { terminalMode: "full" });
    installObservedEngine();
    try {
      const { server, handlers } = mockServer();
      registerCommandTools(server);
      const result = await handlers.get("command_run")!(
        {
          command: "where.exe",
          args: ["Format-Volume"],
          cwd: root,
        },
        { sessionId: "r2-direct-block" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "COMMAND_SECURITY_BLOCKED"
      );
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("permitted direct command_run still ASK under Smart", async () => {
    const { root } = await makeConfig("smart", { terminalMode: "full" });
    installObservedEngine();
    try {
      const { server, handlers } = mockServer();
      registerCommandTools(server);
      const promise = handlers.get("command_run")!(
        { command: "where.exe", args: ["node.exe"], cwd: root },
        { sessionId: "r2-direct-ask" }
      );
      const job = await waitForPendingJob();
      assert.strictEqual(job.tool, "command_run");
      assert.strictEqual(job.executionCount, 0);
      getApprovalEngine().deny(job.id, "test");
      await promise;
    } finally {
      await cleanupConfig(root);
    }
  });

  it("Trusted cannot bypass catastrophic direct command blocklist", async () => {
    const { root } = await makeConfig("trusted", { terminalMode: "full" });
    installObservedEngine();
    try {
      const { server, handlers } = mockServer();
      registerCommandTools(server);
      const result = await handlers.get("command_run")!(
        {
          command: "where.exe",
          args: ["Format-Volume"],
          cwd: root,
        },
        { sessionId: "r2-trusted-block" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "COMMAND_SECURITY_BLOCKED"
      );
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("Manual safe command_run invalid plan denies immediately with zero jobs", async () => {
    const { root } = await makeConfig("manual", { terminalMode: "safe" });
    installObservedEngine();
    try {
      const { server, handlers } = mockServer();
      registerCommandTools(server);
      const result = await handlers.get("command_run")!(
        { command: "git", args: ["--version"], cwd: root },
        { sessionId: "r2-safe-invalid" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "SAFE_COMMAND_PLAN_DENIED"
      );
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("Manual valid safe command_run still ASK", async () => {
    const { root } = await makeConfig("manual", { terminalMode: "safe" });
    installObservedEngine();
    try {
      const { server, handlers } = mockServer();
      registerCommandTools(server);
      const promise = handlers.get("command_run")!(
        { command: "npm", args: ["--version"], cwd: root },
        { sessionId: "r2-safe-manual-ask" }
      );
      const job = await waitForPendingJob();
      assert.strictEqual(job.tool, "command_run");
      assert.strictEqual(job.executionCount, 0);
      getApprovalEngine().deny(job.id, "test");
      await promise;
    } finally {
      await cleanupConfig(root);
    }
  });

  it("Smart valid safe command_run remains AUTO", async () => {
    const { root } = await makeConfig("smart", { terminalMode: "safe" });
    installObservedEngine();
    try {
      const { server, handlers } = mockServer();
      registerCommandTools(server);
      const result = await handlers.get("command_run")!(
        { command: "npm", args: ["--version"], cwd: root },
        { sessionId: "r2-safe-smart-auto" }
      );
      assert.notStrictEqual(result.isError, true);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      await cleanupConfig(root);
    }
  });

  it("Absolute Deny overrides Manual, Smart, Trusted and explicit policy ask", async () => {
    for (const mode of ["manual", "smart", "trusted"] as const) {
      const { root } = await makeConfig(mode, {
        toolPolicy: { http_ping: "ask" },
      });
      installObservedEngine();
      let actions = 0;
      try {
        const { handler } = fakeWrappedTool("http_ping", () => {
          actions += 1;
        });
        const result = await handler(
          { url: "http://169.254.169.254/latest/meta-data/" },
          { sessionId: `r2-precedence-${mode}` }
        );
        assert.strictEqual(
          parseToolErrorPayload(result)?.code,
          "NETWORK_METADATA_BLOCKED",
          mode
        );
        assert.strictEqual(actions, 0, mode);
        assert.deepStrictEqual(getApprovalEngine().list(), [], mode);
      } finally {
        await cleanupConfig(root);
      }
    }
  });

  it("Manual direct protected-path mutation is denied before approval with zero jobs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-protected-"));
    const configFile = path.join(root, "winhelm-r2.config.json");
    const config = buildPresetConfig("balanced", {
      folders: [root],
      approvalMode: "manual",
    });
    config.approval.blockHoldMs = 1_000;
    config.approval.jobTtlMs = 30_000;
    const original = JSON.stringify(config, null, 2);
    await fs.writeFile(configFile, original, "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    installObservedEngine();

    try {
      const { server, handlers } = mockServer();
      registerFileTools(server);
      const result = await handlers.get("file_write")!(
        { path: configFile, content: "must-not-write" },
        { sessionId: "r2-protected-file" }
      );
      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "FOLDER_PROTECTED_PATH"
      );
      assert.deepStrictEqual(getApprovalEngine().list(), []);
      assert.strictEqual(await fs.readFile(configFile, "utf8"), original);
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("Manual archive_unzip protected-entry inspection denies before approval and extracts nothing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-archive-"));
    const payload = path.join(root, "payload");
    const configFile = path.join(root, "winhelm-r2.config.json");
    const zipFile = path.join(root, "payload.zip");
    await fs.mkdir(payload);

    const config = buildPresetConfig("balanced", {
      folders: [root],
      approvalMode: "manual",
    });
    config.approval.blockHoldMs = 1_000;
    config.approval.jobTtlMs = 30_000;
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");
    await fs.writeFile(
      path.join(payload, path.basename(configFile)),
      '{"attackerControlled":true}',
      "utf8"
    );
    await fs.writeFile(
      path.join(payload, "benign.txt"),
      "must-not-be-extracted",
      "utf8"
    );

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    installObservedEngine();

    try {
      await createZip(payload, zipFile);
      const beforeConfig = await fs.readFile(configFile, "utf8");

      const { server, handlers } = mockServer();
      registerFileTools(server);
      const result = await handlers.get("archive_unzip")!(
        { zip_path: zipFile, target_dir: root, overwrite: true },
        { sessionId: "r2-archive-protected" }
      );

      assert.strictEqual(
        parseToolErrorPayload(result)?.code,
        "ARCHIVE_SECURITY_PREFLIGHT_DENIED"
      );
      assert.deepStrictEqual(getApprovalEngine().list(), []);
      assert.strictEqual(await fs.readFile(configFile, "utf8"), beforeConfig);
      await assert.rejects(
        () => fs.stat(path.join(root, "benign.txt")),
        /ENOENT/
      );
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("execution-time command blocklist independently revalidates state changed after preflight", async () => {
    const { manager, root } = await makeConfig("smart", {
      terminalMode: "full",
    });
    installObservedEngine();
    try {
      const { server, handlers } = mockServer();
      registerTerminalTools(server);
      const promise = handlers.get("terminal_run")!(
        { command: "Write-Output PREAPPROVAL_REVALIDATION_SENTINEL", cwd: root },
        { sessionId: "r2-command-toctou" }
      );
      const job = await waitForPendingJob();

      await manager.updateConfig(
        { blockedCommands: ["write-output"] } as any,
        false
      );

      const approved = getApprovalEngine().approve(job.id, "test");
      assert.strictEqual(approved.ok, true);
      const result = await promise;
      assert.strictEqual(result.isError, true);
      assert.match(
        result.content[0].text,
        /blocked by security policy/i
      );
      assert.strictEqual(getApprovalEngine().get(job.id)?.executionCount, 1);
    } finally {
      await cleanupConfig(root);
    }
  });
});
