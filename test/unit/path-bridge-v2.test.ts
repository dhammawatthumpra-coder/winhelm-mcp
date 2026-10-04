import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  readFileContent,
  writeFileContent,
} from "../../src/engine/filesystem.js";
import { runPowerShell } from "../../src/engine/powershell-runner.js";

async function withV2Config(
  config: Record<string, unknown>,
  fn: (manager: ConfigManager, configFile: string) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-path-bridge-"));
  const configFile = path.join(dir, "winhelm-v2.json");
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf-8");
  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    assert.strictEqual(manager.getConfigMode(), "v2");
    await fn(manager, configFile);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    ConfigManager.resetInstance();
  }
}

describe("Schema-v2 ConfigManager path bridge", () => {
  it("distinguishes read and write access for the same configured folder", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-v2-read-"));
    const file = path.join(workspace, "note.txt");
    await fs.writeFile(file, "hello", "utf-8");

    try {
      await withV2Config(
        {
          schemaVersion: 2,
          folders: [{ path: workspace, permission: "read" }],
          terminal: { mode: "off" },
          toolPolicy: { file_read: "auto", file_write: "auto" },
        },
        async (manager) => {
          assert.strictEqual(manager.checkPathAccess(file, "read").allowed, true);
          assert.strictEqual(manager.checkPathAccess(file, "write").allowed, false);
          assert.strictEqual(manager.checkPathAccess(file, "write").code, "FOLDER_READ_ONLY");

          const read = await readFileContent(file);
          assert.strictEqual(read.content, "hello");

          await assert.rejects(
            () => writeFileContent(file, "changed"),
            /read-only/i
          );
          assert.strictEqual(await fs.readFile(file, "utf-8"), "hello");
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("allows engine writes inside a readwrite schema-v2 folder", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-v2-write-"));
    const file = path.join(workspace, "created.txt");

    try {
      await withV2Config(
        {
          schemaVersion: 2,
          folders: [{ path: workspace, permission: "readwrite" }],
          terminal: { mode: "off" },
          toolPolicy: { file_write: "auto" },
        },
        async () => {
          const result = await writeFileContent(file, "created");
          assert.strictEqual(result.success, true);
          assert.strictEqual(await fs.readFile(file, "utf-8"), "created");
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("protects the active config file even when its parent folder is readwrite", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-v2-config-protect-"));
    const configFile = path.join(dir, "active.json");
    const config = {
      schemaVersion: 2,
      folders: [{ path: dir, permission: "readwrite" }],
      terminal: { mode: "off" },
      toolPolicy: { file_read: "auto", file_write: "auto" },
    };
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf-8");

    try {
      const manager = ConfigManager.resetInstance(configFile);
      await manager.init(configFile);
      assert.strictEqual(manager.getConfigMode(), "v2");

      const readCheck = manager.checkPathAccess(configFile, "read");
      assert.strictEqual(readCheck.allowed, false);
      assert.strictEqual(readCheck.code, "FOLDER_PROTECTED_PATH");

      await assert.rejects(() => readFileContent(configFile), /protected/i);
      await assert.rejects(() => writeFileContent(configFile, "{}"), /protected/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      ConfigManager.resetInstance();
    }
  });

  it("allows explicit development access to the install root without disabling protection by default", async () => {
    const repoRoot = path.resolve(process.cwd());
    const packageFile = path.join(repoRoot, "package.json");

    await withV2Config(
      {
        schemaVersion: 2,
        folders: [{ path: repoRoot, permission: "readwrite" }],
        terminal: { mode: "off" },
        toolPolicy: { file_read: "auto", file_write: "auto" },
      },
      async (manager) => {
        const blocked = manager.checkPathAccess(packageFile, "read");
        assert.strictEqual(blocked.allowed, false);
        assert.strictEqual(blocked.code, "FOLDER_PROTECTED_PATH");
      }
    );

    await withV2Config(
      {
        schemaVersion: 2,
        folders: [{ path: repoRoot, permission: "readwrite" }],
        terminal: { mode: "off" },
        toolPolicy: { file_read: "auto", file_write: "auto" },
        development: { installRootAccess: "readwrite" },
      },
      async (manager) => {
        assert.strictEqual(
          manager.checkPathAccess(packageFile, "read").allowed,
          true
        );
        assert.strictEqual(
          manager.checkPathAccess(packageFile, "write").allowed,
          true
        );
      }
    );
  });

  it("does not apply legacy allowedDirectories to schema-v2 full terminal execution", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-v2-terminal-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-v2-terminal-out-"));

    try {
      await withV2Config(
        {
          schemaVersion: 2,
          folders: [{ path: workspace, permission: "readwrite" }],
          terminal: { mode: "full" },
          toolPolicy: {},
          allowedDirectories: [],
          allowSystemExecution: false,
        },
        async (manager) => {
          const commandCheck = manager.isCommandAllowed(
            `Write-Output 'ok'; Get-Item -LiteralPath '${outside}' | Out-Null`
          );
          assert.strictEqual(commandCheck.allowed, true);

          const result = await runPowerShell("Write-Output 'schema-v2-terminal-ok'", {
            cwd: outside,
            timeoutMs: 10_000,
          });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /schema-v2-terminal-ok/);
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
