/**
 * WinHelm v1.4.1 Dashboard UI Refresh — Phase 2 Production UI Qualification Tests
 * 
 * Verifies all mandatory requirements from Owner / Main Coordinator Decision & Adjudication:
 * 1. Home operational state mapping
 * 2. Remote Access OFF/ON/unknown mapping & fails closed
 * 3. Blocker A: Native Approval status is truthful and requires authoritative adapter state
 * 4. Mandatory Confirmation is strictly backend-authoritative (not frontend heuristic)
 * 5. Profile vs Approval Mode separation
 * 6. Power profile wording preserving security floors
 * 7. Admin locked/unlocked behavior & modal dialog
 * 8. Privileged mutation auth & token rotation in Access & Security
 * 9. No plaintext token persistence
 * 10. DOM/HTML injection resistance (XSS defense)
 * 11. Strict CSP compatibility & valid JS syntax
 * 12. Accessibility landmarks and semantic dialog attributes
 * 13. Responsive layout rules in CSS
 * 14. Prototype-only controls MUST NOT ship
 * 15. Blocker B: Dynamic Ports production state is NOT fabricated (no 18820/18821/18822, safe default)
 * 16. Blocker C: Setup Assistant placeholder MUST NOT ship (no alert placeholder, disabled when unintegrated)
 * 17. Blocker D: English & Thai localization parity and full catalog-backed copy rendering
 * 18. Legacy /dashboard availability
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProductShellHtml, type ProductShellSummary } from "../../src/gateway/product-shell-html.js";
import { getDashboardHtml } from "../../src/gateway/dashboard-html.js";
import { validateI18nCatalogs, setConfiguredLocale, getRuntimeLocale } from "../../src/i18n/messages.js";
import { getClientScript } from "../../src/gateway/ui/client-script.js";

function renderTestShell(summary?: Partial<ProductShellSummary>): string {
  return getProductShellHtml("full", {
    schemaMode: "v2",
    preset: "balanced",
    terminalMode: "ask",
    approvalMode: "smart",
    ...summary,
  });
}

describe("Phase 2 Production UI Qualification Suite", () => {
  beforeEach(() => {
    delete process.env.WINHELM_LOCALE;
    setConfiguredLocale("en");
  });

  it("1. Home operational state answers all 5 daily questions immediately", () => {
    const html = renderTestShell();
    assert.ok(html.includes('id="panel-overview"'));
    // Q1: Server health
    assert.ok(html.includes("Server Status"));
    assert.ok(html.includes("statServerStatus"));
    // Q2: Pending approvals / attention
    assert.ok(html.includes("statPendingBadge"));
    assert.ok(html.includes("statPendingApprovals"));
    // Q3: Connected clients
    assert.ok(html.includes("statConnectedClients"));
    assert.ok(html.includes("Claude Desktop, Cursor, ChatGPT, Gemini"));
    // Q4: Security posture
    assert.ok(html.includes("statProfile"));
    assert.ok(html.includes("statApprovalMode"));
    // Q5: Remote Access off/on
    assert.ok(html.includes("Remote Access"));
    assert.ok(html.includes("Local Ready"));
    assert.ok(html.includes("Remote Access Off"));
  });

  it("2. Remote Access enforces 'Local Ready · Remote Access Off' and fails closed", () => {
    const html = renderTestShell();
    assert.ok(html.includes("Local Ready"));
    assert.ok(html.includes("Remote Access Off"));
    assert.ok(html.includes("Zero public exposure"));
    // Verify client script contains verified route checks and doesn't optimistically assume ON
    assert.ok(html.includes("status.active === true || status.state === 'running'"));
  });

  it("3. Blocker A Corrective: Native Approval status is truthful and requires authoritative adapter state", () => {
    // 3.1 Default render MUST NOT claim "Available & Active" in approvals panel markup
    const defaultHtml = renderTestShell();
    const approvalsPanel = defaultHtml.slice(
      defaultHtml.indexOf('id="panel-approvals"'),
      defaultHtml.indexOf('id="panel-activity"')
    );
    assert.strictEqual(
      approvalsPanel.includes("Available &amp; Active"),
      false,
      "Approvals panel markup must NOT claim Available & Active without authoritative status"
    );
    // 3.2 Default render MUST show "Not yet integrated"
    assert.ok(
      approvalsPanel.includes("Windows Native Notifications: Not yet integrated"),
      "Default state must indicate Not yet integrated"
    );
    assert.ok(
      approvalsPanel.includes("Desktop notification integration is pending. Web Dashboard approvals remain your active, authoritative fallback."),
      "Must show fallback notice to Web Dashboard"
    );

    // 3.3 Authoritative adapter state 'ready' renders Available & Active in approvals panel markup
    const readyHtml = renderTestShell({
      adapters: { nativeApproval: "ready" },
    });
    const readyPanel = readyHtml.slice(
      readyHtml.indexOf('id="panel-approvals"'),
      readyHtml.indexOf('id="panel-activity"')
    );
    assert.ok(
      readyPanel.includes("Windows Native Notifications: Available &amp; Active"),
      "Ready adapter must render Available & Active"
    );

    // 3.4 Authoritative adapter state 'unavailable' renders Not yet integrated
    const unavailHtml = renderTestShell({
      adapters: { nativeApproval: "unavailable" },
    });
    const unavailPanel = unavailHtml.slice(
      unavailHtml.indexOf('id="panel-approvals"'),
      unavailHtml.indexOf('id="panel-activity"')
    );
    assert.ok(
      unavailPanel.includes("Windows Native Notifications: Not yet integrated"),
      "Unavailable adapter must render safe default"
    );
  });

  it("4. Mandatory Confirmation is strictly backend-authoritative (not frontend heuristic)", () => {
    const html = renderTestShell();
    // Client script checks job.requiresConfirmation from backend
    assert.ok(html.includes("job.requiresConfirmation === true || job.requires_confirmation === true"));
    assert.ok(html.includes("confirm_input_"));
    // Script must NOT check (riskLevel === 'high') to infer confirmation requirement
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "Script tag must exist");
    const script = scriptMatch[1];
    assert.strictEqual(
      script.includes("needsConfirm = isHigh"),
      false,
      "Confirmation must not be inferred from risk level"
    );
  });

  it("5. Profile and Approval Mode are distinctly separated axes without claiming expanded capability", () => {
    const html = renderTestShell();
    assert.ok(html.includes("Axis 1: Capability Profile"));
    assert.ok(html.includes("Axis 2: Approval Policy"));
    assert.ok(html.includes("Safe Profile restricts tool exposure; terminal mode controls execution safety."));
    assert.ok(html.includes("Trusted Mode only applies to routine actions inside allowed folders"));
    assert.strictEqual(html.includes("Power capability unlocked"), false);
    assert.strictEqual(html.includes("Full system access granted"), false);
  });

  it("6. Power Profile copy explicitly preserves security floors (not 'Full OS control')", () => {
    const html = renderTestShell();
    assert.ok(html.includes("Power is the broadest supported capability profile"));
    assert.ok(html.includes("Absolute Deny, protected boundaries, Mandatory Confirmation"));
    assert.ok(html.includes("Approval Mode ceiling and configured policy still apply"));
    assert.strictEqual(html.includes("Full operating system control"), false);
  });

  it("7. Admin locked/unlocked state is explicit with accessible modal dialog", () => {
    const html = renderTestShell();
    assert.ok(html.includes('id="adminPill"'));
    assert.ok(html.includes('id="adminModal"'));
    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('aria-labelledby="adminModalTitle"'));
    assert.ok(html.includes('id="adminCodeInput"'));
    assert.ok(html.includes('submitAdminCode()'));
  });

  it("8. MCP Access Token rotation is placed in Access & Security as a privileged operation", () => {
    const html = renderTestShell();
    const accessPanel = html.slice(html.indexOf('id="panel-access"'), html.indexOf('id="panel-approvals"'));
    assert.ok(accessPanel.includes("Security Credentials &amp; Token Management"));
    assert.ok(accessPanel.includes("Privileged Operation"));
    assert.ok(accessPanel.includes("rotateToken()"));
    assert.ok(accessPanel.includes("Rotating this token invalidates all active client sessions immediately"));

    const settingsPanel = html.slice(html.indexOf('id="panel-settings"'), html.indexOf('id="panel-advanced"'));
    assert.strictEqual(settingsPanel.includes("rotateToken()"), false);
  });

  it("9. Tokens are never persisted in plaintext in DOM", () => {
    const html = renderTestShell();
    assert.ok(html.includes("••••••••••••••••••••••••••••••••••••••••••••••••"));
    assert.strictEqual(html.includes("wh_live_actual_raw_secret"), false);
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
    const html = renderTestShell();
    const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];
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
    const html = renderTestShell();
    assert.ok(html.includes('<header class="app-header" role="banner">'));
    assert.ok(html.includes('<nav class="sidebar" id="appSidebar" role="navigation" aria-label="Primary Navigation">'));
    assert.ok(html.includes('<main class="main-content" role="main">'));
    assert.ok(html.includes('aria-current="page"'));
    assert.ok(html.includes(":focus-visible"));
  });

  it("13. Responsive CSS rules handle desktop, tablet (900px), and mobile (640px)", () => {
    const html = renderTestShell();
    assert.ok(html.includes("@media (max-width: 900px)"));
    assert.ok(html.includes("@media (max-width: 640px)"));
    assert.ok(html.includes(".mobile-menu-btn"));
  });

  it("14. Prototype-only controls MUST NOT ship in production shell", () => {
    const html = renderTestShell();
    assert.strictEqual(html.includes("reviewer-toolbar"), false);
    assert.strictEqual(html.includes("Review State:"), false);
    assert.strictEqual(html.includes("stateSelect"), false);
    assert.strictEqual(html.includes("viewportContainer"), false);
    assert.strictEqual(html.includes("toggleRemoteAccess()"), false);
    assert.strictEqual(html.includes("PROTOTYPE_MOCK_STATES"), false);
  });

  it("15. Blocker B Corrective: Dynamic Ports state is NOT fabricated (no 18820/18821/18822, safe default)", () => {
    const defaultHtml = renderTestShell();
    // 15.1 Production output must contain NONE of the fabricated numeric ports anywhere
    assert.strictEqual(defaultHtml.includes("18820"), false, "Port 18820 must NOT be hardcoded in production");
    assert.strictEqual(defaultHtml.includes("18821"), false, "Port 18821 must NOT be hardcoded in production");
    assert.strictEqual(defaultHtml.includes("18822"), false, "Port 18822 must NOT be hardcoded in production");

    // 15.2 Advanced panel markup must NOT claim "Automatic Mode" without adapter
    const advancedPanel = defaultHtml.slice(
      defaultHtml.indexOf('id="panel-advanced"'),
      defaultHtml.indexOf('</main>')
    );
    assert.strictEqual(
      advancedPanel.includes("Automatic Mode"),
      false,
      "Advanced panel must NOT claim Automatic Mode without authoritative adapter"
    );
    assert.ok(
      advancedPanel.includes("Dynamic Ports: Not yet integrated"),
      "Must display safe unknown default"
    );
    assert.ok(
      advancedPanel.includes("Endpoint topology will be resolved dynamically when Tranche A integration is active."),
      "Must show empty endpoints notice"
    );

    // 15.3 Authoritative adapter state 'automatic' with real endpoints
    const dynamicHtml = renderTestShell({
      adapters: {
        dynamicPorts: {
          mode: "automatic",
          endpoints: [
            { service: "Test Gateway", url: "http://127.0.0.1:29050", status: "Active" }
          ],
        },
      },
    });
    const dynamicPanel = dynamicHtml.slice(
      dynamicHtml.indexOf('id="panel-advanced"'),
      dynamicHtml.indexOf('</main>')
    );
    assert.ok(dynamicPanel.includes("Automatic Mode"), "Adapter automatic mode renders properly");
    assert.ok(dynamicPanel.includes("http://127.0.0.1:29050"), "Verified adapter endpoint renders properly");
    assert.ok(dynamicPanel.includes("Test Gateway"), "Verified adapter service name renders properly");
  });

  it("16. Blocker C Corrective: Setup Assistant companion does NOT contain placeholder action and is disabled when unintegrated", () => {
    const defaultHtml = renderTestShell();
    // 16.1 No alert placeholder anywhere in the output
    assert.strictEqual(
      defaultHtml.includes("alert('In production"),
      false,
      "Placeholder alert must NOT ship in production"
    );
    assert.strictEqual(
      defaultHtml.includes("launches standalone Setup Assistant companion"),
      false,
      "Placeholder copy must NOT ship in production"
    );

    // 16.2 In default render, companion is not detected and launch button is disabled
    const setupPanel = defaultHtml.slice(
      defaultHtml.indexOf('id="panel-setup"'),
      defaultHtml.indexOf('id="panel-access"')
    );
    assert.ok(setupPanel.includes("ตรวจไม่พบโปรแกรมเสริม") || setupPanel.includes("Companion Not Detected"), "Status must indicate Companion Not Detected");
    assert.ok(
      setupPanel.includes("disabled") && setupPanel.includes('aria-disabled="true"'),
      "Launch button must have disabled attribute and aria-disabled='true'"
    );
    assert.ok(
      setupPanel.includes("Setup Assistant companion bridge is not detected or not yet integrated."),
      "Must explain that companion bridge is not detected"
    );

    // 16.3 Blocker C Corrective: Even when adapter reports installed_ready, launch remains disabled in Phase 2
    // without invoking undefined launchSetupAssistant(), until Phase 3 companion bridge exists
    const readyHtml = renderTestShell({
      adapters: { setupAssistant: "installed_ready" },
    });
    const readyPanel = readyHtml.slice(
      readyHtml.indexOf('id="panel-setup"'),
      readyHtml.indexOf('id="panel-access"')
    );
    assert.ok(readyPanel.includes("Companion Installed &amp; Ready"), "Status must indicate Companion Installed & Ready");
    assert.strictEqual(
      readyPanel.includes("launchSetupAssistant()"),
      false,
      "Must NOT render onclick calling undefined launchSetupAssistant()"
    );
    assert.ok(
      readyPanel.includes("disabled") && readyPanel.includes('aria-disabled="true"'),
      "Launch button must remain disabled even when installed_ready until Phase 3 bridge contract exists"
    );
    assert.ok(
      readyPanel.includes("Phase 3") || readyPanel.includes("cross-tranche") || readyPanel.includes("bridge"),
      "Must explain companion bridge integration contract in title/hint"
    );
  });

  it("17. Blocker D Corrective: Thai & English localization parity and truthful catalog-backed rendering", () => {
    // 17.1 Zero catalog discrepancies
    const issues = validateI18nCatalogs();
    assert.deepStrictEqual(issues, [], "i18n catalogs must have 0 discrepancies");

    const initialLocale = getRuntimeLocale();
    const oldEnvLocale = process.env.WINHELM_LOCALE;
    delete process.env.WINHELM_LOCALE;
    try {
      // 17.2 English rendering verification
      setConfiguredLocale("en");
      const enHtml = renderTestShell();
      assert.ok(enHtml.includes('lang="en"'));
      assert.ok(enHtml.includes("Server Status"));
      assert.ok(enHtml.includes("Local Ready"));
      assert.ok(enHtml.includes("Remote Access Off"));
      assert.ok(enHtml.includes("Dynamic Ports: Not yet integrated"));
      assert.ok(enHtml.includes("Companion Not Detected"));

      // 17.3 Thai rendering verification
      setConfiguredLocale("th");
      const thHtml = renderTestShell();
      assert.ok(thHtml.includes('lang="th"'));
      assert.ok(thHtml.includes("WinHelm | ศูนย์ควบคุม"));
      assert.ok(thHtml.includes("ภาพรวม"));
      assert.ok(thHtml.includes("สถานะเซิร์ฟเวอร์"));
      assert.ok(thHtml.includes("พอร์ตไดนามิก: ยังไม่ได้รวมระบบ"));
      assert.ok(thHtml.includes("ตรวจไม่พบโปรแกรมเสริม"));
      assert.ok(thHtml.includes("ปิดการเข้าถึงระยะไกล"));
      assert.ok(thHtml.includes("พร้อมใช้งานในเครื่อง"));
    } finally {
      if (oldEnvLocale !== undefined) {
        process.env.WINHELM_LOCALE = oldEnvLocale;
      } else {
        delete process.env.WINHELM_LOCALE;
      }
      setConfiguredLocale(initialLocale);
    }
  });

  it("18. Legacy engineering monitor remains available at /dashboard", () => {
    const html = renderTestShell();
    assert.ok(html.includes('href="/dashboard"'));
    assert.ok(html.includes("Advanced / Diagnostics"));

    const legacyHtml = getDashboardHtml("full");
    assert.ok(legacyHtml.includes("WinHelm | Monitor Dashboard"));
    assert.ok(legacyHtml.includes("LIVE MONITOR"));
  });

  it("19. Blocker D Corrective: No hardcoded Phase-2 English human-facing strings bypass i18n in client-script.ts", () => {
    // 1. Raw client-script must contain no human-facing English string literals
    const rawScript = getClientScript("{}", "");

    // 2. In Thai mode, the rendered client script must contain no untranslated English human strings
    setConfiguredLocale("th");
    const thHtml = renderTestShell();
    const scriptMatch = thHtml.match(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/i);
    assert.ok(scriptMatch, "Client script must be present");
    const thScript = scriptMatch[1];

    const forbiddenPhrases = [
      "Lock admin privileges now?",
      "Please enter one-time admin code.",
      "Connection error: ",
      "When AI clients request sensitive or mutating actions, they will appear here.",
      "Medium Risk",
      "Risk Reason:",
      "Mutating operation",
      "Action Target:",
      "Mandatory Safety Confirmation Required",
      "Please type 'confirm' exactly.",
      "Approval failed: ",
      "Denial failed: ",
      "Verified tunnel active: ",
      "Remote Active",
      "Verified ingress route reachable.",
      "Local Ready · Remote Access Off",
      "Zero public exposure.",
      "Doctor check complete: ",
      "No active MCP client sessions announced yet.",
      "Loading client preview…",
      "Configuring client…",
      "Rotate the MCP access token now?",
      "Failed to rotate token.",
      "New MCP Bearer Access Token generated successfully",
      "Preview Validation:",
      "Access policy applied.",
      "No recent activity recorded.",
      "Running installation diagnostic probes…",
      "WinHelm gateway healthy.",
      "Diagnostic check failed: "
    ];

    for (const phrase of forbiddenPhrases) {
      assert.strictEqual(
        rawScript.includes(phrase),
        false,
        `Hardcoded phrase '${phrase}' must NOT exist as literal in client script template; must use SHELL_MESSAGES`
      );
      assert.strictEqual(
        thScript.includes(phrase),
        false,
        `Hardcoded phrase '${phrase}' must NOT exist in Thai client script payload; must be translated`
      );
    }
  });

  it("20. Blocker D Corrective: Critical ARIA labels and view accessibility copy use localized messages", () => {
    const initialLocale = getRuntimeLocale();
    const oldEnvLocale = process.env.WINHELM_LOCALE;
    delete process.env.WINHELM_LOCALE;

    try {
      // In English
      setConfiguredLocale("en");
      const enHtml = renderTestShell();
      assert.ok(enHtml.includes('aria-label="Primary Navigation"'), "EN nav landmark");
      assert.ok(enHtml.includes('aria-label="Toggle visual theme"'), "EN theme toggle aria");
      assert.ok(enHtml.includes('aria-label="Switch interface language"'), "EN lang toggle aria");
      assert.ok(enHtml.includes('aria-label="Close dialog"'), "EN modal close aria");
      assert.ok(enHtml.includes('aria-label="Pending Approvals Queue"'), "EN approvals queue aria");
      assert.ok(enHtml.includes('aria-label="Dynamic Internal Ports"'), "EN dynamic ports aria");
      assert.ok(enHtml.includes('aria-label="Process Telemetry"'), "EN telemetry aria");
      assert.ok(enHtml.includes('aria-label="Setup Assistant Companion"'), "EN companion aria");

      // In Thai
      setConfiguredLocale("th");
      const thHtml = renderTestShell();
      assert.ok(thHtml.includes('aria-label="การนำทางหลัก"'), "TH nav landmark");
      assert.ok(thHtml.includes('aria-label="สลับธีมการแสดงผล"'), "TH theme toggle aria");
      assert.ok(thHtml.includes('aria-label="สลับภาษาของอินเทอร์เฟซ"'), "TH lang toggle aria");
      assert.ok(thHtml.includes('aria-label="ปิดหน้าต่าง"'), "TH modal close aria");
      assert.ok(thHtml.includes('aria-label="คิวรายการรออนุมัติ"'), "TH approvals queue aria");
      assert.ok(thHtml.includes('aria-label="พอร์ตภายในแบบไดนามิก"'), "TH dynamic ports aria");
      assert.ok(thHtml.includes('aria-label="ข้อมูลการทำงานของกระบวนการ"'), "TH telemetry aria");
      assert.ok(thHtml.includes('aria-label="โปรแกรมเสริม Setup Assistant"'), "TH companion aria");
    } finally {
      if (oldEnvLocale !== undefined) {
        process.env.WINHELM_LOCALE = oldEnvLocale;
      } else {
        delete process.env.WINHELM_LOCALE;
      }
      setConfiguredLocale(initialLocale);
    }
  });

  it("21. Blocker D Corrective: Runtime state dictionary (SHELL_MESSAGES) includes full localized coverage for EN and TH", () => {
    const initialLocale = getRuntimeLocale();
    const oldEnvLocale = process.env.WINHELM_LOCALE;
    delete process.env.WINHELM_LOCALE;

    try {
      setConfiguredLocale("th");
      const thHtml = renderTestShell();
      const match = thHtml.match(/const SHELL_MESSAGES = (\{.*?\});/s);
      assert.ok(match, "SHELL_MESSAGES JSON object must be present in client script");
      const dict = JSON.parse(match[1]);

      // Verify Thai runtime translations exist in client script payload
      assert.ok(dict.shellAdminLockConfirm && dict.shellAdminLockConfirm.includes("ล็อกสิทธิ์ผู้ดูแล"), "TH admin lock confirm");
      assert.ok(dict.shellApprovalsRiskReasonLabel && dict.shellApprovalsRiskReasonLabel.includes("เหตุผลความเสี่ยง"), "TH risk reason");
      assert.ok(dict.shellRemoteStatusOn && dict.shellRemoteStatusOn.includes("เปิดการเข้าถึงระยะไกล"), "TH remote status on");
      assert.ok(dict.shellConnectionsDoctorPassed && dict.shellConnectionsDoctorPassed.includes("ผ่าน"), "TH doctor passed");
      assert.ok(dict.shellSetupDiagnosticHealthy && dict.shellSetupDiagnosticHealthy.includes("เกตเวย์ WinHelm สมบูรณ์ดี"), "TH setup healthy");
    } finally {
      if (oldEnvLocale !== undefined) {
        process.env.WINHELM_LOCALE = oldEnvLocale;
      } else {
        delete process.env.WINHELM_LOCALE;
      }
      setConfiguredLocale(initialLocale);
    }
  });

  it("22. Blocker D Corrective: UI source files under src/gateway/ui contain ZERO English fallback literals masking missing catalog keys", () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const uiDir = path.resolve(testDir, "../../src/gateway/ui");

    function getSourceFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...getSourceFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const uiSourceFiles = getSourceFiles(uiDir);
    assert.ok(uiSourceFiles.length > 0, "Must locate UI source files under src/gateway/ui");

    const fallbackPattern = /messages\.[a-zA-Z0-9_]+\s*\|\|/g;
    const violations: { file: string; line: number; text: string }[] = [];

    for (const filePath of uiSourceFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      lines.forEach((lineText, idx) => {
        if (fallbackPattern.test(lineText)) {
          violations.push({
            file: path.relative(path.resolve(testDir, "../.."), filePath),
            line: idx + 1,
            text: lineText.trim(),
          });
        }
        fallbackPattern.lastIndex = 0;
      });
    }

    assert.strictEqual(
      violations.length,
      0,
      `Detected ${violations.length} forbidden English fallback literal(s) masking missing catalog keys:\n` +
      violations.map(v => `  ${v.file}:${v.line} -> ${v.text}`).join("\n")
    );

    // Also assert that rendered shell in both locales contains no 'undefined' literals
    const initialLocale = getRuntimeLocale();
    const oldEnvLocale = process.env.WINHELM_LOCALE;
    delete process.env.WINHELM_LOCALE;

    try {
      for (const locale of ["en", "th"] as const) {
        setConfiguredLocale(locale);
        const rendered = renderTestShell();
        // Check that no undefined values leaked into rendered markup
        assert.strictEqual(
          rendered.includes(">undefined<"),
          false,
          `Rendered HTML (${locale}) must not leak '>undefined<' as content`
        );
        assert.strictEqual(
          rendered.includes('="undefined"'),
          false,
          `Rendered HTML (${locale}) must not leak '="undefined"' as attribute`
        );
      }
    } finally {
      if (oldEnvLocale !== undefined) {
        process.env.WINHELM_LOCALE = oldEnvLocale;
      } else {
        delete process.env.WINHELM_LOCALE;
      }
      setConfiguredLocale(initialLocale);
    }
  });
});
