import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/config/default-config.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  DEFAULT_APPROVAL_CONFIG,
  isSchemaV2Config,
  normalizeApprovalConfig,
  validateApprovalConfig,
} from "../../src/config/schema-v2.js";
import { evaluateTerminalMode, evaluateToolPolicy } from "../../src/permissions/policy.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../src/tools/index.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";

describe("Schema-v2 configuration primitives", () => {
  it("keeps the v1.2.1 default config on the legacy path", () => {
    assert.strictEqual(DEFAULT_CONFIG.schemaVersion, undefined);
    assert.strictEqual(isSchemaV2Config(DEFAULT_CONFIG), false);
  });

  it("recognizes only schemaVersion=2 as schema-v2", () => {
    assert.strictEqual(isSchemaV2Config({ schemaVersion: 2 }), true);
    assert.strictEqual(isSchemaV2Config({ schemaVersion: 1 }), false);
    assert.strictEqual(isSchemaV2Config({}), false);
    assert.strictEqual(isSchemaV2Config({ schemaVersion: "2" }), false);
  });

  it("uses implementation-baseline approval defaults without mutating input", () => {
    const input = { maxPending: 7 };
    const normalized = normalizeApprovalConfig(input);

    assert.deepStrictEqual(normalized, {
      channels: ["dashboard", "toast"],
      blockHoldMs: 60_000,
      jobTtlMs: 180_000,
      maxPending: 7,
    });
    assert.deepStrictEqual(input, { maxPending: 7 });
    assert.deepStrictEqual(DEFAULT_APPROVAL_CONFIG, {
      channels: ["dashboard", "toast"],
      blockHoldMs: 60_000,
      jobTtlMs: 180_000,
      maxPending: 5,
    });
  });

  it("accepts approval values inside the supported implementation envelope", () => {
    const result = validateApprovalConfig({
      blockHoldMs: 30_000,
      jobTtlMs: 120_000,
      maxPending: 10,
    });

    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  it("rejects unsafe or nonsensical approval timing values", () => {
    const result = validateApprovalConfig({
      blockHoldMs: 120_000,
      jobTtlMs: 10_000,
      maxPending: 0,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 3);
    assert.ok(result.errors.some((e) => e.includes("blockHoldMs")));
    assert.ok(result.errors.some((e) => e.includes("jobTtlMs")));
    assert.ok(result.errors.some((e) => e.includes("maxPending")));
  });
});

describe("Schema-v2 permission decision primitives", () => {
  it("maps auto/ask/off tool policy deterministically", () => {
    assert.strictEqual(evaluateToolPolicy("auto").decision, "allow");
    assert.strictEqual(evaluateToolPolicy("ask").decision, "ask");
    assert.strictEqual(evaluateToolPolicy("off").decision, "deny");
  });

  it("fails closed when a schema-v2 tool policy is missing", () => {
    const decision = evaluateToolPolicy(undefined);
    assert.strictEqual(decision.decision, "deny");
    assert.strictEqual(decision.code, "POLICY_OFF");
  });

  it("keeps safe terminal mode distinct from unrestricted execution", () => {
    const safe = evaluateTerminalMode("safe");
    assert.strictEqual(safe.decision, "allow");
    assert.strictEqual(safe.code, "TERMINAL_SAFE");
  });


  it("maps terminal ask/full/off modes without changing legacy code paths", () => {
    assert.strictEqual(evaluateTerminalMode("ask").decision, "ask");
    assert.strictEqual(evaluateTerminalMode("full").decision, "allow");
    assert.strictEqual(evaluateTerminalMode("dangerous").decision, "allow");
    assert.strictEqual(evaluateTerminalMode("off").decision, "deny");
  });
});

describe("ConfigManager schema-v2 runtime mode", () => {
  async function withTempConfig(
    name: string,
    value: Record<string, unknown>,
    fn: (manager: ConfigManager) => Promise<void>
  ): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-schema-v2-"));
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(value, null, 2), "utf-8");
    try {
      const manager = ConfigManager.resetInstance(file);
      await manager.init(file);
      await fn(manager);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      ConfigManager.resetInstance();
    }
  }

  it("loads a valid schema-v2 config and normalizes approval defaults", async () => {
    await withTempConfig(
      "valid.json",
      {
        schemaVersion: 2,
        profilePreset: "balanced",
        folders: [{ path: "D:\\Workspace", permission: "readwrite" }],
        terminal: { mode: "ask" },
        toolPolicy: { system_info: "auto", http_request: "ask" },
      },
      async (manager) => {
        assert.strictEqual(manager.getConfigMode(), "v2");
        assert.deepStrictEqual(manager.getConfigValidationErrors(), []);
        assert.deepStrictEqual(manager.getConfig().approval, {
          channels: ["dashboard", "toast"],
          blockHoldMs: 60_000,
          jobTtlMs: 180_000,
          maxPending: 5,
        });
        assert.deepStrictEqual(manager.getConfig().network, {
          allowLoopback: false,
        });
      }
    );
  });

  it("fails closed for semantic-invalid schema-v2 without losing diagnostics", async () => {
    await withTempConfig(
      "invalid.json",
      {
        schemaVersion: 2,
        profilePreset: "balanced",
        folders: "D:\\Workspace",
        terminal: { mode: "full" },
        toolPolicy: { system_info: "auto" },
      },
      async (manager) => {
        assert.strictEqual(manager.getConfigMode(), "invalid");
        assert.ok(manager.getConfigValidationErrors().some((e) => e.includes("folders")));
        assert.deepStrictEqual(manager.getConfig().folders, []);
        assert.deepStrictEqual(manager.getConfig().terminal, { mode: "off" });
        assert.deepStrictEqual(manager.getConfig().toolPolicy, {});
      }
    );
  });

  it("fails closed for unsupported explicit schemaVersion instead of falling back to legacy", async () => {
    await withTempConfig(
      "unsupported.json",
      {
        schemaVersion: 3,
        allowedDirectories: ["*"],
        profile: "full",
      },
      async (manager) => {
        assert.strictEqual(manager.getConfigMode(), "invalid");
        assert.ok(manager.getConfigValidationErrors()[0]?.includes("Unsupported schemaVersion"));
        assert.deepStrictEqual(manager.getConfig().folders, []);
        assert.deepStrictEqual(manager.getConfig().terminal, { mode: "off" });
        assert.deepStrictEqual(manager.getConfig().toolPolicy, {});
      }
    );
  });

  it("can repair an invalid schema-v2 config because raw values are preserved", async () => {
    await withTempConfig(
      "repair.json",
      {
        schemaVersion: 2,
        folders: [{ path: "D:\\Workspace", permission: "readwrite" }],
        terminal: { mode: "not-a-mode" },
        toolPolicy: { system_info: "auto" },
      },
      async (manager) => {
        assert.strictEqual(manager.getConfigMode(), "invalid");
        await manager.updateConfig({ terminal: { mode: "ask" } }, false);
        assert.strictEqual(manager.getConfigMode(), "v2");
        assert.deepStrictEqual(manager.getConfig().folders, [
          { path: "D:\\Workspace", permission: "readwrite" },
        ]);
        assert.deepStrictEqual(manager.getConfig().toolPolicy, { system_info: "auto" });
      }
    );
  });

  it("registers the full current tool surface and enforces auto/ask/off at call time", async () => {
    await withTempConfig(
      "v2-gate.json",
      {
        schemaVersion: 2,
        folders: [{ path: "D:\\Workspace", permission: "readwrite" }],
        terminal: { mode: "ask" },
        toolPolicy: {
          system_info: "auto",
          http_request: "ask",
          process_kill: "off",
        },
        approval: {
          channels: ["dashboard"],
          blockHoldMs: 1000,
          jobTtlMs: 30000,
          maxPending: 5,
        },
      },
      async () => {
        resetApprovalEngine();
        const server = new McpServer({ name: "schema-v2-gate", version: "1.0.0" });
        registerAllTools(server);
        const tools = (server as any)._registeredTools;
        assert.strictEqual(Object.keys(tools).length, 41);
        assert.ok(tools.command_run);

        const autoResult = await tools["system_info"].handler({}, {});
        assert.notStrictEqual(autoResult.isError, true);

        const askPromise = tools["http_request"].handler(
          { url: "http://127.0.0.1:1/" },
          {
            sessionId: "test-session",
            requestId: 101,
            signal: new AbortController().signal,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        const httpJob = getApprovalEngine()
          .list()
          .find((job) => job.tool === "http_request");
        assert.ok(httpJob);
        assert.strictEqual(httpJob.state, "awaiting_approval");
        assert.strictEqual(httpJob.executionCount, 0);
        assert.strictEqual(getApprovalEngine().deny(httpJob.id).ok, true);

        const askResult = await askPromise;
        assert.strictEqual(askResult.isError, true);
        const askPayload = JSON.parse(askResult.content[0].text);
        assert.strictEqual(askPayload.error.code, "PERMISSION_DENIED");

        const offResult = await tools["process_kill"].handler({ pid: 4 }, {});
        assert.strictEqual(offResult.isError, true);
        const offPayload = JSON.parse(offResult.content[0].text);
        assert.strictEqual(offPayload.error.code, "TOOL_POLICY_OFF");

        const terminalPromise = tools["terminal_run"].handler(
          { command: "Write-Output should-not-run" },
          {
            sessionId: "test-session",
            requestId: 102,
            signal: new AbortController().signal,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        const terminalJob = getApprovalEngine()
          .list()
          .find((job) => job.tool === "terminal_run");
        assert.ok(terminalJob);
        assert.strictEqual(terminalJob.executionCount, 0);
        assert.strictEqual(getApprovalEngine().deny(terminalJob.id).ok, true);

        const terminalAsk = await terminalPromise;
        assert.strictEqual(terminalAsk.isError, true);
        const terminalPayload = JSON.parse(terminalAsk.content[0].text);
        assert.strictEqual(terminalPayload.error.code, "PERMISSION_DENIED");
      }
    );
  });

  it("fails all tool execution closed when an explicit schemaVersion is unsupported", async () => {
    await withTempConfig(
      "invalid-gate.json",
      {
        schemaVersion: 3,
        allowedDirectories: ["*"],
        profile: "full",
      },
      async () => {
        const server = new McpServer({ name: "invalid-v2-gate", version: "1.0.0" });
        registerAllTools(server);
        const tools = (server as any)._registeredTools;
        assert.strictEqual(Object.keys(tools).length, 41);
        assert.ok(tools.command_run);

        const result = await tools["system_info"].handler({}, {});
        assert.strictEqual(result.isError, true);
        const payload = JSON.parse(result.content[0].text);
        assert.strictEqual(payload.error.code, "CONFIGURATION_UNAVAILABLE");
        assert.ok(Array.isArray(payload.error.details.validationErrors));
      }
    );
  });
});
