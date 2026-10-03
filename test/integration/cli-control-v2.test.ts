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

async function waitForJson(
  filePath: string,
  predicate: (value: any) => boolean,
  timeoutMs = 20000
): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = JSON.parse(
        await fs.readFile(filePath, "utf8")
      );
      if (predicate(value)) return value;
    } catch {
      // File may be between atomic replacement steps or not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for JSON state: " + filePath);
}

describe("WinHelm control CLI entrypoint", () => {
  it("reads runtime status from the running process without starting another MCP server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-cli-status-"));
    const metadataPath = path.join(dir, "control.json");
    const control = new LocalControlServer({ metadataPath });
    resetApprovalEngine();
    resetAdminAuthManager();

    try {
      await control.start();
      const result = await runCli(["status"], metadataPath);
      assert.strictEqual(result.code, 0);
      assert.match(result.stdout, /"schemaMode"/);
      assert.match(result.stdout, /"riskState"/);
      assert.match(result.stdout, /"profile"/);
      assert.doesNotMatch(result.stdout, /MCP Server is running/i);
      assert.doesNotMatch(result.stderr, /MCP Server is running/i);
    } finally {
      await control.close();
      resetApprovalEngine();
      resetAdminAuthManager();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

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

  it("applies schema-v2 CLI permission overrides after ENV and persists them", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-cli-v2-overrides-")
    );
    const metadataPath = path.join(dir, "control.json");
    const configPath = path.join(dir, "config.json");
    const envFolder = path.join(dir, "env-folder");
    const cliFolder = path.join(dir, "cli-folder");
    await fs.mkdir(envFolder);
    await fs.mkdir(cliFolder);
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          profilePreset: "balanced",
          folders: [
            {
              path: envFolder,
              alias: "original",
              permission: "readwrite",
            },
          ],
          terminal: {
            mode: "ask",
            approvalTtlSeconds: 77,
          },
          toolPolicy: {
            winhelm_status: "auto",
            winhelm_job_status: "auto",
          },
          approval: {
            channels: ["dashboard", "cli"],
            blockHoldMs: 45000,
            jobTtlMs: 120000,
            maxPending: 4,
          },
          network: { allowLoopback: true },
          ui: { language: "th" },
        },
        null,
        2
      ),
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
        "--allowed-dirs",
        cliFolder,
        "--read-only",
        "--persist",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WINHELM_CONTROL_METADATA_PATH: metadataPath,
          MCP_ALLOWED_DIRECTORIES: envFolder,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    try {
      const persisted = await waitForJson(
        configPath,
        (value) =>
          value?.folders?.[0]?.path === path.resolve(cliFolder) &&
          value?.folders?.[0]?.permission === "read" &&
          value?.terminal?.mode === "off"
      );

      assert.deepStrictEqual(persisted.folders, [
        {
          path: path.resolve(cliFolder),
          permission: "read",
        },
      ]);
      assert.deepStrictEqual(persisted.terminal, {
        mode: "off",
        approvalTtlSeconds: 77,
      });
      assert.deepStrictEqual(persisted.approval, {
        channels: ["dashboard", "cli"],
        blockHoldMs: 45000,
        jobTtlMs: 120000,
        maxPending: 4,
      });
      assert.deepStrictEqual(persisted.network, {
        allowLoopback: true,
      });
      assert.deepStrictEqual(persisted.ui, {
        language: "th",
      });
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

  it("rejects legacy exposure flags in schema-v2 instead of silently ignoring them", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-cli-v2-profile-")
    );
    const metadataPath = path.join(dir, "control.json");
    const configPath = path.join(dir, "config.json");
    const original = {
      schemaVersion: 2,
      profilePreset: "balanced",
      folders: [],
      terminal: { mode: "ask" },
      toolPolicy: {
        winhelm_status: "auto",
        winhelm_job_status: "auto",
      },
    };
    await fs.writeFile(
      configPath,
      JSON.stringify(original, null, 2),
      "utf8"
    );

    try {
      const result = await runCli(
        [
          "--stdio",
          "--config",
          configPath,
          "--profile",
          "full",
        ],
        metadataPath
      );
      assert.strictEqual(result.code, 1);
      assert.match(result.stderr, /legacy exposure flags/i);
      assert.match(result.stderr, /winhelm setup --preset/i);
      assert.doesNotMatch(result.stderr, /MCP Server is running/i);

      const persisted = JSON.parse(
        await fs.readFile(configPath, "utf8")
      );
      assert.deepStrictEqual(persisted, original);
    } finally {
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
