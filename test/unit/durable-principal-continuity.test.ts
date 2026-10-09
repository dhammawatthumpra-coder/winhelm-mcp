import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import {
  getRunManager,
  resetRunManager,
  setRunJournalPathForTesting,
} from "../../src/engine/run-manager.js";
import {
  getProvenanceTracker,
  resetProvenanceTracker,
} from "../../src/approval/provenance.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";
import { registerCommandTools } from "../../src/tools/command-tools.js";
import { registerTierBTools } from "../../src/tools/tier-b-tools.js";
import { registerGovernedTools } from "../../src/tools/governed-tools.js";
import { parseToolErrorPayload } from "../../src/errors/tool-error.js";
import {
  computePrincipalSignature,
  createTrustedPrincipalHeaders,
  extractTrustedPrincipal,
  HEADER_DURABLE_PRINCIPAL,
  HEADER_DURABLE_PRINCIPAL_SIG,
} from "../../src/gateway/durable-principal.js";
import { StreamableGateway } from "../../src/gateway/streamable-gateway.js";
import { SseGateway } from "../../src/gateway/sse-gateway.js";

type Handler = (args: any, extra: any) => Promise<any>;

function mockMcpServer(): {
  server: any;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    server: {
      registerTool(name: string, _config: any, handler: Handler) {
        handlers.set(name, handler);
      },
      registerResource() {},
    },
  };
}

const NODE = process.execPath;
let fixtureRoot: string | null = null;

async function setupFixture(): Promise<string> {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-d1-test-"));
  setRunJournalPathForTesting(path.join(fixtureRoot, "run-journal.jsonl"));
  resetRunManager();
  resetProvenanceTracker();
  resetApprovalEngine();

  const config = buildPresetConfig("power", {
    folders: [fixtureRoot],
    approvalMode: "trusted",
  });
  config.terminal.mode = "full";
  config.toolPolicy = {
    command_run: "auto",
    command_wait: "auto",
    process_resource_monitor: "auto",
    session_current: "auto",
    session_audit_search: "auto",
  };

  const manager = ConfigManager.resetInstance();
  await manager.updateConfig(config as any, false);
  return fixtureRoot;
}

afterEach(async () => {
  getRunManager().shutdownAll();
  resetRunManager();
  setRunJournalPathForTesting(undefined);
  resetProvenanceTracker();
  resetApprovalEngine();
  ConfigManager.resetInstance();
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    fixtureRoot = null;
  }
});

describe("D1 Defect Reproduction & Continuity Corrective Verification", () => {
  it("reproduces baseline defect: when no durable principal is present, reconnecting under new lease denies command_wait and monitor", async () => {
    await setupFixture();
    const { server, handlers } = mockMcpServer();
    registerCommandTools(server);
    registerTierBTools(server);
    registerGovernedTools(server);

    const commandRun = handlers.get("command_run")!;
    const commandWait = handlers.get("command_wait")!;
    const resourceMonitor = handlers.get("process_resource_monitor")!;
    const sessionCurrent = handlers.get("session_current")!;
    const sessionAuditSearch = handlers.get("session_audit_search")!;

    // 1. Session A launches async command without durable principal
    const sessionAExtra = { sessionId: "mcp-session-lease-A" };
    const runResult = await commandRun(
      {
        command: NODE,
        args: ["-e", "setTimeout(() => process.stdout.write('done'), 800)"],
        async: true,
      },
      sessionAExtra
    );

    assert.strictEqual(runResult.isError, undefined);
    const parsedRun = JSON.parse(runResult.content[0].text);
    assert.strictEqual(parsedRun.status, "running");
    const runId = parsedRun.run_id;

    // session_current reports no durable principal
    const currA = await sessionCurrent({}, sessionAExtra);
    const parsedCurrA = JSON.parse(currA.content[0].text);
    assert.strictEqual(parsedCurrA.session_id, "mcp-session-lease-A");
    assert.strictEqual(parsedCurrA.durable_principal_id, null);

    // 2. Reconnect: Same logical connector reconnects as session B lease (still untrusted/no principal)
    const sessionBExtra = { sessionId: "mcp-session-lease-B" };

    // 3. Baseline command_wait from session B fails with RUN_PERMISSION_DENIED
    const waitResult = await commandWait({ run_id: runId }, sessionBExtra);
    assert.strictEqual(waitResult.isError, true);
    const waitErr = parseToolErrorPayload(waitResult);
    assert.strictEqual(waitErr?.code, "RUN_PERMISSION_DENIED");

    // 4. Baseline process_resource_monitor from session B also fails with RUN_PERMISSION_DENIED
    const monitorResult = await resourceMonitor({ run_id: runId }, sessionBExtra);
    assert.strictEqual(monitorResult.isError, true);
    const monitorErr = parseToolErrorPayload(monitorResult);
    assert.strictEqual(monitorErr?.code, "RUN_PERMISSION_DENIED");

    // 5. session_audit_search under session B cannot see session A
    const auditB = await sessionAuditSearch({}, sessionBExtra);
    const parsedAuditB = JSON.parse(auditB.content[0].text);
    assert.strictEqual(parsedAuditB.session_id, "mcp-session-lease-B");
    assert.strictEqual(
      parsedAuditB.events.some((e: any) => e.tool === "command_run"),
      false
    );
  });

  it("corrective: same durable principal across different transport leases can command_wait and monitor own run", async () => {
    await setupFixture();
    const { server, handlers } = mockMcpServer();
    registerCommandTools(server);
    registerTierBTools(server);
    registerGovernedTools(server);

    const commandRun = handlers.get("command_run")!;
    const commandWait = handlers.get("command_wait")!;
    const resourceMonitor = handlers.get("process_resource_monitor")!;
    const sessionCurrent = handlers.get("session_current")!;

    const durablePrincipal = "alias.primary.connector-01";

    // 1. Session A with durable principal launches async command
    const sessionAExtra = {
      sessionId: "mcp-lease-A",
      principalId: durablePrincipal,
    };
    const runResult = await commandRun(
      {
        command: NODE,
        args: ["-e", "process.stdout.write('continuity-ok')"],
        async: true,
      },
      sessionAExtra
    );
    assert.strictEqual(runResult.isError, undefined);
    const parsedRun = JSON.parse(runResult.content[0].text);
    const runId = parsedRun.run_id;

    // Verify session_current reports durable principal
    const currA = await sessionCurrent({}, sessionAExtra);
    const parsedCurrA = JSON.parse(currA.content[0].text);
    assert.strictEqual(parsedCurrA.session_id, "mcp-lease-A");
    assert.strictEqual(parsedCurrA.transport_session_id, "mcp-lease-A");
    assert.strictEqual(parsedCurrA.durable_principal_id, durablePrincipal);

    // 2. Reconnect: Same principal arrives under new session lease B
    const sessionBExtra = {
      sessionId: "mcp-lease-B",
      principalId: durablePrincipal,
    };

    // Verify session_current shows new lease but same durable principal
    const currB = await sessionCurrent({}, sessionBExtra);
    const parsedCurrB = JSON.parse(currB.content[0].text);
    assert.strictEqual(parsedCurrB.session_id, "mcp-lease-B");
    assert.strictEqual(parsedCurrB.transport_session_id, "mcp-lease-B");
    assert.strictEqual(parsedCurrB.durable_principal_id, durablePrincipal);

    // 3. process_resource_monitor from session B succeeds!
    const monitorResult = await resourceMonitor({ run_id: runId }, sessionBExtra);
    assert.strictEqual(monitorResult.isError, undefined);
    const parsedMonitor = JSON.parse(monitorResult.content[0].text);
    assert.strictEqual(parsedMonitor.run_id, runId);

    // 4. command_wait from session B succeeds and retrieves stdout!
    const waitResult = await commandWait({ run_id: runId, timeout_ms: 5000 }, sessionBExtra);
    assert.strictEqual(waitResult.isError, undefined);
    const parsedWait = JSON.parse(waitResult.content[0].text);
    assert.strictEqual(parsedWait.run_id, runId);
    assert.strictEqual(parsedWait.status, "exited");
    assert.strictEqual(parsedWait.exit_code, 0);
    assert.ok(parsedWait.stdout.includes("continuity-ok"));
  });

  it("isolation: different principal cannot wait or monitor, even under any session lease", async () => {
    await setupFixture();
    const { server, handlers } = mockMcpServer();
    registerCommandTools(server);
    registerTierBTools(server);

    const commandRun = handlers.get("command_run")!;
    const commandWait = handlers.get("command_wait")!;
    const resourceMonitor = handlers.get("process_resource_monitor")!;

    // Principal A launches run
    const sessionAExtra = {
      sessionId: "lease-A",
      principalId: "principal-alice",
    };
    const runResult = await commandRun(
      {
        command: NODE,
        args: ["-e", "process.stdout.write('alice-secret')"],
        async: true,
      },
      sessionAExtra
    );
    const runId = JSON.parse(runResult.content[0].text).run_id;

    // Principal B tries to wait on run
    const sessionBExtra = {
      sessionId: "lease-B",
      principalId: "principal-bob",
    };
    const waitResult = await commandWait({ run_id: runId }, sessionBExtra);
    assert.strictEqual(waitResult.isError, true);
    assert.strictEqual(parseToolErrorPayload(waitResult)?.code, "RUN_PERMISSION_DENIED");

    // Principal B tries to monitor run
    const monitorResult = await resourceMonitor({ run_id: runId }, sessionBExtra);
    assert.strictEqual(monitorResult.isError, true);
    assert.strictEqual(parseToolErrorPayload(monitorResult)?.code, "RUN_PERMISSION_DENIED");

    // Unauthenticated/untrusted session (no principal) also denied
    const unauthExtra = {
      sessionId: "lease-unauth",
    };
    const unauthWait = await commandWait({ run_id: runId }, unauthExtra);
    assert.strictEqual(unauthWait.isError, true);
    assert.strictEqual(parseToolErrorPayload(unauthWait)?.code, "RUN_PERMISSION_DENIED");
  });

  it("persistence: run journal retains durable principal_id and restores ownership across reconciliation", async () => {
    const root = await setupFixture();
    const journalPath = path.join(root, "run-journal.jsonl");
    const { server, handlers } = mockMcpServer();
    registerCommandTools(server);

    const commandRun = handlers.get("command_run")!;
    const commandWait = handlers.get("command_wait")!;

    // Principal A launches command
    const extraA = {
      sessionId: "lease-A",
      principalId: "principal-durable-999",
    };
    const runResult = await commandRun(
      {
        command: NODE,
        args: ["-e", "process.stdout.write('persisted-durable')"],
        async: true,
      },
      extraA
    );
    const runId = JSON.parse(runResult.content[0].text).run_id;

    // Allow process to complete and finalize
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify journal file exists and contains principal_id
    const journalContent = await fs.readFile(journalPath, "utf8");
    assert.ok(
      journalContent.includes('"principal_id":"principal-durable-999"'),
      "Journal line must contain principal_id"
    );

    // Simulate server restart: reset in-memory RunManager and re-read journal
    resetRunManager();
    await (await import("../../src/engine/run-manager.js")).initializeRunManager();
    const newRunManager = getRunManager();
    const record = newRunManager.getFinished(runId);
    assert.ok(record, "Reconciled run record must exist in restarted RunManager");
    assert.strictEqual(record?.principal_id, "principal-durable-999");

    // Fresh session under restarted server: same principal can access
    const restartedExtraSamePrincipal = {
      sessionId: "lease-restarted-new",
      principalId: "principal-durable-999",
    };
    const waitResult = await commandWait({ run_id: runId }, restartedExtraSamePrincipal);
    assert.strictEqual(waitResult.isError, undefined);
    const parsedWait = JSON.parse(waitResult.content[0].text);
    assert.strictEqual(parsedWait.status, "exited");
    assert.ok(parsedWait.run_id === runId);

    // Different principal denied under restarted server
    const restartedExtraDifferentPrincipal = {
      sessionId: "lease-restarted-new",
      principalId: "principal-attacker",
    };
    const deniedWait = await commandWait({ run_id: runId }, restartedExtraDifferentPrincipal);
    assert.strictEqual(deniedWait.isError, true);
    assert.strictEqual(parseToolErrorPayload(deniedWait)?.code, "RUN_PERMISSION_DENIED");
  });

  describe("Cryptographic HMAC-SHA256 Boundary & Validation Rules", () => {
    const authToken = "wh_core_secret_auth_token_xyz_1234567890";
    const validPrincipal = "alias.primary.agent-alpha";

    it("verifies authentic HMAC-SHA256 signature successfully", () => {
      const headers = createTrustedPrincipalHeaders(validPrincipal, authToken);
      const res = extractTrustedPrincipal(headers, authToken);
      assert.strictEqual(res.ok, true);
      if (res.ok) {
        assert.strictEqual(res.principalId, validPrincipal);
      }
    });

    it("rejects forged or modified signature with INVALID_SIGNATURE", () => {
      const headers = createTrustedPrincipalHeaders(validPrincipal, authToken);
      headers[HEADER_DURABLE_PRINCIPAL_SIG] = "0123456789abcdef".repeat(4);
      const res = extractTrustedPrincipal(headers, authToken);
      assert.strictEqual(res.ok, false);
      if (!res.ok) {
        assert.strictEqual(res.reason, "INVALID_SIGNATURE");
      }
    });

    it("rejects missing signature with MISSING_SIGNATURE", () => {
      const headers = { [HEADER_DURABLE_PRINCIPAL]: validPrincipal };
      const res = extractTrustedPrincipal(headers, authToken);
      assert.strictEqual(res.ok, false);
      if (!res.ok) {
        assert.strictEqual(res.reason, "MISSING_SIGNATURE");
      }
    });

    it("strictly rejects plaintext token as principal with PLAINTEXT_TOKEN_FORBIDDEN", () => {
      // 47 chars token whc_ + 43 base64 chars
      const rawSecretToken = "whc_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
      const headers = createTrustedPrincipalHeaders(rawSecretToken, authToken);
      const res = extractTrustedPrincipal(headers, authToken);
      assert.strictEqual(res.ok, false);
      if (!res.ok) {
        assert.strictEqual(res.reason, "PLAINTEXT_TOKEN_FORBIDDEN");
      }
    });

    it("rejects malformed principal formats with MALFORMED_PRINCIPAL", () => {
      const badPrincipal = "spaces are not allowed in principal";
      const headers = createTrustedPrincipalHeaders(badPrincipal, authToken);
      const res = extractTrustedPrincipal(headers, authToken);
      assert.strictEqual(res.ok, false);
      if (!res.ok) {
        assert.strictEqual(res.reason, "MALFORMED_PRINCIPAL");
      }
    });

    it("fails closed when Core auth token is not configured (NO_AUTH_TOKEN)", () => {
      const headers = createTrustedPrincipalHeaders(validPrincipal, authToken);
      const res = extractTrustedPrincipal(headers, undefined);
      assert.strictEqual(res.ok, false);
      if (!res.ok) {
        assert.strictEqual(res.reason, "NO_AUTH_TOKEN");
      }
    });
  });

  describe("Gateway Transport Lease Enforcement", () => {
    const authToken = "core-test-token-777";

    function mockHttp(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
      let statusCode = 200;
      let body: any = null;
      const res: any = {
        headersSent: false,
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
        send(data: any) {
          body = data;
          return this;
        },
        setHeader() {},
      };
      const req: any = {
        headers,
        query,
        ip: "127.0.0.1",
        on() {},
      };
      return { req, res, getStatus: () => statusCode, getBody: () => body };
    }

    it("StreamableGateway rejects spoofed principal header on session initialization with 403", async () => {
      const gateway = new StreamableGateway(60000, 10, () => authToken);
      const { req, res, getStatus, getBody } = mockHttp({
        [HEADER_DURABLE_PRINCIPAL]: "spoofed-alias",
        [HEADER_DURABLE_PRINCIPAL_SIG]: "badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad1",
      });

      await gateway.handleRequest(req, res);
      assert.strictEqual(getStatus(), 403);
      assert.ok(getBody()?.error?.message?.includes("Principal rejected"));
      await gateway.closeAll();
    });

    it("StreamableGateway rejects active session lease principal mismatch with 403", async () => {
      const gateway = new StreamableGateway(60000, 10, () => authToken);
      const sessionId = "active-test-session-1";

      // Register session with principal alice
      gateway.registerSessionForTest(sessionId, {
        runtimeContext: {
          sessionId,
          durablePrincipalId: "principal-alice",
        },
      });

      // Request attempts to access session with principal bob
      const bobHeaders = createTrustedPrincipalHeaders("principal-bob", authToken);
      bobHeaders["mcp-session-id"] = sessionId;
      const { req, res, getStatus, getBody } = mockHttp(bobHeaders);

      await gateway.handleRequest(req, res);
      assert.strictEqual(getStatus(), 403);
      assert.strictEqual(getBody()?.error?.message, "Principal mismatch for active session lease");
      await gateway.closeAll();
    });

    it("SseGateway rejects spoofed principal header on SSE connect with 403", async () => {
      const gateway = new SseGateway(60000, 10, () => authToken);
      const plaintextToken = "whc_" + "a".repeat(43);
      const { req, res, getStatus, getBody } = mockHttp({
        [HEADER_DURABLE_PRINCIPAL]: plaintextToken,
        [HEADER_DURABLE_PRINCIPAL_SIG]: "abcdef1234567890".repeat(4),
      });

      await gateway.handleSseConnect(req, res);
      assert.strictEqual(getStatus(), 403);
      assert.ok(getBody()?.error?.message?.includes("PLAINTEXT_TOKEN_FORBIDDEN"));
      await gateway.closeAll();
    });

    it("SseGateway rejects active session lease principal mismatch on POST /message with 403", async () => {
      const gateway = new SseGateway(60000, 10, () => authToken);
      const sessionId = "active-sse-session-2";

      // Register session with principal alice
      gateway.registerSessionForTest(sessionId, {
        runtimeContext: {
          sessionId,
          durablePrincipalId: "principal-alice",
        },
      });

      // Request to /message?sessionId=... presents bob headers
      const bobHeaders = createTrustedPrincipalHeaders("principal-bob", authToken);
      const { req, res, getStatus, getBody } = mockHttp(bobHeaders, { sessionId });

      await gateway.handlePostMessage(req, res);
      assert.strictEqual(getStatus(), 403);
      assert.strictEqual(getBody()?.error?.message, "Principal mismatch for active session lease");
      await gateway.closeAll();
    });
  });
});
