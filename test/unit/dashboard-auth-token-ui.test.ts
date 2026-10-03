import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDashboardHtml } from "../../src/gateway/dashboard-html.js";
import { translate } from "../../src/i18n/messages.js";

describe("Dashboard MCP token rotation control", () => {
  const html = getDashboardHtml("full", {
    schemaMode: "v2",
    preset: "balanced",
    terminalMode: "ask",
  });

  it("offers a rotate control inside the unlocked admin panel", () => {
    assert.ok(html.includes("onclick=\"rotateAccessToken()\""));
    assert.ok(html.includes('id="tokenState"'));
    assert.ok(html.includes("MCP Access Token"));

    const unlockedAt = html.indexOf('id="permissionsUnlocked"');
    assert.ok(html.indexOf('id="tokenState"') > unlockedAt);
  });

  it("rotates through the CSRF-aware helper with confirmation", () => {
    assert.match(
      html,
      /adminRequest\('\/admin\/auth\/token\/rotate',\s*\{\s*method: 'POST'\s*\}\)/
    );
    assert.match(
      html,
      /if \(!window\.confirm\(DASHBOARD_MESSAGES\.tokenConfirm\)\) return;/
    );
  });

  it("shows the new token once as text", () => {
    assert.match(
      html,
      /addTextElement\(target, 'div', String\(body\.token \|\| ''\), 'token-value'\)/
    );
    assert.ok(html.includes("DASHBOARD_MESSAGES.tokenOnce"));
    assert.strictEqual(html.includes("tokenState').innerHTML"), false);
  });

  it("ships the rotation messages in both locales", () => {
    for (const key of [
      "dashboard.token.title",
      "dashboard.token.note",
      "dashboard.token.rotate",
      "dashboard.token.confirm",
      "dashboard.token.loading",
      "dashboard.token.new",
      "dashboard.token.once",
    ] as const) {
      const en = translate(key, {}, "en");
      const th = translate(key, {}, "th");
      assert.ok(en.trim().length > 0, `${key} en must not be empty`);
      assert.ok(th.trim().length > 0, `${key} th must not be empty`);
      assert.notStrictEqual(en, th, `${key} must be translated`);
    }
  });
});
