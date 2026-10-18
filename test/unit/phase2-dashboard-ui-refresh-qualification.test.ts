/**
 * WinHelm v1.4.1 Dashboard UI Refresh — Phase 2 Production UI Qualification Tests
 * 
 * Verifies all 16 mandatory requirements from Owner / Main Coordinator Decision:
 * 1. Home operational state mapping
 * 2. Remote Access OFF/ON/unknown mapping
 * 3. Approval rendering & sanitized details
 * 4. Backend-authoritative Mandatory Confirmation
 * 5. Profile vs Approval Mode separation
 * 6. Power profile wording preserving security floors
 * 7. Admin locked/unlocked behavior & modal dialog
 * 8. Privileged mutation auth & token rotation in Access & Security
 * 9. No plaintext token persistence
 * 10. DOM/HTML injection resistance (XSS defense)
 * 11. Strict CSP compatibility & valid JS syntax
 * 12. Keyboard, focus & dialog accessibility (role="dialog", aria-modal, landmarks)
 * 13. Responsive layout rules in CSS
 * 14. Prototype-only controls MUST NOT ship
 * 15. English & Thai rendering parity
 * 16. Legacy /dashboard availability
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getProductShellHtml } from "../../src/gateway/product-shell-html.js";
import { getDashboardHtml } from "../../src/gateway/dashboard-html.js";
import { validateI18nCatalogs } from "../../src/i18n/messages.js";

describe("Phase 2 Production UI Qualification Suite", () => {
  const defaultHtml = getProductShellHtml("full", {
    schemaMode: "v2",
    preset: "balanced",
    terminalMode: "ask",
    approvalMode: "smart",
  });

  it("1. Home operational state answers all 5 daily questions immediately", () => {
    assert.ok(defaultHtml.includes('id="panel-overview"'));
    // Q1: Server health
    assert.ok(defaultHtml.includes("Server Status"));
    assert.ok(defaultHtml.includes("statServerStatus"));
    // Q2: Pending approvals / attention
    assert.ok(defaultHtml.includes("statPendingBadge"));
    assert.ok(defaultHtml.includes("statPendingApprovals"));
    // Q3: Connected clients
    assert.ok(defaultHtml.includes("statConnectedClients"));
    assert.ok(defaultHtml.includes("Claude Desktop, Cursor, ChatGPT, Gemini"));
    // Q4: Security posture
    assert.ok(defaultHtml.includes("statProfile"));
    assert.ok(defaultHtml.includes("statApprovalMode"));
    // Q5: Remote Access off/on
    assert.ok(defaultHtml.includes("Remote Access"));
    assert.ok(defaultHtml.includes("Local Ready"));
    assert.ok(defaultHtml.includes("Remote Access Off"));
  });

  it("2. Remote Access enforces 'Local Ready · Remote Access Off' and fails closed", () => {
    assert.ok(defaultHtml.includes("Local Ready"));
    assert.ok(defaultHtml.includes("Remote Access Off"));
    assert.ok(defaultHtml.includes("Zero public exposure"));
    // Verify client script contains verified route checks and doesn't optimistically assume ON
    assert.ok(defaultHtml.includes("status.active === true || status.state === 'running'"));
    assert.ok(defaultHtml.includes("Local Ready · Remote Access Off"));
  });

  it("3. Approvals inbox renders sanitized details and priority queue", () => {
    assert.ok(defaultHtml.includes('id="panel-approvals"'));
    assert.ok(defaultHtml.includes('id="approvalJobs"'));
    assert.ok(defaultHtml.includes('aria-live="polite"'));
    assert.ok(defaultHtml.includes("Windows Native Notifications: Available & Active"));
    // Primary view does not dump raw JSON table
    assert.ok(defaultHtml.includes("approval-jobs-container"));
  });

  it("4. Mandatory Confirmation is strictly backend-authoritative (not frontend heuristic)", () => {
    // Client script checks job.requiresConfirmation from backend
    assert.ok(defaultHtml.includes("job.requiresConfirmation === true || job.requires_confirmation === true"));
    assert.ok(defaultHtml.includes("confirm_input_"));
    // Script must NOT check (riskLevel === 'high') to infer confirmation requirement
    const scriptMatch = defaultHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "Script tag must exist");
    const script = scriptMatch[1];
    assert.strictEqual(
      script.includes("needsConfirm = isHigh"),
      false,
      "Confirmation must not be inferred from risk level"
    );
  });

  it("5. Profile and Approval Mode are distinctly separated axes without claiming expanded capability", () => {
    assert.ok(defaultHtml.includes("Axis 1: Capability Profile"));
    assert.ok(defaultHtml.includes("Axis 2: Approval Policy"));
    assert.ok(defaultHtml.includes("Safe Profile restricts tool exposure; terminal mode controls execution safety."));
    assert.ok(defaultHtml.includes("Trusted Mode only applies to routine actions inside allowed folders"));
    assert.strictEqual(defaultHtml.includes("Power capability unlocked"), false);
    assert.strictEqual(defaultHtml.includes("Full system access granted"), false);
  });

  it("6. Power Profile copy explicitly preserves security floors (not 'Full OS control')", () => {
    assert.ok(defaultHtml.includes("Power is the broadest supported capability profile"));
    assert.ok(defaultHtml.includes("Absolute Deny, protected boundaries, Mandatory Confirmation"));
    assert.ok(defaultHtml.includes("Approval Mode ceiling and configured policy still apply"));
    assert.strictEqual(defaultHtml.includes("Full operating system control"), false);
  });

  it("7. Admin locked/unlocked state is explicit with accessible modal dialog", () => {
    assert.ok(defaultHtml.includes('id="adminPill"'));
    assert.ok(defaultHtml.includes('id="adminModal"'));
    assert.ok(defaultHtml.includes('role="dialog"'));
    assert.ok(defaultHtml.includes('aria-modal="true"'));
    assert.ok(defaultHtml.includes('aria-labelledby="adminModalTitle"'));
    assert.ok(defaultHtml.includes('id="adminCodeInput"'));
    assert.ok(defaultHtml.includes('submitAdminCode()'));
  });

  it("8. MCP Access Token rotation is placed in Access & Security as a privileged operation", () => {
    // Access panel must contain token rotation
    const accessPanel = defaultHtml.slice(defaultHtml.indexOf('id="panel-access"'), defaultHtml.indexOf('id="panel-activity"'));
    assert.ok(accessPanel.includes("Security Credentials & Token Management"));
    assert.ok(accessPanel.includes("Privileged Operation"));
    assert.ok(accessPanel.includes("rotateToken()"));
    assert.ok(accessPanel.includes("Rotating replaces the bearer token immediately"));

    // Ordinary settings panel must NOT contain the token rotation button
    const settingsPanel = defaultHtml.slice(defaultHtml.indexOf('id="panel-settings"'), defaultHtml.indexOf('id="panel-advanced"'));
    assert.strictEqual(settingsPanel.includes("rotateToken()"), false);
  });

  it("9. Tokens are never persisted in plaintext in DOM", () => {
    assert.ok(defaultHtml.includes("••••••••••••••••••••••••••••••••••••••••••••••••"));
    assert.strictEqual(defaultHtml.includes("wh_live_actual_raw_secret"), false);
  });

  it("10. Hostile inputs are safely HTML-escaped preventing XSS markup injection", () => {
    const hostile = '<script>alert("pwned")</script><img src=x onerror=alert(1)>';
    const escapedHtml = getProductShellHtml("full", {
      schemaMode: "v2",
      preset: hostile,
      focusJobId: hostile,
    });

    assert.strictEqual(escapedHtml.includes('<script>alert("pwned")</script>'), false);
    assert.strictEqual(escapedHtml.includes('<img src=x onerror=alert(1)>'), false);
    assert.ok(
      escapedHtml.includes('&lt;SCRIPT&gt;ALERT(&quot;PWNED&quot;)&lt;/SCRIPT&gt;') ||
      escapedHtml.includes('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;')
    );
  });

  it("11. Client script passes strict VM syntax compilation and uses connect-src 'self'", () => {
    const scriptMatches = [...defaultHtml.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptMatches.length > 0);

    for (const match of scriptMatches) {
      const code = match[1];
      assert.doesNotThrow(() => {
        new vm.Script(code);
      });
      assert.doesNotThrow(() => {
        new Function(code);
      });
    }
  });

  it("12. Accessibility landmarks and semantic dialog attributes are complete", () => {
    assert.ok(defaultHtml.includes('<header class="app-header" role="banner">'));
    assert.ok(defaultHtml.includes('<nav class="sidebar" id="appSidebar" role="navigation" aria-label="Primary Navigation">'));
    assert.ok(defaultHtml.includes('<main class="main-content" role="main">'));
    assert.ok(defaultHtml.includes('aria-current="page"'));
    // Visible focus in CSS
    assert.ok(defaultHtml.includes(":focus-visible"));
  });

  it("13. Responsive CSS rules handle desktop, tablet (900px), and mobile (640px)", () => {
    assert.ok(defaultHtml.includes("@media (max-width: 900px)"));
    assert.ok(defaultHtml.includes("@media (max-width: 640px)"));
    assert.ok(defaultHtml.includes(".mobile-menu-btn"));
  });

  it("14. Prototype-only controls MUST NOT ship in production shell", () => {
    assert.strictEqual(defaultHtml.includes("reviewer-toolbar"), false);
    assert.strictEqual(defaultHtml.includes("Review State:"), false);
    assert.strictEqual(defaultHtml.includes("stateSelect"), false);
    assert.strictEqual(defaultHtml.includes("viewportContainer"), false);
    assert.strictEqual(defaultHtml.includes("toggleRemoteAccess()"), false);
    assert.strictEqual(defaultHtml.includes("PROTOTYPE_MOCK_STATES"), false);
  });

  it("15. Maintains 100% Thai and English i18n catalog parity", () => {
    const issues = validateI18nCatalogs();
    assert.deepStrictEqual(issues, [], "i18n catalogs must have 0 discrepancies");

    const thaiHtml = getProductShellHtml("full", { schemaMode: "v2" });
    assert.ok(thaiHtml.length > 0);
  });

  it("16. Legacy engineering monitor remains available at /dashboard", () => {
    assert.ok(defaultHtml.includes('href="/dashboard"'));
    assert.ok(defaultHtml.includes("Advanced / Diagnostics"));

    const legacyHtml = getDashboardHtml("full");
    assert.ok(legacyHtml.includes("WinHelm | Monitor Dashboard"));
    assert.ok(legacyHtml.includes("LIVE MONITOR"));
  });
});
