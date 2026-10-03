import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import http from "node:http";
import { createServer } from "../../src/gateway/server.js";
import { getSessionClientInfo } from "../../src/gateway/session-context.js";

describe("SSE Gateway Integration", () => {
  const TEST_PORT = 18796;
  let server: Server;
  let stopServer: (s: Server) => Promise<void>;

  before(async () => {
    const { start, stop } = createServer({
      port: TEST_PORT,
      host: "127.0.0.1",
      authToken: null,
    });
    stopServer = stop;
    server = await start();
  });

  after(async () => {
    await stopServer(server);
  });

  it("should connect to SSE and handle JSON-RPC message", async () => {
    // 1. Establish SSE connection
    const sseInitPromise = new Promise<{ sseReq: http.ClientRequest; messageUri: string }>(
      (resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${TEST_PORT}/sse`,
          {
            headers: { Accept: "text/event-stream" },
          },
          (res) => {
            let buffer = "";
            res.on("data", (chunk: Buffer) => {
              buffer += chunk.toString();
              if (buffer.includes("event: endpoint")) {
                const match = buffer.match(/data: (.*)/);
                if (match) {
                  const messageUri = match[1].trim();
                  resolve({ sseReq: req, messageUri });
                }
              }
            });
          }
        );
        req.on("error", reject);
        req.end();
      }
    );

    const { sseReq, messageUri } = await sseInitPromise;
    assert.ok(messageUri.includes("/message?sessionId="));
    const sessionId = new URL(
      messageUri,
      `http://127.0.0.1:${TEST_PORT}`
    ).searchParams.get("sessionId");
    assert.ok(sessionId);

    // 2. Post initialize request
    const postRes = await fetch(`http://127.0.0.1:${TEST_PORT}${messageUri}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "sse-test-client", version: "1.0" },
        },
      }),
    });

    assert.strictEqual(postRes.status, 202);
    assert.deepStrictEqual(getSessionClientInfo(sessionId!), {
      name: "sse-test-client",
      version: "1.0",
    });

    // Clean up SSE connection and ensure display metadata does not outlive it.
    // Socket close delivery is asynchronous and can be delayed under the full
    // suite, so poll with a bounded deadline instead of relying on a fixed nap.
    sseReq.destroy();
    const cleanupDeadline = Date.now() + 2_000;
    while (
      getSessionClientInfo(sessionId!) !== undefined &&
      Date.now() < cleanupDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.strictEqual(getSessionClientInfo(sessionId!), undefined);
  });
});
