import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyClientConnection,
  buildWinHelmLocalMcpEntry,
  previewClientConnection,
} from "../../src/config/client-connect.js";

describe("MCP client connection config", () => {
  it("builds an absolute stdio launch entry without embedding auth tokens", () => {
    const entry = buildWinHelmLocalMcpEntry(
      "D:\\WinHelm\\config.json",
      {
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        entryPoint: "D:\\WinHelm\\dist\\index.js",
      }
    );

    assert.strictEqual(
      entry.command,
      path.resolve("C:\\Program Files\\nodejs\\node.exe")
    );
    assert.deepStrictEqual(entry.args, [
      path.resolve("D:\\WinHelm\\dist\\index.js"),
      "--stdio",
      "--config",
      path.resolve("D:\\WinHelm\\config.json"),
    ]);
    assert.ok(!JSON.stringify(entry).toLowerCase().includes("token"));
  });

  it("previews only the winhelm entry and redacts secrets from an existing entry", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-client-preview-")
    );
    const configPath = path.join(root, "mcp.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          other: {
            command: "other.exe",
          },
          winhelm: {
            command: "old.exe",
            env: {
              API_KEY: "sk-abcdef1234567890abcdef123456",
            },
          },
        },
      }),
      "utf8"
    );

    try {
      const preview = await previewClientConnection(
        "cursor",
        path.join(root, "winhelm.config.json"),
        {
          cursorConfigPath: configPath,
          nodeExecutable: path.join(root, "node.exe"),
          entryPoint: path.join(root, "dist", "index.js"),
        }
      );

      assert.strictEqual(preview.target.client, "cursor");
      assert.strictEqual(preview.target.configFileExists, true);
      assert.strictEqual(preview.changed, true);
      const serialized = JSON.stringify(preview.existingEntry);
      assert.ok(!serialized.includes("sk-abcdef1234567890abcdef123456"));
      assert.match(serialized, /\*{8,}/);
      assert.ok(
        !serialized.includes("other.exe"),
        "Preview must not expose unrelated MCP server config."
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("merges mcpServers.winhelm while preserving unrelated client settings and creates a backup", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-client-apply-")
    );
    const configPath = path.join(root, "mcp.json");
    const winhelmConfig = path.join(root, "winhelm.config.json");
    const nodeExecutable = path.join(root, "node.exe");
    const entryPoint = path.join(root, "dist", "index.js");
    await fs.mkdir(path.dirname(entryPoint), { recursive: true });
    await fs.writeFile(nodeExecutable, "fixture", "utf8");
    await fs.writeFile(entryPoint, "fixture", "utf8");
    const original = {
      theme: "dark",
      mcpServers: {
        other: {
          command: "other.exe",
          args: ["--keep"],
        },
        winhelm: {
          command: "old-winhelm.exe",
        },
      },
    };
    await fs.writeFile(
      configPath,
      JSON.stringify(original, null, 2),
      "utf8"
    );

    try {
      const result = await applyClientConnection(
        "cursor",
        winhelmConfig,
        {
          cursorConfigPath: configPath,
          nodeExecutable,
          entryPoint,
        }
      );

      assert.ok(result.backupPath);
      const backup = JSON.parse(
        await fs.readFile(result.backupPath!, "utf8")
      );
      assert.deepStrictEqual(backup, original);

      const persisted = JSON.parse(
        await fs.readFile(configPath, "utf8")
      );
      assert.strictEqual(persisted.theme, "dark");
      assert.deepStrictEqual(
        persisted.mcpServers.other,
        original.mcpServers.other
      );
      assert.deepStrictEqual(
        persisted.mcpServers.winhelm,
        buildWinHelmLocalMcpEntry(winhelmConfig, {
          nodeExecutable,
          entryPoint,
        })
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a missing Claude config directory/file atomically", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-client-create-")
    );
    const configPath = path.join(
      root,
      "AppData",
      "Roaming",
      "Claude",
      "claude_desktop_config.json"
    );
    const nodeExecutable = path.join(root, "node.exe");
    const entryPoint = path.join(root, "dist", "index.js");
    await fs.mkdir(path.dirname(entryPoint), { recursive: true });
    await fs.writeFile(nodeExecutable, "fixture", "utf8");
    await fs.writeFile(entryPoint, "fixture", "utf8");

    try {
      const result = await applyClientConnection(
        "claude",
        path.join(root, "winhelm.config.json"),
        {
          claudeConfigPath: configPath,
          nodeExecutable,
          entryPoint,
        }
      );

      assert.strictEqual(result.backupPath, null);
      const persisted = JSON.parse(
        await fs.readFile(configPath, "utf8")
      );
      assert.ok(persisted.mcpServers.winhelm);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to write a client config when the WinHelm entrypoint is missing", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-client-missing-entry-")
    );
    const configPath = path.join(root, "mcp.json");
    const nodeExecutable = path.join(root, "node.exe");
    const missingEntryPoint = path.join(root, "dist", "index.js");
    await fs.writeFile(nodeExecutable, "fixture", "utf8");
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: {} }, null, 2),
      "utf8"
    );
    const before = await fs.readFile(configPath, "utf8");

    try {
      await assert.rejects(
        () =>
          applyClientConnection(
            "cursor",
            path.join(root, "winhelm.config.json"),
            {
              cursorConfigPath: configPath,
              nodeExecutable,
              entryPoint: missingEntryPoint,
            }
          ),
        /entrypoint was not found/i
      );

      assert.strictEqual(
        await fs.readFile(configPath, "utf8"),
        before
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite invalid JSON", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-client-invalid-")
    );
    const configPath = path.join(root, "mcp.json");
    const invalid = "{ invalid json";
    await fs.writeFile(configPath, invalid, "utf8");

    try {
      await assert.rejects(
        () =>
          applyClientConnection(
            "cursor",
            path.join(root, "winhelm.config.json"),
            {
              cursorConfigPath: configPath,
              nodeExecutable: path.join(root, "node.exe"),
              entryPoint: path.join(root, "dist", "index.js"),
            }
          ),
        /not valid JSON/i
      );

      assert.strictEqual(
        await fs.readFile(configPath, "utf8"),
        invalid
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
