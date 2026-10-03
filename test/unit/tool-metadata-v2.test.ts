import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_V13_TOOL_NAMES,
  RECOVERY_TOOL_NAMES,
} from "../../src/tools/registry.js";
import {
  TOOL_METADATA,
  getToolMetadata,
  validateToolMetadataRegistry,
} from "../../src/tools/metadata.js";
import { registerTracedTool } from "../../src/tools/tool-wrapper.js";
import { ConfigManager } from "../../src/config/config-manager.js";

describe("MCP tool metadata and annotations", () => {
  it("passes metadata through registerTracedTool into the MCP SDK registration config", () => {
    ConfigManager.resetInstance();
    let captured: any = null;
    const server = {
      registerTool(name: string, config: any, handler: any) {
        captured = { name, config, handler };
      },
    };

    try {
      registerTracedTool(
        server as any,
        "file_read",
        {},
        async () => ({ content: [{ type: "text", text: "ok" }] })
      );

      assert.ok(captured);
      assert.strictEqual(captured.name, "file_read");
      assert.strictEqual(
        captured.config.description,
        getToolMetadata("file_read").description
      );
      assert.deepStrictEqual(
        captured.config.annotations,
        getToolMetadata("file_read").annotations
      );
      assert.strictEqual(
        captured.config.title,
        getToolMetadata("file_read").title
      );
    } finally {
      ConfigManager.resetInstance();
    }
  });


  it("covers the exact 41-tool v1.3 surface with no drift", () => {
    assert.strictEqual(ALL_V13_TOOL_NAMES.length, 41);
    assert.strictEqual(Object.keys(TOOL_METADATA).length, 41);
    assert.deepStrictEqual(
      Object.keys(TOOL_METADATA).sort(),
      [...ALL_V13_TOOL_NAMES].sort()
    );
    assert.deepStrictEqual(validateToolMetadataRegistry(), []);
  });

  it("provides non-empty title, description, and explicit annotation booleans for every tool", () => {
    for (const name of ALL_V13_TOOL_NAMES) {
      const metadata = getToolMetadata(name);
      assert.ok(metadata.title.trim(), name + " title");
      assert.ok(metadata.description.trim(), name + " description");

      for (const key of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        assert.strictEqual(
          typeof metadata.annotations[key],
          "boolean",
          name + " " + key
        );
      }

      if (metadata.annotations.readOnlyHint) {
        assert.strictEqual(
          metadata.annotations.destructiveHint,
          false,
          name + " read-only/destructive contradiction"
        );
      }
    }
  });

  it("marks representative filesystem/network/execution tools conservatively", () => {
    assert.deepStrictEqual(getToolMetadata("file_read").annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    assert.deepStrictEqual(getToolMetadata("http_ping").annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });

    assert.deepStrictEqual(getToolMetadata("http_request").annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });

    assert.deepStrictEqual(getToolMetadata("command_run").annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("keeps both recovery tools read-only and closed-world", () => {
    for (const name of RECOVERY_TOOL_NAMES) {
      const annotations = getToolMetadata(name).annotations;
      assert.strictEqual(annotations.readOnlyHint, true);
      assert.strictEqual(annotations.destructiveHint, false);
      assert.strictEqual(annotations.openWorldHint, false);
    }
  });
});
