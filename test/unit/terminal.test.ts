import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPowerShell } from "../../src/engine/powershell-runner.js";

describe("PowerShell Runner Engine", () => {
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
});
