import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  clearSessionRuntimeContext,
  extractClientInfo,
  getServerRuntimeContext,
  getSessionClientInfo,
  resetSessionRuntimeContexts,
  setServerRuntimeContext,
  setSessionClientInfo,
} from "../../src/gateway/session-context.js";
import {
  getProvenanceTracker,
  resetProvenanceTracker,
} from "../../src/approval/provenance.js";
import { registerTracedTool } from "../../src/tools/tool-wrapper.js";

describe("MCP session runtime context", () => {
  it("extracts and sanitizes initialize clientInfo only", () => {
    assert.deepStrictEqual(
      extractClientInfo({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "  Claude\nDesktop  ",
            version: " 1.2.3\t",
          },
        },
      }),
      {
        name: "Claude Desktop",
        version: "1.2.3",
      }
    );

    assert.strictEqual(
      extractClientInfo({
        method: "tools/list",
        params: {
          clientInfo: { name: "ignored", version: "1" },
        },
      }),
      undefined
    );
  });

  it("stores client display metadata per session and clears it independently", () => {
    resetSessionRuntimeContexts();
    setSessionClientInfo("a", { name: "Claude", version: "1" });
    setSessionClientInfo("b", { name: "Cursor", version: "2" });

    assert.deepStrictEqual(getSessionClientInfo("a"), {
      name: "Claude",
      version: "1",
    });
    assert.deepStrictEqual(getSessionClientInfo("b"), {
      name: "Cursor",
      version: "2",
    });

    clearSessionRuntimeContext("a");
    assert.strictEqual(getSessionClientInfo("a"), undefined);
    assert.deepStrictEqual(getSessionClientInfo("b"), {
      name: "Cursor",
      version: "2",
    });
  });

  it("binds a mutable runtime context to an MCP server instance", () => {
    const server = {};
    const context = { sessionId: "before" };
    setServerRuntimeContext(server, context);
    assert.strictEqual(
      getServerRuntimeContext(server)?.sessionId,
      "before"
    );

    context.sessionId = "after";
    assert.strictEqual(
      getServerRuntimeContext(server)?.sessionId,
      "after"
    );
  });

  it("lets registerTracedTool use gateway session context when handler extra has no sessionId", async () => {
    ConfigManager.resetInstance();
    resetProvenanceTracker();

    let captured: any;
    const server: any = {
      registerTool(name: string, config: any, handler: any) {
        captured = { name, config, handler };
      },
    };
    setServerRuntimeContext(server, {
      sessionId: "gateway-session-123",
      clientInfo: { name: "Fixture", version: "1" },
    });

    try {
      registerTracedTool(
        server,
        "system_info",
        {},
        async () => ({
          content: [{ type: "text", text: "fixture result" }],
        })
      );

      assert.ok(captured);
      await captured.handler({}, {});

      const recent = getProvenanceTracker().getRecent(
        "gateway-session-123",
        3
      );
      assert.strictEqual(recent.length, 1);
      assert.strictEqual(recent[0].tool, "system_info");
      assert.deepStrictEqual(
        getProvenanceTracker().getRecent(
          `local-process-${process.pid}`,
          3
        ),
        []
      );
    } finally {
      ConfigManager.resetInstance();
      resetProvenanceTracker();
    }
  });
});
