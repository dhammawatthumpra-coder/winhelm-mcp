import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import os from "node:os";
import { ConfigManager } from "../../src/config/config-manager.js";
import { createServer, safeCompare } from "../../src/gateway/server.js";

function rawHttpRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Unified Gateway Server Integration", () => {
  const TEST_PORT = 8795;
  const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
  let server: Server;
  let stopServer: (s: Server) => Promise<void>;

  before(async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({
      allowedDirectories: [process.cwd(), os.tmpdir(), "C:\\Windows"],
      allowSystemExecution: true,
    }, false);
    const { start, stop } = createServer({
      port: TEST_PORT,
      host: "127.0.0.1",
    });
    stopServer = stop;
    server = await start();
  });

  after(async () => {
    await stopServer(server);
  });

  it("should respond to GET /health", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.status, "ok");
    assert.strictEqual(body.server, "winhelm-mcp");
    assert.strictEqual(body.version, "1.2.0");
  });

  it("should smoothly redirect browser visits (Accept: text/html) on GET /mcp to dashboard", async () => {
    const res = await fetch(`${BASE_URL}/mcp?token=testtoken`, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });
    // Should return HTTP 302 redirecting to /?token=testtoken
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/?token=testtoken");
  });

  it("should gracefully handle CORS without unhandled 500 server crashes", async () => {
    // 1. Allowed origin (Tailscale IP)
    const allowedRes = await fetch(`${BASE_URL}/health`, {
      headers: { Origin: "http://100.78.131.83:8788" },
    });
    assert.strictEqual(allowedRes.status, 200);
    assert.strictEqual(allowedRes.headers.get("access-control-allow-origin"), "http://100.78.131.83:8788");

    // 2. Disallowed origin should return 200 without Access-Control-Allow-Origin (no crash/error)
    const blockedRes = await fetch(`${BASE_URL}/health`, {
      headers: { Origin: "http://evil.com" },
    });
    assert.strictEqual(blockedRes.status, 200);
    assert.strictEqual(blockedRes.headers.get("access-control-allow-origin"), null);
  });

  it("should serve Web Monitor Dashboard on / and /dashboard", async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("WinHelm | Monitor Dashboard"));
    assert.ok(html.includes("LIVE MONITOR"));

    const dashRes = await fetch(`${BASE_URL}/dashboard`);
    assert.strictEqual(dashRes.status, 200);
  });

  it("should provide monitor stats on /api/monitor/stats", async () => {
    const res = await fetch(`${BASE_URL}/api/monitor/stats`);
    assert.strictEqual(res.status, 200);
    const data = (await res.json()) as any;
    assert.strictEqual(data.server, "winhelm-mcp");
    assert.strictEqual(typeof data.uptimeSeconds, "number");
    assert.ok(data.activeSessions);
  });

  it("should handle Streamable HTTP initialize flow on /mcp and record tool logs", async () => {
    // 1. Send Initialize request
    const initRes = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "integration-test-client", version: "1.0" },
        },
      }),
    });

    assert.strictEqual(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId, "Expected mcp-session-id header");

    // 2. Send notifications/initialized
    await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    // 3. Call tools/list
    const listRes = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    assert.strictEqual(listRes.status, 200);
    const listText = await listRes.text();
    assert.ok(listText.includes("terminal_run"));
    assert.ok(listText.includes("file_read"));
    assert.ok(listText.includes("screen_capture"));
    assert.ok(listText.includes("system_info"));

    // 4. Call terminal_run tool
    const callRes = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "terminal_run",
          arguments: {
            command: 'Write-Output "Integration test passed"',
          },
        },
      }),
    });

    assert.strictEqual(callRes.status, 200);
    const callText = await callRes.text();
    assert.ok(callText.includes("Integration test passed"));

    // 5. Check that monitor logs captured the execution
    const logsRes = await fetch(`${BASE_URL}/api/monitor/logs`);
    assert.strictEqual(logsRes.status, 200);
    const logsData = (await logsRes.json()) as any;
    assert.ok(Array.isArray(logsData.logs));
    const toolLog = logsData.logs.find((l: any) => l.title.includes("terminal_run"));
    assert.ok(toolLog, "Expected terminal_run to be captured in monitor logs");
  });

  it("should return HTTP 404 with JSON-RPC error when request sends unknown mcp-session-id", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "unknown-dead-session-9999",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    assert.strictEqual(res.status, 404);
    const data = (await res.json()) as any;
    assert.strictEqual(data.jsonrpc, "2.0");
    assert.strictEqual(data.error?.code, -32001);
    assert.strictEqual(data.error?.message, "Session not found");
    assert.strictEqual(data.id, null);
  });

  it("should export audit logs in JSON and CSV formats", async () => {
    const jsonRes = await fetch(`${BASE_URL}/api/monitor/export?format=json`);
    assert.strictEqual(jsonRes.status, 200);
    assert.ok(jsonRes.headers.get("content-type")?.includes("application/json"));

    const csvRes = await fetch(`${BASE_URL}/api/monitor/export?format=csv`);
    assert.strictEqual(csvRes.status, 200);
    assert.ok(csvRes.headers.get("content-type")?.includes("text/csv"));
    const csvText = await csvRes.text();
    assert.ok(csvText.includes("Timestamp,Type,Level,Title"));
  });

  it("should enforce Host header validation to mitigate DNS Rebinding attacks", async () => {
    // 1. Unauthorized external domain -> 403 Forbidden
    const evilRes = await rawHttpRequest(TEST_PORT, "/health", { Host: "evil.attacker.com" });
    assert.strictEqual(evilRes.status, 403);
    assert.ok(evilRes.body.includes("Host header not permitted"));

    // 2. Loopback localhost -> 200 OK
    const localRes = await rawHttpRequest(TEST_PORT, "/health", { Host: `localhost:${TEST_PORT}` });
    assert.strictEqual(localRes.status, 200);

    // 3. Tailscale domain (*.ts.net) -> 200 OK
    const tsRes = await rawHttpRequest(TEST_PORT, "/health", { Host: `my-box.tailscale.ts.net:${TEST_PORT}` });
    assert.strictEqual(tsRes.status, 200);
  });

  it("should strictly block unauthenticated remote proxy/tunnel requests with 403 (Fail-Closed)", async () => {
    const proxyRes = await fetch(`${BASE_URL}/health`, {
      headers: { "X-Forwarded-For": "203.0.113.195" },
    });
    assert.strictEqual(proxyRes.status, 403);
    const body = (await proxyRes.json()) as any;
    assert.ok(body.error?.includes("Remote proxy/tunnel access is strictly blocked"));
  });

  it("should send security headers on HTTP responses", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
    assert.strictEqual(res.headers.get("x-frame-options"), "DENY");
  });
});

describe("Server Authentication and Protected Endpoints", () => {
  const AUTH_PORT = 8794;
  const AUTH_BASE_URL = `http://127.0.0.1:${AUTH_PORT}`;
  const TEST_TOKEN = "mytoken";
  let authServer: Server;
  let stopAuthServer: (s: Server) => Promise<void>;
  let authSessionManager: any;

  before(async () => {
    const { start, stop, sessionManager } = createServer({
      port: AUTH_PORT,
      host: "127.0.0.1",
      authToken: TEST_TOKEN,
    });
    stopAuthServer = stop;
    authSessionManager = sessionManager;
    authServer = await start();
  });

  after(async () => {
    await stopAuthServer(authServer);
  });

  it("should block unauthenticated GET /preview and GET /api/monitor/logs with 401", async () => {
    // Unauthenticated GET /preview
    const previewRes = await fetch(`${AUTH_BASE_URL}/preview?path=C:\\Windows\\win.ini`);
    assert.strictEqual(previewRes.status, 401);
    const previewBody = (await previewRes.json()) as any;
    assert.ok(previewBody.error?.includes("Unauthorized"));

    // Unauthenticated GET /api/monitor/logs
    const logsRes = await fetch(`${AUTH_BASE_URL}/api/monitor/logs`);
    assert.strictEqual(logsRes.status, 401);
    const logsBody = (await logsRes.json()) as any;
    assert.ok(logsBody.error?.includes("Unauthorized"));

    // Unauthenticated GET /api/monitor/stats
    const statsRes = await fetch(`${AUTH_BASE_URL}/api/monitor/stats`);
    assert.strictEqual(statsRes.status, 401);
  });

  it("should allow unauthenticated access to /health and /dashboard", async () => {
    const healthRes = await fetch(`${AUTH_BASE_URL}/health`);
    assert.strictEqual(healthRes.status, 200);

    const dashRes = await fetch(`${AUTH_BASE_URL}/dashboard`);
    assert.strictEqual(dashRes.status, 200);
  });

  it("should allow access to protected endpoints with Bearer Authorization header", async () => {
    const logsRes = await fetch(`${AUTH_BASE_URL}/api/monitor/logs`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.strictEqual(logsRes.status, 200);
  });

  it("should allow access to protected endpoints with ?token= query parameter and set cookie", async () => {
    const logsRes = await fetch(`${AUTH_BASE_URL}/api/monitor/logs?token=${TEST_TOKEN}`);
    assert.strictEqual(logsRes.status, 200);
    const setCookie = logsRes.headers.get("set-cookie");
    assert.ok(setCookie?.includes("winhelm_session="));

    // Verify subsequent request using cookie without query token
    const cookieRes = await fetch(`${AUTH_BASE_URL}/api/monitor/stats`, {
      headers: { Cookie: setCookie! },
    });
    assert.strictEqual(cookieRes.status, 200);

    const previewRes = await fetch(`${AUTH_BASE_URL}/preview?path=README.md&token=${TEST_TOKEN}`);
    assert.strictEqual(previewRes.status, 200);

    // Verify /mcp endpoint with query token (as used by Claude.ai custom connectors)
    const mcpRes = await fetch(`${AUTH_BASE_URL}/mcp?token=${TEST_TOKEN}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "test-query-token",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "claude-custom-connector", version: "1.0.0" },
        },
      }),
    });
    assert.strictEqual(mcpRes.status, 200);
  });

  it("should exchange master token for ephemeral session cookie via POST /auth/exchange", async () => {
    // 1. Invalid token returns 401
    const badRes = await fetch(`${AUTH_BASE_URL}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    assert.strictEqual(badRes.status, 401);

    // 2. Valid token returns 200, session cookie, and expiresIn: 900
    const okRes = await fetch(`${AUTH_BASE_URL}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TEST_TOKEN }),
    });
    assert.strictEqual(okRes.status, 200);
    const body = (await okRes.json()) as any;
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.expiresIn, 900);
    const sessionCookie = okRes.headers.get("set-cookie");
    assert.ok(sessionCookie?.includes("winhelm_session="));

    // 3. Use exchanged cookie to access protected stats
    const statsRes = await fetch(`${AUTH_BASE_URL}/api/monitor/stats`, {
      headers: { Cookie: sessionCookie! },
    });
    assert.strictEqual(statsRes.status, 200);

    // 4. Logout revokes the session
    const logoutRes = await fetch(`${AUTH_BASE_URL}/auth/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie! },
    });
    assert.strictEqual(logoutRes.status, 200);

    // 5. Subsequent request with logged out cookie should fail with 401
    const postLogoutRes = await fetch(`${AUTH_BASE_URL}/api/monitor/stats`, {
      headers: { Cookie: sessionCookie! },
    });
    assert.strictEqual(postLogoutRes.status, 401);
  });

  it("should strip query token and set session cookie when browser visits dashboard", async () => {
    const res = await fetch(`${AUTH_BASE_URL}/dashboard?token=${TEST_TOKEN}`, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/dashboard");
    const cookie = res.headers.get("set-cookie");
    assert.ok(cookie?.includes("winhelm_session="));
    assert.ok(cookie?.includes("SameSite=Strict"));
  });

  it("should enforce single-use only on exchange tokens and strictly reject replay attacks", async () => {
    // 1. Generate one-time exchange token
    const exToken = authSessionManager.createExchangeToken(60000);

    // 2. First visit with ?exchange=token succeeds (302) and sets session cookie
    const firstRes = await fetch(`${AUTH_BASE_URL}/dashboard?exchange=${exToken}`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
    });
    assert.strictEqual(firstRes.status, 302);
    assert.strictEqual(firstRes.headers.get("location"), "/dashboard");
    const setCookie = firstRes.headers.get("set-cookie");
    assert.ok(setCookie?.includes("winhelm_session="));

    // 3. Second visit with the SAME exchange token (Replay Attack) MUST be rejected with 401
    const replayRes = await fetch(`${AUTH_BASE_URL}/dashboard?exchange=${exToken}`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
    });
    assert.strictEqual(replayRes.status, 401);
    const body = (await replayRes.json()) as any;
    assert.ok(body.error?.includes("Exchange token is invalid or has already been used"));
  });

  it("should invalidate and clear stale or forged session cookies with Max-Age=0", async () => {
    const res = await fetch(`${AUTH_BASE_URL}/api/monitor/stats`, {
      headers: { Cookie: "winhelm_session=forged_non_existent_session_id" },
    });
    assert.strictEqual(res.status, 401);
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie?.includes("winhelm_session="));
    assert.ok(setCookie?.includes("Max-Age=0"));
  });

  it("should dynamically reflect Origin when corsOrigins is wildcard to permit credentials", async () => {
    // Port 8792 with wildcard CORS
    // Dynamically set corsOrigins: "*" BEFORE createServer
    const configManager = (await import("../../src/config/config-manager.js")).ConfigManager.getInstance();
    await configManager.updateConfig({ corsOrigins: "*" }, false);

    const wildcardPort = 8792;
    const { start, stop } = createServer({
      port: wildcardPort,
      host: "127.0.0.1",
    });

    const wildcardServer = await start();
    try {
      const testOrigin = "http://client.mcp.example:3000";
      const res = await fetch(`http://127.0.0.1:${wildcardPort}/health`, {
        headers: { Origin: testOrigin },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("access-control-allow-origin"), testOrigin);
      assert.strictEqual(res.headers.get("access-control-allow-credentials"), "true");
    } finally {
      await stop(wildcardServer);
      await configManager.updateConfig({ corsOrigins: ["localhost", "127.0.0.1", "[::1]", "*.ts.net"] }, false);
    }
  });

  it("should configure trust proxy loopback on Express application", () => {
    const { app } = createServer({ port: 8799, host: "127.0.0.1" });
    assert.strictEqual(app.get("trust proxy"), "loopback");
  });

  it("should perform timing-safe token comparisons correctly with safeCompare", () => {
    assert.strictEqual(safeCompare("secret123", "secret123"), true);
    assert.strictEqual(safeCompare("secret123", "secret124"), false);
    assert.strictEqual(safeCompare("secret123", "secret12"), false);
    assert.strictEqual(safeCompare("secret", "secret123"), false);
    assert.strictEqual(safeCompare("", ""), true);
  });

  it("should reject invalid or partial Bearer tokens with 401", async () => {
    const res1 = await fetch(`${AUTH_BASE_URL}/api/monitor/logs`, {
      headers: { Authorization: "Bearer wrong_token" },
    });
    assert.strictEqual(res1.status, 401);

    const res2 = await fetch(`${AUTH_BASE_URL}/api/monitor/logs`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}_extra` },
    });
    assert.strictEqual(res2.status, 401);
  });

  it("should permit remote proxy/tunnel requests when Bearer token is valid", async () => {
    const authProxyRes = await fetch(`${AUTH_BASE_URL}/health`, {
      headers: {
        "X-Forwarded-For": "203.0.113.195",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
    });
    assert.strictEqual(authProxyRes.status, 200);
  });

  it("should include strict Content-Security-Policy on /preview endpoint", async () => {
    const res = await fetch(`${AUTH_BASE_URL}/preview?path=C:\\Windows\\win.ini&token=${TEST_TOKEN}`);
    // File may or may not exist, but headers are set
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp?.includes("default-src 'none'"));
    assert.ok(csp?.includes("connect-src 'none'"));
  });

  it("should set Max-Age and SameSite on session authentication cookie", async () => {
    const res = await fetch(`${AUTH_BASE_URL}/api/monitor/logs?token=${TEST_TOKEN}`);
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie?.includes("Max-Age=900"));
    assert.ok(setCookie?.includes("SameSite=Strict"));
    assert.ok(setCookie?.includes("HttpOnly"));
  });

  it("should allow Chrome Extension CORS preflight and expose Mcp-Session-Id header", async () => {
    const extOrigin = "chrome-extension://abcdefghijklmnop";
    // 1. OPTIONS preflight
    const optRes = await fetch(`${AUTH_BASE_URL}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: extOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,mcp-session-id",
      },
    });
    assert.strictEqual(optRes.status, 204);
    assert.strictEqual(optRes.headers.get("access-control-allow-origin"), extOrigin);

    // 2. Initialize request with Chrome extension Origin and Bearer token
    const initRes = await fetch(`${AUTH_BASE_URL}/mcp?token=${TEST_TOKEN}`, {
      method: "POST",
      headers: {
        Origin: extOrigin,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chrome-extension-client", version: "1.0" },
        },
      }),
    });
    assert.strictEqual(initRes.status, 200);
    const exposeHeaders = initRes.headers.get("access-control-expose-headers") || "";
    assert.ok(
      exposeHeaders.toLowerCase().includes("mcp-session-id"),
      `Expected Access-Control-Expose-Headers to include Mcp-Session-Id, got: ${exposeHeaders}`
    );
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId, "Expected mcp-session-id in response");
  });
});

