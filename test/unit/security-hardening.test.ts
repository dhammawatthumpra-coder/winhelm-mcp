import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { isHostAllowed, isOriginAllowed } from "../../src/gateway/server.js";
import { markdownToHtml } from "../../src/engine/pdf-generator.js";
import { registerTerminalTools } from "../../src/tools/terminal-tools.js";
import { registerNetworkTools } from "../../src/tools/network-tools.js";

describe("Security Hardening & Boundary Enforcement", () => {
  it("should validate Host headers against loopback, Tailscale CGNAT, and allowed host patterns (DNS Rebinding protection)", () => {
    const allowed = ["localhost", "127.0.0.1", "[::1]", "*.ts.net"];

    // 1. Loopback addresses must pass
    assert.strictEqual(isHostAllowed("localhost", allowed), true);
    assert.strictEqual(isHostAllowed("localhost:8788", allowed), true);
    assert.strictEqual(isHostAllowed("127.0.0.1", allowed), true);
    assert.strictEqual(isHostAllowed("127.0.0.1:8788", allowed), true);
    assert.strictEqual(isHostAllowed("::1", allowed), true);
    assert.strictEqual(isHostAllowed("[::1]:8788", allowed), true);

    // 2. Wildcard pattern (*.ts.net) must pass
    assert.strictEqual(isHostAllowed("my-laptop.ts.net", allowed), true);
    assert.strictEqual(isHostAllowed("node.tailscale.ts.net:8788", allowed), true);

    // 3. Tailscale CGNAT IPs (100.64.0.0/10) must pass
    assert.strictEqual(isHostAllowed("100.78.131.83:8788", allowed), true);
    assert.strictEqual(isHostAllowed("100.64.0.1", allowed), true);
    assert.strictEqual(isHostAllowed("100.127.255.254", allowed), true);

    // 4. Explicit bind host must pass
    assert.strictEqual(isHostAllowed("192.168.1.50:8788", allowed, "192.168.1.50"), true);

    // 5. Unauthorized hosts must be blocked
    assert.strictEqual(isHostAllowed("evil.attacker.com", allowed), false);
    assert.strictEqual(isHostAllowed("evil.attacker.com:8788", allowed), false);
    assert.strictEqual(isHostAllowed("not-ts.net", allowed), false);
    assert.strictEqual(isHostAllowed("evil-ts.net:8788", allowed), false);
    assert.strictEqual(isHostAllowed("100.128.1.1", allowed), false); // Outside Tailscale CGNAT range
    assert.strictEqual(isHostAllowed("", allowed), false);
    assert.strictEqual(isHostAllowed(undefined, allowed), false);
  });

  it("should validate CORS Origin headers against allowed hosts, Tailscale IPs, and AI client web origins", () => {
    const allowed = ["localhost", "127.0.0.1", "[::1]", "*.ts.net"];

    // Non-browser / CLI requests (no Origin header)
    assert.strictEqual(isOriginAllowed(undefined, allowed), true);
    assert.strictEqual(isOriginAllowed("", allowed), true);

    // Loopback browser origins
    assert.strictEqual(isOriginAllowed("http://localhost:8788", allowed), true);
    assert.strictEqual(isOriginAllowed("http://127.0.0.1:8788", allowed), true);
    assert.strictEqual(isOriginAllowed("http://[::1]:8788", allowed), true);

    // Tailscale MagicDNS and CGNAT IPs
    assert.strictEqual(isOriginAllowed("https://my-box.ts.net", allowed), true);
    assert.strictEqual(isOriginAllowed("http://100.78.131.83:8788", allowed), true);

    // Standard remote Web MCP clients
    assert.strictEqual(isOriginAllowed("https://claude.ai", allowed), true);
    assert.strictEqual(isOriginAllowed("https://chatgpt.com", allowed), true);

    // Malicious or unauthorized external origins
    assert.strictEqual(isOriginAllowed("http://evil.attacker.com", allowed), false);
    assert.strictEqual(isOriginAllowed("https://malicious-site.io", allowed), false);
    assert.strictEqual(isOriginAllowed("http://not-ts.net", allowed), false);
  });

  it("should sanitize codeBlockLang in markdownToHtml to prevent HTML/attribute injection", () => {
    const maliciousMd = '```"><script>alert(1)</script>\nconst x = 1;\n```';
    const html = markdownToHtml(maliciousMd, "Test Doc");

    // Must NOT contain unescaped script tag or injected attributes
    assert.ok(!html.includes('"><script>alert(1)</script>'));
    assert.ok(!html.includes("<script>alert(1)</script>"));
    // The language identifier should be sanitized strictly to alphanumeric/hyphen characters
    assert.ok(html.includes("class=\"code-block scriptalert1script\""));
  });

  it("should throw fatal error on corrupted/invalid config JSON (fail-closed, no silent fallback)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-corrupt-"));
    const corruptFile = path.join(tmpDir, "corrupt.config.json");

    try {
      // Write invalid JSON with syntax error (trailing comma / unquoted key)
      await fs.writeFile(corruptFile, '{\n  "authToken": "test",\n  trailing,\n}', "utf-8");

      const configManager = ConfigManager.getInstance();
      await assert.rejects(
        async () => {
          await configManager.init(corruptFile);
        },
        /Failed to load configuration file/
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should strictly block terminal_run and terminal_task_start when readOnly is enabled", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ readOnly: true, profile: "full" }, false);

    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerTerminalTools(server);

    const tools = (server as any)._registeredTools;
    assert.ok(tools["terminal_run"], "terminal_run should be registered under full profile");
    assert.ok(tools["terminal_task_start"], "terminal_task_start should be registered under full profile");

    // Execute terminal_run under readOnly: true
    const runResult = await tools["terminal_run"].handler({ command: "Write-Output 'hi'" }, {});
    assert.strictEqual(runResult.isError, true);
    assert.ok(runResult.content[0].text.includes("Server is operating in read-only mode"));

    // Execute terminal_task_start under readOnly: true
    const taskResult = await tools["terminal_task_start"].handler({ command: "Start-Sleep -s 1" }, {});
    assert.strictEqual(taskResult.isError, true);
    assert.ok(taskResult.content[0].text.includes("Server is operating in read-only mode"));

    // Reset readOnly back to false
    await configManager.updateConfig({ readOnly: false }, false);
  });

  it("should block mutating HTTP methods (POST, PUT, DELETE, PATCH) in http_request when readOnly is enabled", async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({ readOnly: true, profile: "full" }, false);

    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerNetworkTools(server);

    const tools = (server as any)._registeredTools;
    assert.ok(tools["http_request"], "http_request should be registered");

    // Mutating POST request must be blocked
    const postResult = await tools["http_request"].handler(
      { url: "https://example.com/api", method: "POST", body: '{"key":"val"}' },
      {}
    );
    assert.strictEqual(postResult.isError, true);
    assert.ok(postResult.content[0].text.includes("HTTP mutation blocked"));
    assert.ok(postResult.content[0].text.includes("POST requests are not permitted in read-only mode"));

    // Mutating DELETE request must be blocked
    const delResult = await tools["http_request"].handler(
      { url: "https://example.com/api", method: "DELETE" },
      {}
    );
    assert.strictEqual(delResult.isError, true);
    assert.ok(delResult.content[0].text.includes("DELETE requests are not permitted in read-only mode"));

    // Reset readOnly back to false
    await configManager.updateConfig({ readOnly: false }, false);
  });
});
