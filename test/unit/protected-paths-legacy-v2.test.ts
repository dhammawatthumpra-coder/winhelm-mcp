import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";

interface LegacyHarness {
  dir: string;
  configFile: string;
  manager: ConfigManager;
}

async function withLegacyConfig(
  config: Record<string, unknown>,
  fn: (harness: LegacyHarness) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-legacy-protected-"));
  const configFile = path.join(dir, "config.json");
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");
  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    assert.strictEqual(manager.getConfigMode(), "legacy");
    await fn({ dir, configFile, manager });
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("WinHelm's own paths are protected in legacy mode too", () => {
  it("denies read and write of the config file under a wildcard legacy config", async () => {
    await withLegacyConfig(
      { allowedDirectories: ["*"], profile: "full", readOnly: false },
      async ({ configFile, manager }) => {
        const write = manager.checkPathAccess(configFile, "write");
        assert.strictEqual(
          write.allowed,
          false,
          "no MCP tool may modify the WinHelm config"
        );
        assert.strictEqual(write.code, "FOLDER_PROTECTED_PATH");

        const read = manager.checkPathAccess(configFile, "read");
        assert.strictEqual(
          read.allowed,
          false,
          "the config holds secrets and must not be readable by tools"
        );
        assert.strictEqual(read.code, "FOLDER_PROTECTED_PATH");
      }
    );
  });

  it("denies the WinHelm data directory that stores the auth token", async () => {
    await withLegacyConfig(
      { allowedDirectories: ["*"], profile: "full", readOnly: false },
      async ({ manager }) => {
        const tokenFile = path.join(os.homedir(), ".winhelm", "auth-token");
        assert.strictEqual(
          manager.checkPathAccess(tokenFile, "read").allowed,
          false
        );
        assert.strictEqual(
          manager.checkPathAccess(tokenFile, "write").allowed,
          false
        );
      }
    );
  });

  it("keeps ordinary legacy paths working", async () => {
    await withLegacyConfig(
      { allowedDirectories: ["*"], profile: "full", readOnly: false },
      async ({ dir, manager }) => {
        await fs.writeFile(path.join(dir, "note.txt"), "ok", "utf8");
        assert.strictEqual(
          manager.checkPathAccess(path.join(dir, "note.txt"), "read").allowed,
          true
        );
        assert.strictEqual(
          manager.checkPathAccess(path.join(dir, "new.txt"), "write").allowed,
          true
        );
      }
    );
  });

  it("honours an explicit legacy allowedDirectories list", async () => {
    const allowedDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-legacy-allowed-")
    );
    try {
      await withLegacyConfig(
        {
          allowedDirectories: [allowedDir],
          profile: "full",
          readOnly: false,
        },
        async ({ configFile, manager }) => {
          assert.strictEqual(
            manager.checkPathAccess(
              path.join(allowedDir, "note.txt"),
              "read"
            ).allowed,
            true
          );
          assert.strictEqual(
            manager.checkPathAccess(configFile, "read").allowed,
            false
          );
          assert.strictEqual(
            manager.checkPathAccess(
              path.join(os.tmpdir(), "outside.txt"),
              "read"
            ).allowed,
            false
          );
        }
      );
    } finally {
      await fs.rm(allowedDir, { recursive: true, force: true });
    }
  });
});
