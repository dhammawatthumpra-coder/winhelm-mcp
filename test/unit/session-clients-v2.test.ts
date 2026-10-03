import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDashboardHtml } from "../../src/gateway/dashboard-html.js";
import {
  clearSessionRuntimeContext,
  listSessionClients,
  resetSessionRuntimeContexts,
  setSessionClientInfo,
} from "../../src/gateway/session-context.js";
import { hashSessionId } from "../../src/utils/audit-logger.js";

describe("Session client registry", () => {
  it("lists announced clients and drops closed sessions", () => {
    resetSessionRuntimeContexts();
    try {
      assert.deepStrictEqual(listSessionClients(), []);

      setSessionClientInfo("session-a", {
        name: "Claude Desktop",
        version: "1.2",
      });
      setSessionClientInfo("session-b", { name: "Cursor" });
      // Sessions that never announced clientInfo stay invisible.
      setSessionClientInfo("session-c", undefined);

      const listed = listSessionClients();
      assert.deepStrictEqual(
        listed.map((session) => session.sessionId),
        ["session-a", "session-b"]
      );
      assert.deepStrictEqual(listed[0].clientInfo, {
        name: "Claude Desktop",
        version: "1.2",
      });

      // The snapshot must not hand out the internal record.
      listed[0].clientInfo.name = "mutated";
      assert.strictEqual(
        listSessionClients()[0].clientInfo.name,
        "Claude Desktop"
      );

      clearSessionRuntimeContext("session-a");
      assert.deepStrictEqual(
        listSessionClients().map((session) => session.sessionId),
        ["session-b"]
      );
    } finally {
      resetSessionRuntimeContexts();
    }
  });

  it("hashes session ids for the admin plane", () => {
    const hashed = hashSessionId("session-a");
    assert.ok(hashed);
    assert.notStrictEqual(hashed, "session-a");
  });
});

describe("Dashboard connected client list", () => {
  const html = getDashboardHtml("full", {
    schemaMode: "v2",
    preset: "balanced",
    terminalMode: "ask",
  });

  it("renders the connection list inside the unlocked panel", () => {
    assert.ok(html.includes('id="sessionClients"'));
    assert.ok(html.includes("Connected MCP Clients"));
    assert.ok(
      html.includes(
        "Client names are supplied by the connecting client and are displayed as text only."
      )
    );

    const unlockedAt = html.indexOf('id="permissionsUnlocked"');
    assert.ok(html.indexOf('id="sessionClients"') > unlockedAt);
  });

  it("loads the list through the CSRF-aware admin helper", () => {
    assert.match(html, /adminRequest\('\/admin\/sessions'\)/);
    assert.match(html, /Promise\.all\(\[loadAdminProfile\(\), loadApprovals\(\), loadSessions\(\)\]\)/);
  });

  it("renders client-supplied names as text, never as HTML", () => {
    assert.match(
      html,
      /addTextElement\(\s*target,\s*'div',\s*label/
    );
    assert.strictEqual(
      html.includes("sessionClients').innerHTML"),
      false
    );
    assert.strictEqual(html.includes("target.innerHTML"), false);
  });
});
