import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getProductShellHtml } from "../../src/gateway/product-shell-html.js";
import { EN_MESSAGES, TH_MESSAGES, validateI18nCatalogs } from "../../src/i18n/messages.js";

describe("Product Shell Surface & Rendering (M2B)", () => {
  it("renders inline script blocks that pass real JavaScript parse tests", () => {
    const html = getProductShellHtml("full", {
      schemaMode: "v2",
      preset: "balanced",
      terminalMode: "ask",
      approvalMode: "manual",
    });

    const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptMatches.length > 0, "Expected at least one inline <script> block in Product Shell HTML");

    for (let i = 0; i < scriptMatches.length; i++) {
      const scriptCode = scriptMatches[i][1];
      assert.ok(scriptCode.trim().length > 0, `Inline script ${i} should not be empty`);

      assert.doesNotThrow(() => {
        new vm.Script(scriptCode, { filename: `product-shell-rendered-${i}.js` });
      }, `Inline script ${i} failed vm.Script syntax validation`);

      assert.doesNotThrow(() => {
        new Function(scriptCode);
      }, `Inline script ${i} failed new Function syntax validation`);
    }
  });

  it("escapes hostile input strings to prevent markup/script injection (XSS defense)", () => {
    const hostilePayload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const html = getProductShellHtml("full", {
      schemaMode: "v2",
      preset: hostilePayload,
      focusJobId: hostilePayload,
    });

    assert.strictEqual(html.includes('<script>alert("xss")</script>'), false);
    assert.strictEqual(html.includes('<img src=x onerror=alert(1)>'), false);
    assert.ok(
      html.includes('&lt;SCRIPT&gt;ALERT(&quot;XSS&quot;)&lt;/SCRIPT&gt;') ||
      html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
    );
  });

  it("shows Capability Profile and Approval Mode as distinctly separated axes", () => {
    const html = getProductShellHtml("full", {
      schemaMode: "v2",
      preset: "safe",
      terminalMode: "off",
      approvalMode: "trusted",
    });

    // Profile axis
    assert.ok(html.includes("SAFE"));
    // Approval mode axis
    assert.ok(html.includes("TRUSTED"));
    // Verify clear distinction note between Safe Profile and terminal containment
    assert.ok(
      html.includes("Note: Safe Profile restricts available tool schemas; terminal mode controls execution safety.") ||
      html.includes("Safe Profile restricts tool exposure")
    );
  });

  it("ensures Safe Profile + Trusted Approval Mode copy never implies expanded capability", () => {
    const html = getProductShellHtml("full", {
      schemaMode: "v2",
      preset: "safe",
      terminalMode: "off",
      approvalMode: "trusted",
    });

    // Trusted mode must not claim power or full capability
    assert.strictEqual(html.includes("Power capability unlocked"), false);
    assert.strictEqual(html.includes("Full system access granted"), false);
  });

  it("does not expose dangerous terminal mode in ordinary product settings", () => {
    const html = getProductShellHtml("full", {
      schemaMode: "v2",
      preset: "balanced",
      terminalMode: "ask",
    });

    const settingsSection = html.slice(html.indexOf('id="panel-settings"'));
    // dangerous should not be an option in settings select
    assert.strictEqual(settingsSection.includes('<option value="dangerous"'), false);
    assert.ok(settingsSection.includes("Dangerous terminal mode is not permitted in product settings"));
  });

  it("truthfully classifies connection targets", () => {
    const html = getProductShellHtml("full", { schemaMode: "v2" });

    // Claude Desktop is First-Class
    assert.ok(html.includes("Claude Desktop"));
    assert.ok(html.includes("First-Class"));

    // Cursor is First-Class
    assert.ok(html.includes("Cursor"));

    // ChatGPT is First-Class Target
    assert.ok(html.includes("ChatGPT / OpenAI Tunnel"));
    assert.ok(html.includes("First-Class Target"));

    // Tailscale is Advanced / Manual
    assert.ok(html.includes("Tailscale HTTPS /mcp"));
    assert.ok(html.includes("Advanced / Manual"));
  });

  it("provides an explicit entry point to preserved engineering dashboard at /dashboard", () => {
    const html = getProductShellHtml("full", { schemaMode: "v2" });
    assert.ok(html.includes('href="/dashboard"'));
    assert.ok(html.includes("Advanced / Diagnostics"));
  });

  it("includes approvalJobs container for deep link and approval contract compliance", () => {
    const html = getProductShellHtml("full", {
      schemaMode: "v2",
      focusJobId: "job_test_123",
    });
    assert.ok(html.includes('id="approvalJobs"'));
    assert.ok(html.includes("Approval Jobs"));
  });

  it("maintains strict English/Thai i18n key and placeholder parity", () => {
    assert.deepStrictEqual(
      Object.keys(TH_MESSAGES).sort(),
      Object.keys(EN_MESSAGES).sort()
    );
    assert.deepStrictEqual(validateI18nCatalogs(), []);
  });
});
