import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigManager } from "../../src/config/config-manager.js";

describe("ConfigManager and Security Policy", () => {
  const configManager = ConfigManager.getInstance();

  it("should have default config initialized", () => {
    const config = configManager.getConfig();
    assert.ok(Array.isArray(config.blockedCommands));
    assert.ok(config.fileReadLineLimit > 0);
  });

  it("should block dangerous system commands", () => {
    const testCases = [
      "Format-Volume -DriveLetter C",
      "format-disk -Number 0",
      "clear-disk -Number 1",
      "Stop-Computer -Force",
      "rmdir /s /q C:\\",
      "del /f /s /q c:\\",
    ];

    for (const cmd of testCases) {
      const res = configManager.isCommandAllowed(cmd);
      assert.strictEqual(res.allowed, false, `Expected "${cmd}" to be blocked`);
      assert.ok(res.reason?.includes("blocked pattern"));
    }
  });

  it("should allow safe commands", () => {
    const safeCommands = [
      "Get-Process",
      "Get-ChildItem -Path .",
      'Write-Output "Hello World"',
      "git status",
    ];

    for (const cmd of safeCommands) {
      const res = configManager.isCommandAllowed(cmd);
      assert.strictEqual(res.allowed, true, `Expected "${cmd}" to be allowed`);
    }
  });

  it("should allow paths when allowedDirectories is empty", () => {
    const check = configManager.isPathAllowed("C:\\AnyPath\\file.txt");
    assert.strictEqual(check.allowed, true);
  });

  it("should allow multiple specific drives like D: and F: while blocking C:, E:, W:", async () => {
    const initialConfig = { ...configManager.getConfig() };

    // Configure strictly D: and F: in memory (persist=false) with allowSystemExecution = true
    await configManager.updateConfig(
      { allowedDirectories: ["D:", "F:"], allowSystemExecution: true },
      false
    );

    // Filesystem path validation: C:, E:, W: MUST BE BLOCKED
    assert.strictEqual(configManager.isPathAllowed("D:\\mcp\\file.txt").allowed, true);
    assert.strictEqual(configManager.isPathAllowed("F:\\projects\\app.js").allowed, true);
    assert.strictEqual(configManager.isPathAllowed("C:\\Windows\\system32").allowed, false);
    assert.strictEqual(configManager.isPathAllowed("E:\\games").allowed, false);
    assert.strictEqual(configManager.isPathAllowed("W:\\network_share").allowed, false);

    // Command validation when allowSystemExecution: true (permits runtime tools on C:)
    assert.strictEqual(configManager.isCommandAllowed("Get-ChildItem -Path D:\\").allowed, true);
    assert.strictEqual(configManager.isCommandAllowed("python -m venv .venv").allowed, true);
    assert.strictEqual(configManager.isCommandAllowed("pip install fastapi").allowed, true);
    // Destructive commands on C: must ALWAYS be blocked
    assert.strictEqual(configManager.isCommandAllowed("rmdir /s /q C:\\").allowed, false);
    assert.strictEqual(configManager.isCommandAllowed("Format-Volume -DriveLetter C").allowed, false);

    // When allowSystemExecution is explicitly false: commands targeting unallowed drives are blocked
    await configManager.updateConfig({ allowSystemExecution: false }, false);
    assert.strictEqual(configManager.isCommandAllowed("dir C:\\Windows").allowed, false);
    assert.strictEqual(configManager.isCommandAllowed("type E:\\secret.txt").allowed, false);
    assert.strictEqual(configManager.isCommandAllowed("dir D:\\").allowed, true);

    // Restore initial config in memory
    await configManager.updateConfig(initialConfig, false);
  });
});
