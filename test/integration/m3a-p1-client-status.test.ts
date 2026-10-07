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

/**
 * M3A Phase 1 — read-only client status projection + H-23 backend regression.
 * The Product Shell triggers /admin/clients/<client>/preview|apply; this suite
 * exercises those canonical keys end-to-end and proves unknown clients still
 * fail closed. The status projection must derive from preview semantics,
 * never mutate client configuration, and never expose config contents.
 */
describe("M3A P1: client status projection and canonical client keys", () => {
  it("projects configured / needs-configuration / attention truthfully without mutating config", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-m3a-p1-status-")
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

    await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
    await fs.mkdir(path.dirname(entryPoint), { recursive: true });
    await fs.writeFile(nodeExecutable, "fixture", "utf8");
    await fs.writeFile(entryPoint, "fixture", "utf8");
    await fs.writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 2,
        folders: [],
        terminal: { mode: "off" },
      }),
      "utf8"
    );
    await fs.writeFile(
      cursorConfig,
      JSON.stringify({
        theme: "dark",
        mcpServers: {
          other: { command: "other.exe", args: ["--keep"] },
        },
      }),
      "utf8"
    );

    const previousClaude = process.env.WINHELM_CLAUDE_CONFIG_PATH;
    const previousCursor = process.env.WINHELM_CURSOR_CONFIG_PATH;
    const previousNode = process.env.WINHELM_NODE_EXECUTABLE_PATH;
    const previousEntrypoint = process.env.WINHELM_SERVER_ENTRYPOINT_PATH;
    process.env.WINHELM_CLAUDE_CONFIG_PATH = claudeConfig;
    process.env.WINHELM_CURSOR_CONFIG_PATH = cursorConfig;
    process.env.WINHELM_NODE_EXECUTABLE_PATH = nodeExecutable;
    process.env.WINHELM_SERVER_ENTRYPOINT_PATH = entryPoint;

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
      const unauth = await fetch(`${base}/admin/clients/status`);
      assert.strictEqual(unauth.status, 401);

      const issued = getAdminAuthManager().issueCode();
      const exchange = await fetch(`${base}/admin/auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ code: issued.code }),
      });
      assert.strictEqual(exchange.status, 200);
      const adminCookie = cookiePair(exchange.headers.get("set-cookie"));
      const csrf = ((await exchange.json()) as any).csrfToken as string;
      const headers = {
        Cookie: adminCookie,
        Origin: base,
        "x-winhelm-csrf": csrf,
      };

      // H-23 regression: the Product Shell's canonical `claude` key works.
      const claudePreview = await fetch(
        `${base}/admin/clients/claude/preview`,
        { method: "POST", headers }
      );
      assert.strictEqual(claudePreview.status, 200);

      // H-23 regression: the former UI key fails closed with INVALID_CLIENT.
      const legacyKey = await fetch(
        `${base}/admin/clients/claude-desktop/preview`,
        { method: "POST", headers }
      );
      assert.strictEqual(legacyKey.status, 400);
      assert.strictEqual(
        ((await legacyKey.json()) as any).error.code,
        "INVALID_CLIENT"
      );

      // Fresh fixtures: both clients need configuration.
      const statusBefore = await fetch(`${base}/admin/clients/status`, {
        headers: { Cookie: adminCookie, Origin: base },
      });
      assert.strictEqual(statusBefore.status, 200);
      const beforeBody = (await statusBefore.json()) as any;
      const claudeBefore = beforeBody.clients.find(
        (c: any) => c.client === "claude"
      );
      const cursorBefore = beforeBody.clients.find(
        (c: any) => c.client === "cursor"
      );
      assert.strictEqual(claudeBefore.status, "needs_configuration");
      assert.strictEqual(cursorBefore.status, "needs_configuration");
      assert.ok(
        !JSON.stringify(beforeBody).includes("other.exe"),
        "Status projection must not expose unrelated MCP server config."
      );
      assert.strictEqual(
        JSON.stringify(beforeBody).includes("mcpServers"),
        false,
        "Status projection must not expose client config contents."
      );

      // Apply via the canonical key, then the projection must read Configured.
      const apply = await fetch(`${base}/admin/clients/cursor/apply`, {
        method: "POST",
        headers,
      });
      assert.strictEqual(apply.status, 200);

      const statusAfter = await fetch(`${base}/admin/clients/status`, {
        headers: { Cookie: adminCookie, Origin: base },
      });
      const afterBody = (await statusAfter.json()) as any;
      const cursorAfter = afterBody.clients.find(
        (c: any) => c.client === "cursor"
      );
      assert.strictEqual(cursorAfter.status, "configured");
      // After configuring, the preview legitimately warns that the existing
      // winhelm entry would be replaced on a re-apply.
      assert.strictEqual(typeof cursorAfter.warningCount, "number");

      // The status GET is read-only: two back-to-back GETs leave the config
      // file byte-identical.
      const bytesOne = await fs.readFile(cursorConfig);
      await fetch(`${base}/admin/clients/status`, {
        headers: { Cookie: adminCookie, Origin: base },
      });
      const bytesTwo = await fs.readFile(cursorConfig);
      assert.ok(bytesOne.equals(bytesTwo));

      // Ambiguous/broken config must surface as Attention, not Configured.
      await fs.writeFile(cursorConfig, "{ not valid json", "utf8");
      const statusBroken = await fetch(`${base}/admin/clients/status`, {
        headers: { Cookie: adminCookie, Origin: base },
      });
      const brokenBody = (await statusBroken.json()) as any;
      const cursorBroken = brokenBody.clients.find(
        (c: any) => c.client === "cursor"
      );
      assert.strictEqual(cursorBroken.status, "attention");
      assert.strictEqual(
        cursorBroken.errorCode,
        "CLIENT_CONFIG_INVALID_JSON"
      );
    } finally {
      await instance.stop(server);
      ConfigManager.resetInstance();
      resetAdminAuthManager();
      resetApprovalEngine();

      if (previousClaude === undefined) {
        delete process.env.WINHELM_CLAUDE_CONFIG_PATH;
      } else {
        process.env.WINHELM_CLAUDE_CONFIG_PATH = previousClaude;
      }
      if (previousCursor === undefined) {
        delete process.env.WINHELM_CURSOR_CONFIG_PATH;
      } else {
        process.env.WINHELM_CURSOR_CONFIG_PATH = previousCursor;
      }
      if (previousNode === undefined) {
        delete process.env.WINHELM_NODE_EXECUTABLE_PATH;
      } else {
        process.env.WINHELM_NODE_EXECUTABLE_PATH = previousNode;
      }
      if (previousEntrypoint === undefined) {
        delete process.env.WINHELM_SERVER_ENTRYPOINT_PATH;
      } else {
        process.env.WINHELM_SERVER_ENTRYPOINT_PATH = previousEntrypoint;
      }

      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
