import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ConfigManager } from "../../src/config/config-manager.js";
import { createServer } from "../../src/gateway/server.js";
import {
  getAdminAuthManager,
  resetAdminAuthManager,
} from "../../src/admin/runtime.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";

function cookiePair(setCookie: string | null): string {
  assert.ok(setCookie, "Expected Set-Cookie header");
  return setCookie.split(";")[0];
}

describe("Admin MCP client connection API", () => {
  it("previews and applies Claude/Cursor config through the isolated admin plane", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-admin-client-connect-")
    );
    const configFile = path.join(root, "winhelm.config.json");
    const cursorConfig = path.join(root, ".cursor", "mcp.json");
    const claudeConfig = path.join(
      root,
      "Claude",
      "claude_desktop_config.json"
    );
    const nodeExecutable = path.join(root, "node.exe");
    const entryPoint = path.join(root, "dist", "index.js");

    await fs.mkdir(path.dirname(cursorConfig), {
      recursive: true,
    });
    await fs.mkdir(path.dirname(entryPoint), {
      recursive: true,
    });
    await fs.writeFile(nodeExecutable, "fixture", "utf8");
    await fs.writeFile(entryPoint, "fixture", "utf8");
    await fs.writeFile(
      configFile,
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
    await fs.writeFile(
      cursorConfig,
      JSON.stringify(
        {
          theme: "dark",
          mcpServers: {
            other: {
              command: "other.exe",
              args: ["--keep"],
            },
            winhelm: {
              command: "old.exe",
              env: {
                API_KEY: "sk-abcdef1234567890abcdef123456",
              },
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const previousClaude =
      process.env.WINHELM_CLAUDE_CONFIG_PATH;
    const previousCursor =
      process.env.WINHELM_CURSOR_CONFIG_PATH;
    const previousNode =
      process.env.WINHELM_NODE_EXECUTABLE_PATH;
    const previousEntrypoint =
      process.env.WINHELM_SERVER_ENTRYPOINT_PATH;
    process.env.WINHELM_CLAUDE_CONFIG_PATH = claudeConfig;
    process.env.WINHELM_CURSOR_CONFIG_PATH = cursorConfig;
    process.env.WINHELM_NODE_EXECUTABLE_PATH =
      nodeExecutable;
    process.env.WINHELM_SERVER_ENTRYPOINT_PATH =
      entryPoint;

    ConfigManager.resetInstance(configFile);
    resetAdminAuthManager();
    resetApprovalEngine();

    const instance = createServer({
      port: 0,
      host: "127.0.0.1",
      authToken: "mcp-secret",
    });
    const server = await instance.start();
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const issued = getAdminAuthManager().issueCode();
      const exchange = await fetch(
        `${base}/admin/auth/exchange`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: base,
          },
          body: JSON.stringify({ code: issued.code }),
        }
      );
      assert.strictEqual(exchange.status, 200);
      const adminCookie = cookiePair(
        exchange.headers.get("set-cookie")
      );
      const exchangeBody = await exchange.json() as any;
      const csrf = exchangeBody.csrfToken as string;

      const missingCsrf = await fetch(
        `${base}/admin/clients/cursor/preview`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: base,
          },
        }
      );
      assert.strictEqual(missingCsrf.status, 403);

      const preview = await fetch(
        `${base}/admin/clients/cursor/preview`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
        }
      );
      assert.strictEqual(preview.status, 200);
      const previewBody = await preview.json() as any;
      assert.strictEqual(
        previewBody.preview.target.configPath,
        path.resolve(cursorConfig)
      );
      assert.strictEqual(previewBody.preview.changed, true);
      const previewText = JSON.stringify(
        previewBody.preview.existingEntry
      );
      assert.ok(
        !previewText.includes(
          "sk-abcdef1234567890abcdef123456"
        )
      );
      assert.match(previewText, /\*{8,}/);
      assert.ok(
        !JSON.stringify(previewBody).includes("other.exe"),
        "Preview must not expose unrelated MCP server config."
      );

      const appliedCursor = await fetch(
        `${base}/admin/clients/cursor/apply`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
        }
      );
      assert.strictEqual(appliedCursor.status, 200);
      const cursorBody = await appliedCursor.json() as any;
      assert.strictEqual(cursorBody.success, true);
      assert.ok(cursorBody.backupPath);

      const persistedCursor = JSON.parse(
        await fs.readFile(cursorConfig, "utf8")
      );
      assert.strictEqual(persistedCursor.theme, "dark");
      assert.deepStrictEqual(
        persistedCursor.mcpServers.other,
        {
          command: "other.exe",
          args: ["--keep"],
        }
      );
      assert.strictEqual(
        persistedCursor.mcpServers.winhelm.command,
        path.resolve(nodeExecutable)
      );
      assert.ok(
        persistedCursor.mcpServers.winhelm.args.includes(
          path.resolve(configFile)
        )
      );
      assert.ok(
        !JSON.stringify(
          persistedCursor.mcpServers.winhelm
        ).toLowerCase().includes("token")
      );

      const appliedClaude = await fetch(
        `${base}/admin/clients/claude/apply`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
        }
      );
      assert.strictEqual(appliedClaude.status, 200);
      const claudeBody = await appliedClaude.json() as any;
      assert.strictEqual(claudeBody.backupPath, null);
      const persistedClaude = JSON.parse(
        await fs.readFile(claudeConfig, "utf8")
      );
      assert.ok(persistedClaude.mcpServers.winhelm);

      const invalidClient = await fetch(
        `${base}/admin/clients/not-a-client/preview`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
        }
      );
      assert.strictEqual(invalidClient.status, 400);
      const invalidBody = await invalidClient.json() as any;
      assert.strictEqual(
        invalidBody.error.code,
        "INVALID_CLIENT"
      );
    } finally {
      await instance.stop(server);
      ConfigManager.resetInstance();
      resetAdminAuthManager();
      resetApprovalEngine();

      if (previousClaude === undefined) {
        delete process.env.WINHELM_CLAUDE_CONFIG_PATH;
      } else {
        process.env.WINHELM_CLAUDE_CONFIG_PATH =
          previousClaude;
      }
      if (previousCursor === undefined) {
        delete process.env.WINHELM_CURSOR_CONFIG_PATH;
      } else {
        process.env.WINHELM_CURSOR_CONFIG_PATH =
          previousCursor;
      }
      if (previousNode === undefined) {
        delete process.env.WINHELM_NODE_EXECUTABLE_PATH;
      } else {
        process.env.WINHELM_NODE_EXECUTABLE_PATH =
          previousNode;
      }
      if (previousEntrypoint === undefined) {
        delete process.env.WINHELM_SERVER_ENTRYPOINT_PATH;
      } else {
        process.env.WINHELM_SERVER_ENTRYPOINT_PATH =
          previousEntrypoint;
      }

      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
