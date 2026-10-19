/**
 * WinHelm v1.4.1 Cross-Tranche Adapter Wiring Tests
 * 
 * Verifies Phase 2 integration requirements:
 * 1. Dynamic Port status is wired to Dashboard Advanced without fabricated endpoints
 * 2. Native Approval status is wired to Dashboard Approvals truthfully
 * 3. Setup Assistant companion status is wired truthfully and launch remains disabled
 * 4. Factual state flows through createServer -> sendProductShell -> getProductShellHtml
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getDynamicInternalPortsStatus,
  getNativeApprovalStatus,
  getSetupAssistantStatus,
  getCrossTrancheAdapters,
} from "../../src/runtime/operational-adapters.js";
import { getProductShellHtml } from "../../src/gateway/product-shell-html.js";
import { createServer } from "../../src/gateway/server.js";

describe("Phase 2 Runtime Adapter Wiring Suite", () => {
  it("1. Dynamic Internal Ports adapter reflects Auto and Fixed modes truthfully", async () => {
    // 1.1 Automatic mode
    const autoStatus = await getDynamicInternalPortsStatus({
      port: 8788,
      host: "127.0.0.1",
      internalPortSelection: { mode: "auto" },
    });
    assert.strictEqual(autoStatus.mode, "automatic");
    assert.ok(Array.isArray(autoStatus.endpoints));
    assert.ok(autoStatus.endpoints.length >= 1);
    assert.strictEqual(autoStatus.endpoints[0].service, "Core Gateway");
    assert.ok(autoStatus.endpoints[0].url.startsWith("http://127.0.0.1:"));
    // Ensure no hardcoded fake ports are present
    const urls = autoStatus.endpoints.map((e) => e.url);
    assert.ok(!urls.some((u) => u.includes(":18820") || u.includes(":18821") || u.includes(":18822")));

    // 1.2 Fixed mode
    const fixedStatus = await getDynamicInternalPortsStatus({
      port: 9999,
      host: "127.0.0.1",
      internalPortSelection: { mode: "fixed", port: 9999 },
    });
    assert.strictEqual(fixedStatus.mode, "fixed");
    assert.ok(fixedStatus.endpoints.length >= 1);
  });

  it("2. Native Approval adapter probes live state truthfully", async () => {
    const status = await getNativeApprovalStatus(true);
    // On the current clean/unmutated test environment, registry/shortcut are not installed globally
    // Therefore, status must truthfully be 'unavailable' or 'needs_repair', never falsely 'ready'
    assert.ok(
      status === "unavailable" || status === "needs_repair",
      `Expected unavailable or needs_repair on test machine without global install, got ${status}`
    );
  });

  it("3. Setup Assistant adapter reports truthfully and launch remains safely disabled", async () => {
    const status = getSetupAssistantStatus();
    assert.strictEqual(status, "unavailable");

    const adapters = await getCrossTrancheAdapters();
    const html = getProductShellHtml("full", {
      schemaMode: "v2",
      preset: "balanced",
      terminalMode: "ask",
      approvalMode: "smart",
      adapters,
    });

    // Check Setup panel
    const setupPanel = html.slice(
      html.indexOf('id="panel-setup"'),
      html.indexOf('id="panel-access"')
    );
    assert.ok(
      setupPanel.includes("disabled") && setupPanel.includes('aria-disabled="true"'),
      "Launch button must remain disabled"
    );
    assert.strictEqual(
      setupPanel.includes("launchSetupAssistant()"),
      false,
      "Must not invoke undefined launcher function"
    );
  });

  it("4. Integrated Gateway server wires adapters into Product Shell rendering", async () => {
    const { start, stop } = createServer({
      port: 0,
      host: "127.0.0.1",
      internalPortSelection: { mode: "auto" },
    });

    const server = await start();
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;

      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("content-type"), "text/html; charset=utf-8");

      const body = await res.text();
      assert.ok(body.includes('id="panel-overview"'));
      assert.ok(body.includes('id="panel-advanced"'));
      assert.ok(body.includes('id="panel-approvals"'));
      assert.ok(body.includes('id="panel-setup"'));

      // Check Advanced panel displays Automatic Mode
      const advPanel = body.slice(
        body.indexOf('id="panel-advanced"'),
        body.indexOf('</main>')
      );
      assert.ok(advPanel.includes("Automatic Mode") || advPanel.includes("พอร์ตไดนามิก"));
      assert.ok(advPanel.includes(`http://127.0.0.1:${port}`));
    } finally {
      await stop(server);
    }
  });

  it("5. Deep link /approvals/:jobId carries focusJobId and renders shell", async () => {
    const { start, stop } = createServer({
      port: 0,
      host: "127.0.0.1",
      internalPortSelection: { mode: "auto" },
    });

    const server = await start();
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;

      const res = await fetch(`http://127.0.0.1:${port}/approvals/job_test_deep_link`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('INITIAL_FOCUS_JOB_ID = "job_test_deep_link"'));
    } finally {
      await stop(server);
    }
  });
});
