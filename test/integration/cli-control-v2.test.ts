import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { LocalControlServer } from "../../src/cli/control-server.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import { resetAdminAuthManager } from "../../src/admin/runtime.js";

async function runCli(
  args: string[],
  metadataPath: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts", ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WINHELM_CONTROL_METADATA_PATH: metadataPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForFile(filePath: string, timeoutMs = 20000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Timed out waiting for file: " + filePath);
}

describe("WinHelm control CLI entrypoint", () => {
  it("connects to the running process for jobs without starting another MCP server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cli-entry-"));
    const metadataPath = path.join(dir, "control.json");
    const control = new LocalControlServer({ metadataPath });
    resetApprovalEngine();
    resetAdminAuthManager();

    try {
      await control.start();
      const created = getApprovalEngine().request({
        tool: "fixture_action",
        args: { value: 1 },
        sessionId: "session-a",
        ttlMs: 30_000,
        maxPending: 5,
        execute: async () => "done",
      });

      const result = await runCli(["jobs"], metadataPath);
      assert.strictEqual(result.code, 0);
      assert.match(result.stdout, new RegExp(created.job.id));
      assert.match(result.stdout, /awaiting_approval/);
      assert.doesNotMatch(result.stdout, /MCP Server is running/i);
      assert.doesNotMatch(result.stderr, /MCP Server is running/i);
    } finally {
      await control.close();
      resetApprovalEngine();
      resetAdminAuthManager();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("starts the local control channel in stdio server mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cli-stdio-"));
    const metadataPath = path.join(dir, "control.json");
    const configPath = path.join(dir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ profile: "full" }, null, 2),
      "utf8"
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/index.ts",
        "--stdio",
        "--config",
        configPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WINHELM_CONTROL_METADATA_PATH: metadataPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      await waitForFile(metadataPath);
      const jobs = await runCli(["jobs"], metadataPath);
      assert.strictEqual(jobs.code, 0);
      assert.match(jobs.stdout, /No approval jobs\./);
      assert.match(stderr, /Local approval control ready/i);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects admin-code from a non-interactive child process before contacting the server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cli-tty-"));
    const metadataPath = path.join(dir, "control.json");
    const control = new LocalControlServer({ metadataPath });
    resetApprovalEngine();
    resetAdminAuthManager();

    try {
      await control.start();
      const result = await runCli(["admin-code"], metadataPath);
      assert.strictEqual(result.code, 1);
      assert.match(result.stderr, /interactive local terminal/i);
      assert.doesNotMatch(result.stdout, /Admin code:/i);
    } finally {
      await control.close();
      resetApprovalEngine();
      resetAdminAuthManager();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
