import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  createToolErrorResult,
  extractPrefixedErrorCode,
  normalizeSchemaV2ToolErrorResult,
  parseToolErrorPayload,
} from "../../src/errors/tool-error.js";
import { registerTracedTool } from "../../src/tools/tool-wrapper.js";
import { registerNetworkTools } from "../../src/tools/network-tools.js";
import { translate as t } from "../../src/i18n/messages.js";

async function withTempConfig(
  value: Record<string, unknown>,
  fn: () => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tool-errors-"));
  const configFile = path.join(dir, "config.json");
  await fs.writeFile(configFile, JSON.stringify(value, null, 2), "utf8");

  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    await fn();
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function mockServer(): {
  server: any;
  handlers: Map<string, (args: any, extra: any) => Promise<any>>;
} {
  const handlers = new Map<string, (args: any, extra: any) => Promise<any>>();
  return {
    handlers,
    server: {
      registerTool(name: string, _config: any, handler: any) {
        handlers.set(name, handler);
      },
    },
  };
}

describe("Schema-v2 structured tool errors", () => {
  it("preserves an existing structured error payload verbatim", () => {
    const result = createToolErrorResult(
      "EXISTING_CODE",
      "Existing message.",
      "Existing action."
    );

    assert.strictEqual(
      normalizeSchemaV2ToolErrorResult(
        result,
        "FALLBACK",
        "Fallback action."
      ),
      result
    );
    assert.deepStrictEqual(parseToolErrorPayload(result), {
      code: "EXISTING_CODE",
      message: "Existing message.",
      userAction: "Existing action.",
    });
  });

  it("extracts stable prefixed policy codes", () => {
    assert.deepStrictEqual(
      extractPrefixedErrorCode(
        "NETWORK_LOOPBACK_BLOCKED: Loopback is disabled."
      ),
      {
        code: "NETWORK_LOOPBACK_BLOCKED",
        message: "Loopback is disabled.",
      }
    );
    assert.strictEqual(
      extractPrefixedErrorCode("ordinary failure text"),
      undefined
    );
  });

  it("normalizes raw schema-v2 tool failures but leaves legacy behavior unchanged", async () => {
    const v2Config = {
      schemaVersion: 2,
      profilePreset: "balanced",
      folders: [{ path: process.cwd(), permission: "readwrite" }],
      terminal: { mode: "off" },
      toolPolicy: { system_info: "auto" },
    };

    await withTempConfig(v2Config, async () => {
      const { server, handlers } = mockServer();
      registerTracedTool(
        server,
        "system_info",
        {},
        async () => ({
          isError: true,
          content: [{ type: "text", text: "fixture raw failure" }],
        })
      );

      const result = await handlers.get("system_info")!({}, {});
      assert.deepStrictEqual(parseToolErrorPayload(result), {
        code: "TOOL_EXECUTION_FAILED",
        message: "fixture raw failure",
        userAction: t("action.error.review"),
      });
    });

    await withTempConfig(
      {
        profile: "full",
        allowedDirectories: ["*"],
        allowSystemExecution: true,
      },
      async () => {
        const { server, handlers } = mockServer();
        registerTracedTool(
          server,
          "system_info",
          {},
          async () => ({
            isError: true,
            content: [{ type: "text", text: "fixture raw failure" }],
          })
        );

        const result = await handlers.get("system_info")!({}, {});
        assert.strictEqual(result.isError, true);
        assert.strictEqual(
          result.content[0].text,
          "fixture raw failure"
        );
        assert.strictEqual(parseToolErrorPayload(result), undefined);
      }
    );
  });

  it("preserves NETWORK_* rejection codes from the guarded v2 HTTP path", async () => {
    await withTempConfig(
      {
        schemaVersion: 2,
        profilePreset: "balanced",
        folders: [{ path: process.cwd(), permission: "readwrite" }],
        terminal: { mode: "off" },
        toolPolicy: {
          http_ping: "auto",
          http_request: "auto",
          network_info: "auto",
        },
        network: { allowLoopback: false },
      },
      async () => {
        const { server, handlers } = mockServer();
        registerNetworkTools(server);

        const result = await handlers.get("http_ping")!(
          { url: "http://127.0.0.1:43210" },
          {}
        );
        const error = parseToolErrorPayload(result);
        assert.ok(error);
        assert.strictEqual(error.code, "NETWORK_LOOPBACK_BLOCKED");
        assert.strictEqual(error.userAction, t("action.network.target"));
      }
    );
  });
});
