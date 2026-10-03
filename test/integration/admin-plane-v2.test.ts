import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ConfigManager } from "../../src/config/config-manager.js";
import { createServer } from "../../src/gateway/server.js";
import {
  getAdminAuthManager,
  resetAdminAuthManager,
} from "../../src/admin/runtime.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";

function cookiePair(setCookie: string | null): string {
  assert.ok(setCookie, "Expected Set-Cookie header");
  return setCookie.split(";")[0];
}

describe("Isolated admin HTTP plane", () => {
  it("separates admin credentials from MCP auth and governs approval transitions", async () => {
    ConfigManager.resetInstance();
    resetAdminAuthManager();
    resetApprovalEngine();

    const instance = createServer({
      port: 0,
      host: "127.0.0.1",
      authToken: "mcp-secret",
    });
    const server = await instance.start();
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const origin = base;

    try {
      // There is deliberately no HTTP endpoint that mints an admin code.
      const noCodeEndpoint = await fetch(`${base}/admin/code`, {
        headers: { Origin: origin },
      });
      assert.strictEqual(noCodeEndpoint.status, 404);

      // MCP bearer must not grant access to the admin plane.
      const bearerAdmin = await fetch(`${base}/admin/status`, {
        headers: {
          Authorization: "Bearer mcp-secret",
          Origin: origin,
        },
      });
      assert.strictEqual(bearerAdmin.status, 401);
      const bearerAdminBody = await bearerAdmin.json() as any;
      assert.strictEqual(
        bearerAdminBody.error.code,
        "ADMIN_UNAUTHORIZED"
      );

      const issued = getAdminAuthManager().issueCode();
      const exchange = await fetch(`${base}/admin/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ code: issued.code }),
      });
      assert.strictEqual(exchange.status, 200);

      const adminCookieHeader = exchange.headers.get("set-cookie");
      assert.match(adminCookieHeader ?? "", /winhelm_admin_session=/);
      assert.match(adminCookieHeader ?? "", /HttpOnly/i);
      assert.match(adminCookieHeader ?? "", /SameSite=Strict/i);
      assert.match(adminCookieHeader ?? "", /Path=\/admin/i);
      assert.match(adminCookieHeader ?? "", /Max-Age=3600/i);

      const adminCookie = cookiePair(adminCookieHeader);
      const exchangeBody = await exchange.json() as any;
      assert.ok(exchangeBody.csrfToken);
      assert.strictEqual(exchangeBody.idleExpiresInSeconds, 3600);

      // Single-use admin code must reject replay.
      const replay = await fetch(`${base}/admin/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ code: issued.code }),
      });
      assert.strictEqual(replay.status, 401);

      const status = await fetch(`${base}/admin/status`, {
        headers: {
          Cookie: adminCookie,
        },
      });
      assert.strictEqual(status.status, 200);
      const statusBody = await status.json() as any;
      assert.strictEqual(statusBody.authenticated, true);

      // Admin cookie must not be accepted by the MCP/dashboard auth plane.
      const adminAsMcp = await fetch(`${base}/api/monitor/stats`, {
        headers: { Cookie: adminCookie },
      });
      assert.strictEqual(adminAsMcp.status, 401);

      let executions = 0;
      const approval = getApprovalEngine().request({
        tool: "fixture_action",
        args: { value: 1 },
        sessionId: "fixture-session",
        requestId: 1,
        ttlMs: 30_000,
        maxPending: 5,
        execute: async () => {
          executions += 1;
          return { content: [{ type: "text", text: "executed" }] };
        },
      });
      assert.strictEqual(approval.kind, "created");

      const approvals = await fetch(`${base}/admin/approvals`, {
        headers: { Cookie: adminCookie },
      });
      assert.strictEqual(approvals.status, 200);
      const approvalsBody = await approvals.json() as any;
      assert.ok(
        approvalsBody.jobs.some(
          (job: any) => job.id === approval.job.id
        )
      );

      // CSRF is mandatory for mutations.
      const missingCsrf = await fetch(
        `${base}/admin/approvals/${approval.job.id}/approve`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: origin,
          },
        }
      );
      assert.strictEqual(missingCsrf.status, 403);
      assert.strictEqual(executions, 0);

      const wrongOrigin = await fetch(
        `${base}/admin/approvals/${approval.job.id}/approve`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: "http://localhost:65500",
            "x-winhelm-csrf": exchangeBody.csrfToken,
          },
        }
      );
      assert.strictEqual(wrongOrigin.status, 403);
      assert.strictEqual(executions, 0);

      const approve = await fetch(
        `${base}/admin/approvals/${approval.job.id}/approve`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: origin,
            "x-winhelm-csrf": exchangeBody.csrfToken,
          },
        }
      );
      assert.strictEqual(approve.status, 200);

      const terminal = await getApprovalEngine().waitForTerminalOrReceipt(
        approval.job.id,
        1_000
      );
      assert.strictEqual(terminal.kind, "terminal");
      assert.strictEqual(terminal.job.state, "completed");
      assert.strictEqual(executions, 1);

      const lateApprove = await fetch(
        `${base}/admin/approvals/${approval.job.id}/approve`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: origin,
            "x-winhelm-csrf": exchangeBody.csrfToken,
          },
        }
      );
      assert.strictEqual(lateApprove.status, 409);
      assert.strictEqual(executions, 1);

      let deniedExecutions = 0;
      const deniedJob = getApprovalEngine().request({
        tool: "fixture_denied",
        args: { value: 2 },
        sessionId: "fixture-session",
        requestId: 2,
        ttlMs: 30_000,
        maxPending: 5,
        execute: async () => {
          deniedExecutions += 1;
          return "should-not-run";
        },
      });

      const deny = await fetch(
        `${base}/admin/approvals/${deniedJob.job.id}/deny`,
        {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: origin,
            "x-winhelm-csrf": exchangeBody.csrfToken,
          },
        }
      );
      assert.strictEqual(deny.status, 200);
      assert.strictEqual(
        getApprovalEngine().get(deniedJob.job.id)?.state,
        "denied"
      );
      assert.strictEqual(deniedExecutions, 0);

      const logout = await fetch(`${base}/admin/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          Origin: origin,
          "x-winhelm-csrf": exchangeBody.csrfToken,
        },
      });
      assert.strictEqual(logout.status, 200);
      assert.match(
        logout.headers.get("set-cookie") ?? "",
        /Max-Age=0/i
      );

      const afterLogout = await fetch(`${base}/admin/status`, {
        headers: { Cookie: adminCookie },
      });
      assert.strictEqual(afterLogout.status, 401);
    } finally {
      await instance.stop(server);
      ConfigManager.resetInstance();
      resetAdminAuthManager();
      resetApprovalEngine();
    }
  });
});
