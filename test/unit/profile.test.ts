import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROFILES, isToolInProfile, isValidProfile, resolveCustomTools } from "../../src/config/profiles.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../src/tools/index.js";

describe("Tool Profiles System", () => {
  it("should have valid definitions for all 5 profiles", () => {
    assert.strictEqual(isValidProfile("minimal"), true);
    assert.strictEqual(isValidProfile("core"), true);
    assert.strictEqual(isValidProfile("dev"), true);
    assert.strictEqual(isValidProfile("sysadmin"), true);
    assert.strictEqual(isValidProfile("full"), true);
    assert.strictEqual(isValidProfile("invalid"), false);

    assert.strictEqual(PROFILES.minimal.tools.length, 6, "Minimal profile must have 6 tools");
    assert.strictEqual(PROFILES.core.tools.length, 15, "Core profile must have 15 tools");
    assert.strictEqual(PROFILES.dev.tools.length, 28, "Dev profile must have 28 tools");
    assert.strictEqual(PROFILES.sysadmin.tools.length, 37, "Sysadmin profile must have 37 tools");
    assert.strictEqual(PROFILES.full.tools.length, 38, "Full profile must have 38 tools");
  });

  it("should correctly check tool membership with isToolInProfile", () => {
    // terminal_run is in all profiles
    assert.strictEqual(isToolInProfile("terminal_run", "minimal"), true);
    assert.strictEqual(isToolInProfile("terminal_run", "core"), true);
    assert.strictEqual(isToolInProfile("terminal_run", "dev"), true);
    assert.strictEqual(isToolInProfile("terminal_run", "sysadmin"), true);
    assert.strictEqual(isToolInProfile("terminal_run", "full"), true);

    // file_edit is in core, dev, sysadmin, full, but NOT minimal
    assert.strictEqual(isToolInProfile("file_edit", "minimal"), false);
    assert.strictEqual(isToolInProfile("file_edit", "core"), true);

    // terminal_task_start is in dev, sysadmin, full, but NOT core or minimal
    assert.strictEqual(isToolInProfile("terminal_task_start", "minimal"), false);
    assert.strictEqual(isToolInProfile("terminal_task_start", "core"), false);
    assert.strictEqual(isToolInProfile("terminal_task_start", "dev"), true);
    assert.strictEqual(isToolInProfile("terminal_task_start", "sysadmin"), true);
    assert.strictEqual(isToolInProfile("terminal_task_start", "full"), true);

    // service_control is in sysadmin, full, but NOT dev, core, or minimal
    assert.strictEqual(isToolInProfile("service_control", "minimal"), false);
    assert.strictEqual(isToolInProfile("service_control", "core"), false);
    assert.strictEqual(isToolInProfile("service_control", "dev"), false);
    assert.strictEqual(isToolInProfile("service_control", "sysadmin"), true);
    assert.strictEqual(isToolInProfile("service_control", "full"), true);

    // pdf_generate is in dev and full, but NOT sysadmin, core, or minimal
    assert.strictEqual(isToolInProfile("pdf_generate", "minimal"), false);
    assert.strictEqual(isToolInProfile("pdf_generate", "core"), false);
    assert.strictEqual(isToolInProfile("pdf_generate", "dev"), true);
    assert.strictEqual(isToolInProfile("pdf_generate", "sysadmin"), false);
    assert.strictEqual(isToolInProfile("pdf_generate", "full"), true);
  });

  it("should register exactly 6 tools when profile is 'minimal'", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ profile: "minimal" });

    const server = new McpServer({ name: "test-minimal", version: "1.0.0" });
    registerAllTools(server);

    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;
    assert.strictEqual(toolCount, 6, `Minimal profile must register exactly 6 tools (got ${toolCount})`);
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

  it("should register exactly 28 tools when profile is 'dev'", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ profile: "dev" });

    const server = new McpServer({ name: "test-dev", version: "1.0.0" });
    registerAllTools(server);

    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;
    assert.strictEqual(toolCount, 28, `Dev profile must register exactly 28 tools (got ${toolCount})`);
  });

  it("should register exactly 37 tools when profile is 'sysadmin'", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ profile: "sysadmin" });

    const server = new McpServer({ name: "test-sysadmin", version: "1.0.0" });
    registerAllTools(server);

    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;
    assert.strictEqual(toolCount, 37, `Sysadmin profile must register exactly 37 tools (got ${toolCount})`);
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

  it("should resolve custom tools whitelist correctly", () => {
    const list = resolveCustomTools("full", "terminal_run,file_read,file_write");
    assert.deepStrictEqual(list, ["terminal_run", "file_read", "file_write"]);
  });

  it("should extend and exclude tools with + and - modifiers", () => {
    const extended = resolveCustomTools("core", "+file_search_ripgrep");
    assert.strictEqual(extended?.includes("file_search_ripgrep"), true);
    assert.strictEqual(extended?.length, 16);

    const reduced = resolveCustomTools("core", "-file_delete_safe");
    assert.strictEqual(reduced?.includes("file_delete_safe"), false);
    assert.strictEqual(reduced?.length, 14);
  });

  it("should register custom tools when customTools is provided in config", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({
      profile: "custom",
      customTools: ["terminal_run", "file_read", "file_write"],
    });

    const server = new McpServer({ name: "test-custom", version: "1.0.0" });
    registerAllTools(server);

    const registeredTools = (server as any)._registeredTools;
    const toolCount = Object.keys(registeredTools).length;
    assert.strictEqual(toolCount, 3, `Custom profile must register exactly 3 tools (got ${toolCount})`);

    // Reset config back to full
    await configManager.updateConfig({ profile: "full", customTools: undefined });
  });
});
