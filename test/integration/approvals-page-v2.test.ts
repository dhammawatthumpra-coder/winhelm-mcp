import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/gateway/server.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";

// Ground rules: do NOT bind to 8788; 18791/18792/18811 are used elsewhere.
const TEST_PORT = 18812;

describe("Approval deep link page", () => {
  it("serves the dashboard with the strict CSP at /approvals/:jobId", async () => {
    resetApprovalEngine();
    const instance = createServer({
      port: TEST_PORT,
      host: "127.0.0.1",
    });
    const server = await instance.start();
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/approvals/job_fixture`
      );
      assert.strictEqual(response.status, 200);
      const csp = response.headers.get("content-security-policy");
      assert.ok(csp, "the approval page must carry the dashboard CSP");
      assert.ok(csp.includes("default-src 'none'"));
      assert.ok(csp.includes("connect-src 'self'"));

      const html = await response.text();
      assert.ok(html.includes('id="approvalJobs"'));
      assert.ok(html.includes("Approval Jobs"));
    } finally {
      await instance.stop(server);
      ConfigManager.resetInstance();
      resetApprovalEngine();
    }
  });
});
