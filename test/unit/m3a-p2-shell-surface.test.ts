import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getProductShellHtml } from "../../src/gateway/product-shell-html.js";
import {
  validateI18nCatalogs,
  EN_MESSAGES,
  TH_MESSAGES,
} from "../../src/i18n/messages.js";

const TUNNEL_I18N_KEYS = [
  "shell.connections.chatgpt.lifecycle_title",
  "shell.connections.chatgpt.dependency_label",
  "shell.connections.chatgpt.profile_label",
  "shell.connections.chatgpt.backend_label",
  "shell.connections.chatgpt.state_label",
  "shell.connections.chatgpt.ownership_label",
  "shell.connections.chatgpt.managed",
  "shell.connections.chatgpt.external_unmanaged",
  "shell.connections.chatgpt.action_start",
  "shell.connections.chatgpt.action_stop",
  "shell.connections.chatgpt.action_restart",
  "shell.connections.chatgpt.action_doctor",
  "shell.connections.chatgpt.confirm_hint",
  "shell.connections.chatgpt.confirm_placeholder",
  "shell.connections.chatgpt.external_notice",
  "shell.connections.chatgpt.configure_hint",
  "shell.connections.chatgpt.recovery_hint",
];

function extractScript(html: string): string {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "Product Shell must embed an inline script");
  return match[1];
}

describe("M3A P2: Product Shell ChatGPT tunnel lifecycle surface", () => {
  const html = getProductShellHtml("full");

  it("replaces the Target Architecture placeholder with lifecycle UI", () => {
    assert.ok(!html.includes("Target Architecture"));
    assert.ok(!html.includes("Full automated tunnel lifecycle is productized in milestone M3A."));
    for (const id of [
      "tunnelDependencyStatus",
      "tunnelProfileStatus",
      "tunnelBackendStatus",
      "tunnelStateBadge",
      "tunnelOwnershipBadge",
      "tunnelDetail",
      "tunnelConfirmInput",
      "tunnelActionResult",
    ]) {
      assert.ok(
        html.includes(id),
        `expected lifecycle element ${id} in Product Shell`
      );
    }
  });

  it("exposes Start/Stop/Restart/Doctor controls and visible typed confirmation", () => {
    const script = extractScript(html);
    for (const fn of [
      "handleTunnelStart",
      "handleTunnelStop",
      "handleTunnelRestart",
      "handleTunnelDoctor",
      "renderTunnelStatus",
      "fetchTunnelStatus",
    ]) {
      assert.ok(script.includes(`function ${fn}`), `expected ${fn} in shell script`);
    }
    // Typed confirmation is required visibly for start/stop/restart.
    assert.ok(script.includes("/admin/tunnel/start"));
    assert.ok(script.includes("/admin/tunnel/stop"));
    assert.ok(script.includes("/admin/tunnel/restart"));
    assert.ok(script.includes("confirmation"));
  });

  it("reads tunnel state from the backend status endpoint only", () => {
    const script = extractScript(html);
    assert.ok(script.includes("/admin/tunnel/status"));
    // The browser must not implement lifecycle policy (no process killing,
    // no direct tunnel-client execution from the shell).
    assert.ok(!script.includes("taskkill"));
    assert.ok(!script.includes("tunnel-client.exe"));
  });

  it("keeps the Tailscale card manual/advanced and separate from managed ChatGPT actions", () => {
    assert.ok(html.includes("Manual Configuration"));
    assert.ok(html.includes("Requires manual Tailscale Funnel / Serve configuration."));
    // Tailscale card must not gain tunnel lifecycle buttons.
    const tailscaleSection = html.slice(html.indexOf("connTailscaleLabel"));
    const nextCard = tailscaleSection.indexOf("</div>\n        </div>");
    const card = tailscaleSection.slice(0, nextCard > 0 ? nextCard : 600);
    assert.ok(!card.includes("handleTunnelStart"));
    assert.ok(!card.includes("handleTunnelStop"));
  });

  it("renders an inline script that is syntactically valid", () => {
    assert.doesNotThrow(() => {
      new vm.Script(extractScript(html));
    });
  });

  it("adds EN/TH i18n keys with parity for the tunnel lifecycle surface", () => {
    assert.deepStrictEqual(validateI18nCatalogs(), []);
    for (const key of TUNNEL_I18N_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(EN_MESSAGES, key),
        `missing EN key ${key}`
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(TH_MESSAGES, key),
        `missing TH key ${key}`
      );
      assert.ok((EN_MESSAGES as Record<string, string>)[key].length > 0);
      assert.ok((TH_MESSAGES as Record<string, string>)[key].length > 0);
    }
  });
});
