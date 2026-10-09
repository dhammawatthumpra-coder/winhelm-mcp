import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildRuntimeStatusSnapshot } from "../../src/status/runtime-status.js";
import { ALL_V14_TOOL_NAMES } from "../../src/tools/registry.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../src/tools/index.js";

describe("Truthful policy & status reporting (Fix 3)", () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    ConfigManager.resetInstance();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      tempRoot = null;
    }
  });

  it("reflects canonical registered tool count = 56 in status snapshot and winhelm_status", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-status-truth-"));
    const configFile = path.join(tempRoot, "winhelm.config.json");

    const config = {
      schemaVersion: 2,
      folders: [{ path: tempRoot, permission: "readwrite" }],
      profilePreset: "balanced",
      terminal: { mode: "full" },
      toolPolicy: {
        file_read: "auto",
        file_write: "ask",
      },
    };
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    const snapshot = buildRuntimeStatusSnapshot(manager);

    // 1. Canonical registered tool count = 56
    assert.strictEqual(ALL_V14_TOOL_NAMES.length, 56);
    assert.strictEqual(snapshot.canonicalRegisteredToolCount, 56);

    const gov = snapshot.toolGovernance as any;
    assert.ok(gov, "toolGovernance object must be present");
    assert.strictEqual(gov.canonicalRegisteredToolCount, 56);

    // 2. winhelm_status tool handler returns this snapshot
    const server = new McpServer({ name: "status-test", version: "1.0.0" });
    registerAllTools(server);
    const tools = (server as any)._registeredTools;
    const res = await tools.winhelm_status.handler({}, {});
    const payload = JSON.parse(res.content[0].text);

    assert.strictEqual(payload.canonicalRegisteredToolCount, 56);
    assert.strictEqual(payload.toolGovernance.canonicalRegisteredToolCount, 56);
  });

  it("explicit 45-style policy map does not falsely report total coverage and truthfully identifies terminal tools", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-status-45-"));
    const configFile = path.join(tempRoot, "winhelm.config.json");

    // Construct a synthetic 45-tool policy map
    // (45 tools from canonical surface, leaving out terminal execution tools + 6 others)
    const policyMap: Record<string, string> = {};
    const excludedFromPolicy = new Set([
      "command_run",
      "terminal_run",
      "terminal_task_start",
      "terminal_task_send",
      "terminal_task_kill",
      "git_status_structured",
      "git_diff_structured",
      "memory_info",
      "process_resource_monitor",
      "json_parse_strict",
      "json_canonical_hash",
    ]);

    for (const tool of ALL_V14_TOOL_NAMES) {
      if (!excludedFromPolicy.has(tool)) {
        policyMap[tool] = "auto";
      }
    }
    assert.strictEqual(Object.keys(policyMap).length, 45, "Must test with exactly 45 explicit policy keys");

    const config = {
      schemaVersion: 2,
      folders: [{ path: tempRoot, permission: "readwrite" }],
      profilePreset: "balanced",
      terminal: { mode: "full" },
      toolPolicy: policyMap,
      secretAuthToken: "HIGHLY_CONFIDENTIAL_TOKEN_DO_NOT_EXPOSE",
    };
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    const snapshot = buildRuntimeStatusSnapshot(manager);
    const gov = snapshot.toolGovernance as any;

    // Explicit count is 45, not 56
    assert.strictEqual(gov.explicitToolPolicyCount, 45);
    assert.strictEqual(gov.explicitPolicySummary.auto, 45);
    assert.strictEqual(gov.canonicalRegisteredToolCount, 56);

    // Separately governed terminal tools are identified correctly
    const expectedTerminalTools = [
      "command_run",
      "terminal_run",
      "terminal_task_kill",
      "terminal_task_send",
      "terminal_task_start",
    ];
    assert.deepStrictEqual(gov.separatelyGovernedTerminalTools, expectedTerminalTools);
    assert.strictEqual(gov.terminalGoverningMechanism, "terminal.mode + Approval Mode");

    // Unmapped tools count
    // 56 total - 5 terminal - 45 explicit = 6 unmapped
    assert.strictEqual(gov.unmappedToolCount, 6);
    assert.strictEqual(gov.unmappedTools.length, 6);
    assert.ok(gov.unmappedTools.includes("git_status_structured"));
    assert.ok(gov.unmappedTools.includes("json_parse_strict"));

    // Terminal tools must not be claimed as unmapped or policy_off
    for (const termTool of expectedTerminalTools) {
      assert.ok(
        !gov.unmappedTools.includes(termTool),
        `Terminal tool ${termTool} must not be reported as unmapped standard tool`
      );
    }
  });

  it("no secret or credential values are exposed in status snapshot", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-status-leak-"));
    const configFile = path.join(tempRoot, "winhelm.config.json");

    const secretMarker = "SUPER_SECRET_PRIVATE_KEY_NEVER_LEAK";

    const config = {
      schemaVersion: 2,
      folders: [{ path: tempRoot, permission: "readwrite" }],
      profilePreset: "balanced",
      terminal: { mode: "full" },
      toolPolicy: {
        file_read: "auto",
      },
      secretMarker,
      apiKeys: {
        claude: secretMarker,
      },
    };
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    const snapshot = buildRuntimeStatusSnapshot(manager);
    const serialized = JSON.stringify(snapshot);

    assert.ok(
      !serialized.includes(secretMarker),
      "Snapshot serialization must never contain secret values"
    );
  });
});
