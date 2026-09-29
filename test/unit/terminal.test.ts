import test, { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  runPowerShell,
  isPwshAvailable,
  getPowerShellExecutable,
  setPwshAvailableCache,
} from "../../src/engine/powershell-runner.js";

describe("PowerShell Runner Engine", () => {
  before(async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({
      allowedDirectories: [process.cwd(), os.tmpdir(), "C:\\Windows"],
      allowSystemExecution: true,
    }, false);
  });
  it("should execute command and return UTF-8 output without corruption", async () => {
    const res = await runPowerShell('Write-Output "สวัสดี Windows Native MCP UTF-8"');
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.timedOut, false);
    assert.strictEqual(res.stdout, "สวัสดี Windows Native MCP UTF-8");
  });

  it("should handle command failure and stderr", async () => {
    const res = await runPowerShell("Write-Error 'Test Error Message'");
    assert.ok(res.stderr.includes("Test Error Message") || res.exitCode !== 0);
  });

  it("should prevent execution of blocked commands", async () => {
    await assert.rejects(
      async () => {
        await runPowerShell("Format-Volume -DriveLetter C");
      },
      /blocked by security policy/
    );
  });

  it("should select pwsh.exe when available and preferred", () => {
    try {
      setPwshAvailableCache(true);
      assert.strictEqual(getPowerShellExecutable(true), "pwsh.exe");
      assert.strictEqual(getPowerShellExecutable(false), "powershell.exe");
    } finally {
      setPwshAvailableCache(null);
    }
  });

  it("should fallback to powershell.exe when pwsh is not available", () => {
    try {
      setPwshAvailableCache(false);
      assert.strictEqual(getPowerShellExecutable(true), "powershell.exe");
      assert.strictEqual(getPowerShellExecutable(false), "powershell.exe");
    } finally {
      setPwshAvailableCache(null);
    }
  });
});
