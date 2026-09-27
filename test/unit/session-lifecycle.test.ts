import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StreamableGateway } from "../../src/gateway/streamable-gateway.js";
import { SseGateway } from "../../src/gateway/sse-gateway.js";

describe("Session Lifecycle & Eviction Engine", () => {
  it("should evict idle sessions in StreamableGateway when exceeding idle timeout", async () => {
    // 50ms idle timeout, max 10 sessions
    const gateway = new StreamableGateway(50, 10);

    try {
      let closed = false;
      gateway.registerSessionForTest("sess-idle-1", {
        mcpServer: {
          close: async () => {
            closed = true;
          },
        },
        lastActivityAt: Date.now() - 100, // already past 50ms
      });

      assert.strictEqual(gateway.getActiveSessionCount(), 1);

      // Run cleanup
      const evictedCount = gateway.cleanupIdleSessions();
      assert.strictEqual(evictedCount, 1);
      assert.strictEqual(gateway.getActiveSessionCount(), 0);
      assert.strictEqual(closed, true, "McpServer close should have been triggered upon eviction");
    } finally {
      await gateway.closeAll();
    }
  });

  it("should enforce MAX_SESSIONS capacity via LRU eviction in StreamableGateway", async () => {
    // Max 2 sessions cap
    const gateway = new StreamableGateway(60000, 2);

    try {
      let evictedFirst = false;

      // Register session 1 (older)
      gateway.registerSessionForTest("sess-1", {
        mcpServer: {
          close: async () => {
            evictedFirst = true;
          },
        },
        lastActivityAt: Date.now() - 1000,
      });

      // Register session 2 (newer)
      gateway.registerSessionForTest("sess-2", {
        lastActivityAt: Date.now(),
      });

      assert.strictEqual(gateway.getActiveSessionCount(), 2);

      // Register session 3 (exceeds cap of 2 -> must evict sess-1)
      gateway.registerSessionForTest("sess-3", {
        lastActivityAt: Date.now(),
      });

      assert.strictEqual(gateway.getActiveSessionCount(), 2, "Sessions must not exceed cap of 2");
      assert.strictEqual(gateway.getSession("sess-1"), undefined, "Oldest session sess-1 should have been evicted");
      assert.ok(gateway.getSession("sess-2"), "sess-2 should still be present");
      assert.ok(gateway.getSession("sess-3"), "sess-3 should be present");
      assert.strictEqual(evictedFirst, true, "Oldest server should have been closed");
    } finally {
      await gateway.closeAll();
    }
  });

  it("should evict idle sessions in SseGateway when exceeding idle timeout", async () => {
    const sse = new SseGateway(50, 10);

    try {
      let closed = false;
      sse.registerSessionForTest("sse-idle-1", {
        mcpServer: {
          close: async () => {
            closed = true;
          },
        },
        lastActivityAt: Date.now() - 100,
      });

      assert.strictEqual(sse.getActiveSessionCount(), 1);

      const evicted = sse.cleanupIdleSessions();
      assert.strictEqual(evicted, 1);
      assert.strictEqual(sse.getActiveSessionCount(), 0);
      assert.strictEqual(closed, true);
    } finally {
      await sse.closeAll();
    }
  });

  it("should enforce MAX_SESSIONS capacity via LRU eviction in SseGateway", async () => {
    const sse = new SseGateway(60000, 2);

    try {
      sse.registerSessionForTest("sse-1", { lastActivityAt: Date.now() - 2000 });
      sse.registerSessionForTest("sse-2", { lastActivityAt: Date.now() - 500 });
      assert.strictEqual(sse.getActiveSessionCount(), 2);

      // Register 3rd session -> should evict sse-1
      sse.registerSessionForTest("sse-3", { lastActivityAt: Date.now() });
      assert.strictEqual(sse.getActiveSessionCount(), 2);
      assert.strictEqual(sse.getSession("sse-1"), undefined);
      assert.ok(sse.getSession("sse-2"));
      assert.ok(sse.getSession("sse-3"));
    } finally {
      await sse.closeAll();
    }
  });
});
