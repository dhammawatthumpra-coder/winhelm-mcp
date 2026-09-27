import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createServer, safeCompare } from "../../src/gateway/server.js";

describe("Unified Gateway Server Integration", () => {
  const TEST_PORT = 8795;
  const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
  let server: Server;
  let stopServer: (s: Server) => Promise<void>;

  before(async () => {
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
    assert.strictEqual(body.version, "1.0.0");
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
});

describe("Server Authentication and Protected Endpoints", () => {
  const AUTH_PORT = 8794;
  const AUTH_BASE_URL = `http://127.0.0.1:${AUTH_PORT}`;
  const TEST_TOKEN = "mytoken";
  let authServer: Server;
  let stopAuthServer: (s: Server) => Promise<void>;

  before(async () => {
    const { start, stop } = createServer({
      port: AUTH_PORT,
      host: "127.0.0.1",
      authToken: TEST_TOKEN,
    });
    stopAuthServer = stop;
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

  it("should allow access to protected endpoints with ?token= query parameter", async () => {
    const logsRes = await fetch(`${AUTH_BASE_URL}/api/monitor/logs?token=${TEST_TOKEN}`);
    assert.strictEqual(logsRes.status, 200);

    const previewRes = await fetch(`${AUTH_BASE_URL}/preview?path=README.md&token=${TEST_TOKEN}`);
    assert.strictEqual(previewRes.status, 200);
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
});

