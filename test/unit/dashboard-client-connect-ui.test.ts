import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDashboardHtml } from "../../src/gateway/dashboard-html.js";

describe("Dashboard MCP client connection controls", () => {
  const html = getDashboardHtml("full", {
    schemaMode: "v2",
    preset: "balanced",
    terminalMode: "ask",
  });

  it("exposes preview and connect controls for Claude Desktop and Cursor", () => {
    for (const client of ["claude", "cursor"]) {
      assert.ok(
        html.includes(`onclick="previewMcpClient('${client}')"`),
        `${client} preview control must exist`
      );
      assert.ok(
        html.includes(`onclick="connectMcpClient('${client}')"`),
        `${client} connect control must exist`
      );
    }
    assert.ok(html.includes('id="clientConnectionPreview"'));
  });

  it("keeps the controls behind the local admin unlock", () => {
    const unlockedAt = html.indexOf('id="permissionsUnlocked"');
    const controlsAt = html.indexOf('id="clientConnectionPreview"');
    assert.ok(unlockedAt > 0, "admin panel must exist");
    assert.ok(
      controlsAt > unlockedAt,
      "client connection controls must live inside the unlocked admin panel"
    );
  });

  it("calls the admin client endpoints through the CSRF-aware helper", () => {
    assert.match(
      html,
      /adminRequest\(\s*'\/admin\/clients\/' \+ client \+ '\/preview'/
    );
    assert.match(
      html,
      /adminRequest\(\s*'\/admin\/clients\/' \+ client \+ '\/apply'/
    );
  });

  it("renders the preview as text instead of HTML", () => {
    assert.ok(
      html.includes(
        "document.getElementById('clientConnectionPreview').textContent"
      )
    );
    assert.strictEqual(
      html.includes("clientConnectionPreview').innerHTML"),
      false
    );
  });
});
