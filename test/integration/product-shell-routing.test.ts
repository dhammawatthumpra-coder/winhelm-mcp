import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createServer } from "../../src/gateway/server.js";
import { ConfigManager } from "../../src/config/config-manager.js";

const TEST_PORT = 18820;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

describe("Product Shell Routing Integration (M2B)", () => {
  let server: Server;
  let stopServer: (s: Server) => Promise<void>;

  before(async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig(
      {
        allowedDirectories: [process.cwd()],
        authToken: "test_secret_token_m2b",
      },
      false
    );

    const instance = createServer({
      port: TEST_PORT,
      host: "127.0.0.1",
      authToken: "test_secret_token_m2b",
    });
    stopServer = instance.stop;
    server = await instance.start();
  });

  after(async () => {
    await stopServer(server);
    ConfigManager.resetInstance();
  });

  it("serves the primary Product Shell on GET / with strict Content-Security-Policy", async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert.strictEqual(res.status, 200);

    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "Product Shell must include CSP header");
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("connect-src 'self'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));

    const html = await res.text();
    assert.ok(html.includes("WinHelm"));
    assert.ok(html.includes("PRODUCT SHELL"));
    assert.ok(html.includes('id="panel-overview"'));
    assert.ok(html.includes('id="panel-access"'));
    assert.ok(html.includes('id="panel-approvals"'));
    assert.ok(html.includes('id="panel-activity"'));
    assert.ok(html.includes('id="panel-connections"'));
    assert.ok(html.includes('id="panel-settings"'));
  });

  it("preserves engineering Dashboard on GET /dashboard with strict Content-Security-Policy", async () => {
    const res = await fetch(`${BASE_URL}/dashboard`);
    assert.strictEqual(res.status, 200);

    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "Dashboard must include CSP header");
    assert.ok(csp.includes("default-src 'none'"));

    const html = await res.text();
    assert.ok(html.includes("WinHelm | Monitor Dashboard"));
    assert.ok(html.includes("LIVE MONITOR"));
    assert.ok(html.includes("Product Shell"));
  });

  it("serves Product Shell approval deep link on GET /approvals/:jobId", async () => {
    const res = await fetch(`${BASE_URL}/approvals/job_deep_link_sample`);
    assert.strictEqual(res.status, 200);

    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "Approval deep link must carry strict CSP");
    assert.ok(csp.includes("default-src 'none'"));

    const html = await res.text();
    assert.ok(html.includes('id="approvalJobs"'));
    assert.ok(html.includes("Approval Jobs"));
    assert.ok(html.includes("job_deep_link_sample"));
  });

  it("redirects browser visits on GET /mcp with Accept text/html to Product Shell /", async () => {
    const res = await fetch(`${BASE_URL}/mcp?token=test_secret_token_m2b`, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(
      res.headers.get("location"),
      "/?token=test_secret_token_m2b"
    );
  });

  it("strips authentication token from URL and establishes session cookie on Product Shell navigation", async () => {
    const res = await fetch(`${BASE_URL}/?token=test_secret_token_m2b`, {
      headers: {
        Accept: "text/html",
      },
      redirect: "manual",
    });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/");
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie, "Must set ephemeral session cookie");
    assert.ok(setCookie.includes("winhelm_session="));
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("SameSite=Strict"));
  });

  it("ensures unauthenticated Product Shell does not leak protected data", async () => {
    // Endpoints like /api/monitor/stats and /api/monitor/logs should reject without session cookie or bearer token
    const statsRes = await fetch(`${BASE_URL}/api/monitor/stats`);
    assert.strictEqual(statsRes.status, 401);

    const logsRes = await fetch(`${BASE_URL}/api/monitor/logs`);
    assert.strictEqual(logsRes.status, 401);

    const adminStatusRes = await fetch(`${BASE_URL}/admin/status`);
    // Admin routes return 401 without admin session
    assert.strictEqual(adminStatusRes.status, 401);
  });
});
