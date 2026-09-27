import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROFILES, isToolInProfile, isValidProfile } from "../../src/config/profiles.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../src/tools/index.js";

describe("Tool Profiles System", () => {
  it("should have valid definitions for all 4 profiles", () => {
    assert.strictEqual(isValidProfile("core"), true);
    assert.strictEqual(isValidProfile("dev"), true);
    assert.strictEqual(isValidProfile("sysadmin"), true);
    assert.strictEqual(isValidProfile("full"), true);
    assert.strictEqual(isValidProfile("invalid"), false);

    assert.strictEqual(PROFILES.core.tools.length, 15, "Core profile must have 15 tools");
    assert.strictEqual(PROFILES.dev.tools.length, 25, "Dev profile must have 25 tools");
    assert.strictEqual(PROFILES.sysadmin.tools.length, 32, "Sysadmin profile must have 32 tools");
    assert.strictEqual(PROFILES.full.tools.length, 38, "Full profile must have 38 tools");
  });

  it("should correctly check tool membership with isToolInProfile", () => {
    // terminal_run is in all profiles
    assert.strictEqual(isToolInProfile("terminal_run", "core"), true);
    assert.strictEqual(isToolInProfile("terminal_run", "dev"), true);
    assert.strictEqual(isToolInProfile("terminal_run", "sysadmin"), true);
    assert.strictEqual(isToolInProfile("terminal_run", "full"), true);

    // terminal_task_start is in dev, sysadmin, full, but NOT core
    assert.strictEqual(isToolInProfile("terminal_task_start", "core"), false);
    assert.strictEqual(isToolInProfile("terminal_task_start", "dev"), true);
    assert.strictEqual(isToolInProfile("terminal_task_start", "sysadmin"), true);
    assert.strictEqual(isToolInProfile("terminal_task_start", "full"), true);

    // service_control is in sysadmin, full, but NOT dev or core
    assert.strictEqual(isToolInProfile("service_control", "core"), false);
    assert.strictEqual(isToolInProfile("service_control", "dev"), false);
    assert.strictEqual(isToolInProfile("service_control", "sysadmin"), true);
    assert.strictEqual(isToolInProfile("service_control", "full"), true);
  });

  it("should register exactly 15 tools when profile is 'core'", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ profile: "core" });

    const server = new McpServer({ name: "test-core", version: "1.0.0" });
    registerAllTools(server);

    // Count registered tools on internal server._registeredTools
    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;
    assert.strictEqual(toolCount, 15, `Core profile must register exactly 15 tools (got ${toolCount})`);
  });

  it("should register exactly 25 tools when profile is 'dev'", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ profile: "dev" });

    const server = new McpServer({ name: "test-dev", version: "1.0.0" });
    registerAllTools(server);

    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;
    assert.strictEqual(toolCount, 25, `Dev profile must register exactly 25 tools (got ${toolCount})`);
  });

  it("should register exactly 32 tools when profile is 'sysadmin'", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ profile: "sysadmin" });

    const server = new McpServer({ name: "test-sysadmin", version: "1.0.0" });
    registerAllTools(server);

    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;
    assert.strictEqual(toolCount, 32, `Sysadmin profile must register exactly 32 tools (got ${toolCount})`);
  });

  it("should register all 38 tools when profile is 'full'", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ profile: "full" });

    const server = new McpServer({ name: "test-full", version: "1.0.0" });
    registerAllTools(server);

    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;
    assert.strictEqual(toolCount, 38, `Full profile must register all 38 tools (got ${toolCount})`);
  });
});
