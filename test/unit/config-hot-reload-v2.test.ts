import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { atomicWriteUtf8 } from "../../src/config/atomic-write.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for config hot reload");
}

function v2Config(
  workspace: string,
  terminalMode: "off" | "ask" | "safe",
  policy: "auto" | "ask" | "off"
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    profilePreset: "balanced",
    folders: [
      {
        path: workspace,
        permission: "readwrite",
      },
    ],
    terminal: { mode: terminalMode },
    toolPolicy: {
      system_info: policy,
      winhelm_status: "auto",
      winhelm_job_status: "auto",
    },
  };
}

describe("ConfigManager hot reload", () => {
  it("reloads atomic replacements, fails closed on invalid content, recovers after repair, and stops cleanly", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-hot-reload-")
    );
    const workspace = path.join(root, "workspace");
    const configFile = path.join(root, "winhelm.config.json");
    await fs.mkdir(workspace);

    const previousAllowed = process.env.MCP_ALLOWED_DIRECTORIES;
    const previousReadOnly = process.env.MCP_READ_ONLY;
    delete process.env.MCP_ALLOWED_DIRECTORIES;
    delete process.env.MCP_READ_ONLY;

    await fs.writeFile(
      configFile,
      JSON.stringify(
        v2Config(workspace, "ask", "auto"),
        null,
        2
      ),
      "utf8"
    );

    const manager = ConfigManager.resetInstance(configFile);
    try {
      await manager.init(configFile);
      assert.strictEqual(manager.getConfigMode(), "v2");
      assert.strictEqual(manager.getConfig().terminal?.mode, "ask");
      assert.strictEqual(manager.startWatchingConfig(), true);

      await atomicWriteUtf8(
        configFile,
        JSON.stringify(
          v2Config(workspace, "off", "off"),
          null,
          2
        )
      );
      await waitFor(
        () =>
          manager.getConfigMode() === "v2" &&
          manager.getConfig().terminal?.mode === "off" &&
          manager.getConfig().toolPolicy?.system_info === "off"
      );

      // Directory watching must survive a second atomic temp->rename cycle.
      await atomicWriteUtf8(
        configFile,
        JSON.stringify(
          v2Config(workspace, "safe", "auto"),
          null,
          2
        )
      );
      await waitFor(
        () =>
          manager.getConfigMode() === "v2" &&
          manager.getConfig().terminal?.mode === "safe"
      );

      // Syntax failure must not keep the previous permissive state active.
      await atomicWriteUtf8(configFile, "{ invalid json");
      await waitFor(() => manager.getConfigMode() === "invalid");
      assert.deepStrictEqual(manager.getConfig().folders, []);
      assert.deepStrictEqual(manager.getConfig().terminal, {
        mode: "off",
      });
      assert.deepStrictEqual(manager.getConfig().toolPolicy, {});
      assert.match(
        manager.getConfigValidationErrors()[0] ?? "",
        /Hot reload failed/
      );

      // Repairing the same file should recover without restarting the process.
      await atomicWriteUtf8(
        configFile,
        JSON.stringify(
          v2Config(workspace, "ask", "ask"),
          null,
          2
        )
      );
      await waitFor(
        () =>
          manager.getConfigMode() === "v2" &&
          manager.getConfig().terminal?.mode === "ask" &&
          manager.getConfig().toolPolicy?.system_info === "ask"
      );

      // Removing the config also fails closed, and recreating it recovers.
      await fs.unlink(configFile);
      await waitFor(() => manager.getConfigMode() === "invalid");
      assert.deepStrictEqual(manager.getConfig().folders, []);

      await atomicWriteUtf8(
        configFile,
        JSON.stringify(
          v2Config(workspace, "off", "auto"),
          null,
          2
        )
      );
      await waitFor(
        () =>
          manager.getConfigMode() === "v2" &&
          manager.getConfig().terminal?.mode === "off"
      );

      manager.stopWatchingConfig();
      await atomicWriteUtf8(
        configFile,
        JSON.stringify(
          v2Config(workspace, "safe", "off"),
          null,
          2
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.strictEqual(
        manager.getConfig().terminal?.mode,
        "off",
        "Stopped watcher must not apply later file changes"
      );
    } finally {
      manager.stopWatchingConfig();
      ConfigManager.resetInstance();

      if (previousAllowed === undefined) {
        delete process.env.MCP_ALLOWED_DIRECTORIES;
      } else {
        process.env.MCP_ALLOWED_DIRECTORIES = previousAllowed;
      }
      if (previousReadOnly === undefined) {
        delete process.env.MCP_READ_ONLY;
      } else {
        process.env.MCP_READ_ONLY = previousReadOnly;
      }

      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
