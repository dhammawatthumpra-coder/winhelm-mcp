import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { runConnectCliCommand } from "../../src/cli/connect.js";

async function fixture(): Promise<{
  root: string;
  winhelmConfig: string;
  claudeConfig: string;
  cursorConfig: string;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "winhelm-connect-cli-")
  );
  const winhelmConfig = path.join(root, "winhelm.config.json");
  const claudeConfig = path.join(
    root,
    "Claude",
    "claude_desktop_config.json"
  );
  const cursorConfig = path.join(root, ".cursor", "mcp.json");

  await fs.writeFile(
    winhelmConfig,
    JSON.stringify(
      {
        schemaVersion: 2,
        folders: [],
        terminal: { mode: "off" },
        toolPolicy: { winhelm_status: "auto" },
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    root,
    winhelmConfig,
    claudeConfig,
    cursorConfig,
  };
}

describe("winhelm connect CLI", () => {
  it("ignores unrelated commands", async () => {
    assert.deepStrictEqual(
      await runConnectCliCommand(["setup"]),
      { handled: false, exitCode: 0 }
    );
  });

  it("requires a supported client name", async () => {
    const result = await runConnectCliCommand([
      "connect",
      "unknown",
    ]);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.error ?? "", /claude\|cursor\|all/i);
  });

  it("supports dry-run without writing client config", async () => {
    const f = await fixture();
    try {
      const result = await runConnectCliCommand(
        [
          "connect",
          "cursor",
          "--config",
          f.winhelmConfig,
          "--dry-run",
        ],
        {
          cursorConfigPath: f.cursorConfig,
          nodeExecutable: path.join(f.root, "node.exe"),
          entryPoint: path.join(f.root, "dist", "index.js"),
        }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.output ?? "", /Dry run only/i);
      assert.match(result.output ?? "", /Cursor MCP connection/);
      await assert.rejects(
        () => fs.access(f.cursorConfig)
      );
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("requires --yes before writing client config", async () => {
    const f = await fixture();
    try {
      const result = await runConnectCliCommand(
        [
          "connect",
          "claude",
          "--config",
          f.winhelmConfig,
        ],
        {
          claudeConfigPath: f.claudeConfig,
          nodeExecutable: path.join(f.root, "node.exe"),
          entryPoint: path.join(f.root, "dist", "index.js"),
        }
      );

      assert.strictEqual(result.exitCode, 2);
      assert.match(result.error ?? "", /requires --yes/i);
      await assert.rejects(
        () => fs.access(f.claudeConfig)
      );
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("connects both Claude and Cursor with --yes", async () => {
    const f = await fixture();
    try {
      const result = await runConnectCliCommand(
        [
          "connect",
          "all",
          "--config",
          f.winhelmConfig,
          "--yes",
        ],
        {
          claudeConfigPath: f.claudeConfig,
          cursorConfigPath: f.cursorConfig,
          nodeExecutable: path.join(f.root, "node.exe"),
          entryPoint: path.join(f.root, "dist", "index.js"),
        }
      );

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.output ?? "", /Claude Desktop/);
      assert.match(result.output ?? "", /Cursor/);
      assert.match(result.output ?? "", /restart\/reload/i);

      for (const file of [f.claudeConfig, f.cursorConfig]) {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        assert.ok(parsed.mcpServers.winhelm);
        assert.deepStrictEqual(
          parsed.mcpServers.winhelm.args.slice(-3),
          ["--stdio", "--config", path.resolve(f.winhelmConfig)]
        );
      }
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
});
