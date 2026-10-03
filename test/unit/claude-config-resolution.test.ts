import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyClientConnection,
  previewClientConnection,
  resolveClaudeConfigPath,
  resolveClientConnectionTarget,
  ClientConnectionError,
} from "../../src/config/client-connect.js";

const PUBLISHER_HASH_A = "pzs8sxrjxfjjc";
const PUBLISHER_HASH_B = "aa11bb22cc33";

interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  classicConfigPath: string;
  msixConfigPath: (hash?: string) => string;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "winhelm-claude-resolver-")
  );
  const appData = path.join(root, "AppData", "Roaming");
  const localAppData = path.join(root, "AppData", "Local");
  const env: NodeJS.ProcessEnv = {
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
  return {
    root,
    env,
    classicConfigPath: path.join(
      appData,
      "Claude",
      "claude_desktop_config.json"
    ),
    msixConfigPath: (hash = PUBLISHER_HASH_A) =>
      path.join(
        localAppData,
        "Packages",
        `Claude_${hash}`,
        "LocalCache",
        "Roaming",
        "Claude",
        "claude_desktop_config.json"
      ),
  };
}

async function writeFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

function makeMsixDataDir(sandbox: Sandbox, hash?: string) {
  return fs.mkdir(
    path.dirname(sandbox.msixConfigPath(hash)),
    { recursive: true }
  );
}

describe("Claude Desktop config resolution (DEF-01)", () => {
  it("resolves the classic config when only it exists", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(sandbox.classicConfigPath, "{}");
      const resolution = resolveClaudeConfigPath(sandbox.env);
      assert.strictEqual(resolution.configPath, sandbox.classicConfigPath);
      assert.strictEqual(resolution.basis, "classic-config");
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("resolves the MSIX virtualized config when only it exists", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(sandbox.msixConfigPath(), "{}");
      const resolution = resolveClaudeConfigPath(sandbox.env);
      assert.strictEqual(resolution.configPath, sandbox.msixConfigPath());
      assert.strictEqual(resolution.basis, "msix-config");
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("gives an explicit override the highest priority (parameter then env)", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(sandbox.classicConfigPath, "{}");
      await writeFile(sandbox.msixConfigPath(), "{}");
      const overridePath = path.join(sandbox.root, "custom-config.json");

      const viaParam = resolveClaudeConfigPath(sandbox.env, {
        claudeConfigPath: overridePath,
      });
      assert.strictEqual(viaParam.configPath, path.resolve(overridePath));
      assert.strictEqual(viaParam.basis, "override");

      const viaEnv = resolveClaudeConfigPath({
        ...sandbox.env,
        WINHELM_CLAUDE_CONFIG_PATH: overridePath,
      });
      assert.strictEqual(viaEnv.configPath, path.resolve(overridePath));
      assert.strictEqual(viaEnv.basis, "override");
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("fails closed with candidates when classic and MSIX configs both exist", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(sandbox.classicConfigPath, "{}");
      await writeFile(sandbox.msixConfigPath(), "{}");
      try {
        resolveClaudeConfigPath(sandbox.env);
        assert.fail("expected CLAUDE_CONFIG_AMBIGUOUS");
      } catch (err) {
        assert.ok(err instanceof ClientConnectionError);
        assert.strictEqual(err.code, "CLAUDE_CONFIG_AMBIGUOUS");
        assert.deepStrictEqual(err.candidates, [
          sandbox.classicConfigPath,
          sandbox.msixConfigPath(),
        ]);
      }
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("fails closed when multiple MSIX packages hold existing configs", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(sandbox.msixConfigPath(PUBLISHER_HASH_A), "{}");
      await writeFile(sandbox.msixConfigPath(PUBLISHER_HASH_B), "{}");
      try {
        resolveClaudeConfigPath(sandbox.env);
        assert.fail("expected CLAUDE_CONFIG_AMBIGUOUS");
      } catch (err) {
        assert.ok(err instanceof ClientConnectionError);
        assert.strictEqual(err.code, "CLAUDE_CONFIG_AMBIGUOUS");
        assert.deepStrictEqual(err.candidates, [
          sandbox.msixConfigPath(PUBLISHER_HASH_A),
          sandbox.msixConfigPath(PUBLISHER_HASH_B),
        ].sort());
      }
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("proposes the MSIX path from install evidence when no config exists yet", async () => {
    const sandbox = await makeSandbox();
    try {
      await makeMsixDataDir(sandbox);
      const resolution = resolveClaudeConfigPath(sandbox.env);
      assert.strictEqual(resolution.configPath, sandbox.msixConfigPath());
      assert.strictEqual(resolution.basis, "msix-install");
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("fails closed instead of writing to an unevidenced path when no install exists", async () => {
    const sandbox = await makeSandbox();
    try {
      assert.throws(
        () => resolveClaudeConfigPath(sandbox.env),
        (err: unknown) =>
          err instanceof ClientConnectionError &&
          err.code === "CLAUDE_CONFIG_UNRESOLVED"
      );
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("fails closed when a classic and an MSIX install both lack configs", async () => {
    const sandbox = await makeSandbox();
    try {
      await makeMsixDataDir(sandbox);
      await fs.mkdir(path.dirname(sandbox.classicConfigPath), {
        recursive: true,
      });
      try {
        resolveClaudeConfigPath(sandbox.env);
        assert.fail("expected CLAUDE_CONFIG_AMBIGUOUS");
      } catch (err) {
        assert.ok(err instanceof ClientConnectionError);
        assert.strictEqual(err.code, "CLAUDE_CONFIG_AMBIGUOUS");
        assert.ok(err.candidates.includes(sandbox.classicConfigPath));
        assert.ok(err.candidates.includes(sandbox.msixConfigPath()));
      }
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("exposes the resolution basis on the connection target", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(sandbox.msixConfigPath(), "{}");
      const target = resolveClientConnectionTarget("claude", {
        env: sandbox.env,
      });
      assert.strictEqual(target.configPath, sandbox.msixConfigPath());
      assert.strictEqual(target.resolutionBasis, "msix-config");
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("applies through the resolved MSIX path preserving other MCP servers and creating a backup", async () => {
    const sandbox = await makeSandbox();
    try {
      const original = {
        mcpServers: {
          other: { command: "other.exe", args: ["--keep"] },
        },
      };
      await writeFile(
        sandbox.msixConfigPath(),
        JSON.stringify(original, null, 2)
      );
      const nodeExecutable = path.join(sandbox.root, "node.exe");
      const entryPoint = path.join(sandbox.root, "dist", "index.js");
      await writeFile(nodeExecutable, "fixture");
      await writeFile(entryPoint, "fixture");

      const target = resolveClientConnectionTarget("claude", {
        env: sandbox.env,
      });
      const result = await applyClientConnection(
        "claude",
        path.join(sandbox.root, "winhelm.config.json"),
        {
          claudeConfigPath: target.configPath,
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
        await fs.readFile(sandbox.msixConfigPath(), "utf8")
      );
      assert.deepStrictEqual(
        persisted.mcpServers.other,
        original.mcpServers.other
      );
      assert.ok(persisted.mcpServers.winhelm);
      assert.ok(
        !JSON.stringify(persisted).toLowerCase().includes("token")
      );
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite invalid JSON at the resolved MSIX path", async () => {
    const sandbox = await makeSandbox();
    try {
      const invalid = "{ not json";
      await writeFile(sandbox.msixConfigPath(), invalid);
      await assert.rejects(
        () =>
          previewClientConnection(
            "claude",
            path.join(sandbox.root, "winhelm.config.json"),
            { claudeConfigPath: sandbox.msixConfigPath() }
          ),
        /not valid JSON/i
      );
      assert.strictEqual(
        await fs.readFile(sandbox.msixConfigPath(), "utf8"),
        invalid
      );
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("redacts secrets and hides unrelated servers from the Claude preview", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(
        sandbox.msixConfigPath(),
        JSON.stringify({
          mcpServers: {
            other: { command: "other.exe" },
            winhelm: {
              command: "old.exe",
              env: { API_KEY: "sk-abcdef1234567890abcdef123456" },
            },
          },
        })
      );
      const preview = await previewClientConnection(
        "claude",
        path.join(sandbox.root, "winhelm.config.json"),
        { claudeConfigPath: sandbox.msixConfigPath() }
      );
      const serialized = JSON.stringify(preview.existingEntry);
      assert.ok(
        !serialized.includes("sk-abcdef1234567890abcdef123456")
      );
      assert.ok(
        !serialized.includes("other.exe"),
        "Preview must not expose unrelated MCP server config."
      );
      assert.strictEqual(preview.target.client, "claude");
      assert.strictEqual(preview.target.configFileExists, true);
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });
});
