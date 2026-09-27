import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

describe("Tailscale Funnel Launcher Security Gate (start-funnel.ps1)", () => {
  const tmpDir = path.resolve("./test_scratch_funnel");
  const scriptPath = path.resolve("./start-funnel.ps1");
  const shell = "pwsh.exe";

  if (!existsSync(scriptPath)) {
    it.skip("start-funnel.ps1 is not present in local workspace", () => {});
    return;
  }

  it("should fail-fast with exit code 1 when no -Auth and config has no authToken", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const emptyConfigPath = path.join(tmpDir, "empty-auth-config.json");
    await fs.writeFile(emptyConfigPath, JSON.stringify({ authToken: null, allowedDirectories: [] }), "utf-8");

    try {
      execSync(`${shell} -ExecutionPolicy Bypass -File "${scriptPath}" -Config "${emptyConfigPath}"`, {
        stdio: "pipe",
        env: { ...process.env, MCP_AUTH_TOKEN: "" },
      });
      assert.fail("Expected start-funnel.ps1 without auth to fail with exit code 1");
    } catch (err: any) {
      assert.strictEqual(err.status, 1);
      const output = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
      assert.ok(output.includes("SECURITY ERROR"));
      assert.ok(output.includes("Cannot start Tailscale Funnel without authentication"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should pass security gate when -Auth is directly supplied via CLI parameter", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const emptyConfigPath = path.join(tmpDir, "empty-auth-config.json");
    await fs.writeFile(emptyConfigPath, JSON.stringify({ authToken: null }), "utf-8");

    try {
      const output = execSync(
        `${shell} -ExecutionPolicy Bypass -File "${scriptPath}" -Auth "cli-secret-token" -Config "${emptyConfigPath}" -DryRun`,
        {
          stdio: "pipe",
          env: { ...process.env, MCP_AUTH_TOKEN: "" },
        }
      ).toString();

      assert.ok(output.includes("[DRY-RUN] Security gate passed"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should pass security gate when authToken is configured in config file", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const validConfigPath = path.join(tmpDir, "valid-auth-config.json");
    await fs.writeFile(validConfigPath, JSON.stringify({ authToken: "valid-config-secret-token" }), "utf-8");

    try {
      const output = execSync(
        `${shell} -ExecutionPolicy Bypass -File "${scriptPath}" -Config "${validConfigPath}" -DryRun`,
        {
          stdio: "pipe",
          env: { ...process.env, MCP_AUTH_TOKEN: "" },
        }
      ).toString();

      assert.ok(output.includes("[DRY-RUN] Security gate passed"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
