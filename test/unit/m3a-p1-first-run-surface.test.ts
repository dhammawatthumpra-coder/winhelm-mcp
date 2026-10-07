import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProductShellHtml } from "../../src/gateway/product-shell-html.js";
import {
  EN_MESSAGES,
  TH_MESSAGES,
  validateI18nCatalogs,
} from "../../src/i18n/messages.js";

/**
 * M3A Phase 1 — H-23 regression (RED first against unmodified production
 * source): the Product Shell must invoke the canonical backend client key
 * `claude` for Claude Desktop preview/apply actions. The backend
 * `parseClientName()` accepts only `claude` and `cursor`; any other key fails
 * closed with INVALID_CLIENT.
 */
describe("M3A P1 H-23: canonical Claude client key in Product Shell", () => {
  it("renders Claude preview/apply actions with the canonical `claude` key", () => {
    const html = getProductShellHtml("full", { schemaMode: "v2" });

    assert.ok(
      html.includes("handleClientPreview('claude')"),
      "Product Shell Claude Preview must call handleClientPreview('claude')"
    );
    assert.ok(
      html.includes("handleClientApply('claude')"),
      "Product Shell Claude Configure must call handleClientApply('claude')"
    );
  });

  it("contains no `claude-desktop` request key in the executable UI path", () => {
    const html = getProductShellHtml("full", { schemaMode: "v2" });

    assert.strictEqual(
      html.includes("claude-desktop"),
      false,
      "No `claude-desktop` client key may remain anywhere in the rendered Product Shell"
    );
  });

  it("states that the client must restart or reconnect after configuration", () => {
    const html = getProductShellHtml("full", { schemaMode: "v2" });
    assert.ok(
      html.includes("restart it or reconnect so the new configuration is loaded"),
      "Connections apply path must surface the restart/reconnect requirement"
    );
  });
});

/**
 * M3A Phase 1 — guided first-run setup surface. The checklist must exist as a
 * permanent, re-openable panel that derives its status from backend state and
 * orchestrates the accepted Access / Settings / Connections / Approvals /
 * Activity panels instead of duplicating their authority.
 */
describe("M3A P1: guided first-run setup surface", () => {
  const html = getProductShellHtml("full", {
    schemaMode: "v2",
    preset: "balanced",
    approvalMode: "manual",
  });

  it("provides a Setup panel with a permanent re-openable nav entry", () => {
    assert.ok(html.includes('id="panel-setup"'));
    assert.ok(html.includes('data-tab="setup"'));
    // Re-entry: the nav entry is always rendered, not gated on a completion flag.
    assert.ok(html.includes("showTab('setup')"));
  });

  it("covers the required journey steps", () => {
    assert.ok(html.includes("Workspace Folders"));
    assert.ok(html.includes("Capability Profile"));
    assert.ok(html.includes("Approval Mode"));
    assert.ok(html.includes("Connect Claude Desktop or Cursor"));
    assert.ok(html.includes("Connection Observation"));
    assert.ok(html.includes("First Safe Action"));
    assert.ok(html.includes("Where Things Live"));
  });

  it("derives status from backend truth, not a browser completion flag", () => {
    // Backend-truth data sources wired into the setup checklist.
    assert.ok(html.includes("'/admin/clients/status'"));
    assert.ok(html.includes("'/admin/profile'"));
    assert.ok(html.includes("'/admin/sessions'"));
    // Distinct truthful states projected into the checklist.
    assert.ok(html.includes("Configured"));
    assert.ok(html.includes("Needs Configuration"));
    assert.ok(html.includes("Attention"));
    assert.ok(html.includes("Active Session Observed"));
    assert.ok(html.includes("No Active Session Observed"));
  });

  it("auto-surfaces only on clearly incomplete backend state (no workspace folders)", () => {
    assert.ok(
      html.includes("profileFolders.length === 0"),
      "First-run auto-surface must key off missing backend workspace folders"
    );
    assert.ok(
      html.includes("setupAutoSurfaced"),
      "Auto-surface must be one-shot so configured users keep the normal path"
    );
  });

  it("keeps first-safe-action guidance as instruction text only", () => {
    assert.ok(html.includes("This is instruction text only"));
    assert.ok(html.includes("list the files in my workspace folder"));
    // The browser must not execute MCP tools itself.
    assert.strictEqual(html.includes("fetch('/mcp'"), false);
    assert.strictEqual(html.includes("apiRequest('/mcp'"), false);
  });

  it("orients the user to Approvals and Activity", () => {
    assert.ok(
      html.includes("Approve or deny pending tool actions under Approvals")
    );
    assert.ok(html.includes("showTab('approvals')"));
    assert.ok(html.includes("showTab('activity')"));
  });

  it("keeps the setup checklist free of a client-side policy engine", () => {
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "Expected inline script block");
    const script = scriptMatch[1];
    assert.strictEqual(script.includes("toolPolicy"), false);
    assert.strictEqual(script.includes("allowedTools"), false);
    assert.strictEqual(script.includes("risk.class === "), false);
  });

  it("adds M3A setup messages to both EN and TH catalogs with parity", () => {
    const setupKeys = Object.keys(EN_MESSAGES).filter((key) =>
      key.startsWith("shell.setup.")
    );
    assert.ok(setupKeys.length >= 20, "Expected the M3A setup message block");
    for (const key of [...setupKeys, "shell.nav.setup", "shell.connections.restart_hint"]) {
      assert.ok(EN_MESSAGES[key as keyof typeof EN_MESSAGES]?.trim());
      assert.ok(TH_MESSAGES[key as keyof typeof TH_MESSAGES]?.trim());
    }
    assert.deepStrictEqual(validateI18nCatalogs(), []);
  });
});
