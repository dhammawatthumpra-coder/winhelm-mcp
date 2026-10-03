import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { registerAllTools } from "../../src/tools/index.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";

async function withConfig(
  value: Record<string, unknown>,
  fn: (manager: ConfigManager) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-recovery-tools-"));
  const configFile = path.join(dir, "config.json");
  await fs.writeFile(configFile, JSON.stringify(value, null, 2), "utf-8");
  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    resetApprovalEngine();
    await fn(manager);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    ConfigManager.resetInstance();
    resetApprovalEngine();
  }
}

const validV2 = {
  schemaVersion: 2,
  profilePreset: "balanced",
  folders: [],
  terminal: { mode: "ask" },
  toolPolicy: { system_info: "auto" },
};

describe("Schema-v2 recovery tools", () => {
  it("exposes winhelm_status and winhelm_job_status in schema-v2", async () => {
    await withConfig(validV2, async () => {
      const server = new McpServer({ name: "recovery-v2", version: "1.0.0" });
      registerAllTools(server);
      const tools = (server as any)._registeredTools;

      assert.strictEqual(Object.keys(tools).length, 40);
      assert.ok(tools.winhelm_status);
      assert.ok(tools.winhelm_job_status);

      const status = await tools.winhelm_status.handler({}, {});
      assert.notStrictEqual(status.isError, true);
      const payload = JSON.parse(status.content[0].text);
      assert.strictEqual(payload.schemaMode, "v2");
      assert.strictEqual(payload.config.valid, true);
      assert.strictEqual(payload.approval.pendingJobs, 0);
    });
  });

  it("keeps recovery status usable when config is invalid", async () => {
    await withConfig(
      {
        schemaVersion: 3,
        allowedDirectories: ["*"],
        profile: "full",
      },
      async () => {
        const server = new McpServer({ name: "recovery-invalid", version: "1.0.0" });
        registerAllTools(server);
        const tools = (server as any)._registeredTools;

        assert.strictEqual(Object.keys(tools).length, 40);

        const status = await tools.winhelm_status.handler({}, {});
        assert.notStrictEqual(status.isError, true);
        const payload = JSON.parse(status.content[0].text);
        assert.strictEqual(payload.schemaMode, "invalid");
        assert.strictEqual(payload.config.valid, false);
        assert.ok(payload.config.validationErrors.length > 0);

        const ordinary = await tools.system_info.handler({}, {});
        assert.strictEqual(ordinary.isError, true);
        const ordinaryPayload = JSON.parse(ordinary.content[0].text);
        assert.strictEqual(
          ordinaryPayload.error.code,
          "CONFIGURATION_UNAVAILABLE"
        );
      }
    );
  });

  it("binds winhelm_job_status to the creating MCP session", async () => {
    await withConfig(validV2, async () => {
      const engine = getApprovalEngine();
      const created = engine.request({
        tool: "http_request",
        args: {
          url: "https://example.com",
          idempotencyKey: "fixture-key",
        },
        sessionId: "session-a",
        requestId: 1,
        ttlMs: 30_000,
        maxPending: 5,
        execute: async () => ({
          content: [{ type: "text", text: "done" }],
        }),
      });

      const server = new McpServer({ name: "recovery-job", version: "1.0.0" });
      registerAllTools(server);
      const tools = (server as any)._registeredTools;

      const byId = await tools.winhelm_job_status.handler(
        { jobId: created.job.id },
        { sessionId: "session-a" }
      );
      assert.notStrictEqual(byId.isError, true);
      const byIdPayload = JSON.parse(byId.content[0].text);
      assert.strictEqual(byIdPayload.status, "awaiting_approval");
      assert.strictEqual(byIdPayload.jobId, created.job.id);

      const byKey = await tools.winhelm_job_status.handler(
        { idempotencyKey: "fixture-key" },
        { sessionId: "session-a" }
      );
      assert.notStrictEqual(byKey.isError, true);
      const byKeyPayload = JSON.parse(byKey.content[0].text);
      assert.strictEqual(byKeyPayload.jobId, created.job.id);

      const crossSession = await tools.winhelm_job_status.handler(
        { jobId: created.job.id },
        { sessionId: "session-b" }
      );
      assert.strictEqual(crossSession.isError, true);
      const crossPayload = JSON.parse(crossSession.content[0].text);
      assert.strictEqual(crossPayload.error.code, "NOT_FOUND");
    });
  });

  it("rejects job status calls without jobId or idempotencyKey", async () => {
    await withConfig(validV2, async () => {
      const server = new McpServer({ name: "recovery-args", version: "1.0.0" });
      registerAllTools(server);
      const tools = (server as any)._registeredTools;

      const result = await tools.winhelm_job_status.handler(
        {},
        { sessionId: "session-a" }
      );
      assert.strictEqual(result.isError, true);
      const payload = JSON.parse(result.content[0].text);
      assert.strictEqual(payload.error.code, "INVALID_ARGUMENT");
    });
  });
});
