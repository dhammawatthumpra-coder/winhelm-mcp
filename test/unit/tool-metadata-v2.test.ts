import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ALL_V13_TOOL_NAMES,
  ALL_V14_TOOL_NAMES,
  RECOVERY_TOOL_NAMES,
} from "../../src/tools/registry.js";
import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  PC_SCOPE_STATEMENT,
  TOOL_METADATA,
  USER_ACTION_STATEMENT,
  getToolMetadata,
  validateToolMetadataRegistry,
} from "../../src/tools/metadata.js";
import { collectParameterDescriptionIssues } from "../../src/tools/metadata-lint.js";
import { registerAllTools } from "../../src/tools/index.js";
import { registerTracedTool } from "../../src/tools/tool-wrapper.js";
import { ConfigManager } from "../../src/config/config-manager.js";

async function withRegisteredV13Tools<T>(
  fn: (tools: Record<string, any>) => T
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-metadata-"));
  const configFile = path.join(dir, "config.json");
  await fs.writeFile(
    configFile,
    JSON.stringify({
      schemaVersion: 2,
      folders: [],
      terminal: { mode: "off" },
      toolPolicy: {},
    }),
    "utf8"
  );

  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    const server = new McpServer({
      name: "metadata-fixture",
      version: "1.0.0",
    });
    registerAllTools(server);
    return fn((server as any)._registeredTools);
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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


  it("covers the accepted v1.3 surface plus adopted Spec 3.4 Tier A tools with no drift", () => {
    assert.strictEqual(ALL_V13_TOOL_NAMES.length, 41);
    assert.strictEqual(Object.keys(TOOL_METADATA).length, ALL_V14_TOOL_NAMES.length);
    assert.deepStrictEqual(
      Object.keys(TOOL_METADATA).sort(),
      [...ALL_V14_TOOL_NAMES].sort()
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

  it("states explicit routing preferences for overlapping tool families", () => {
    assert.match(
      getToolMetadata("file_read").description,
      /prefer this over terminal\/Get-Content/i
    );
    assert.match(
      getToolMetadata("file_write").description,
      /prefer file_write_atomic/i
    );
    assert.match(
      getToolMetadata("file_write_atomic").description,
      /preferred for important or concurrency-sensitive/i
    );
    assert.match(
      getToolMetadata("file_create_exclusive").description,
      /must not already exist|must never be overwritten/i
    );
    assert.match(
      getToolMetadata("file_search").description,
      /prefer ripgrep for code, regex, globs, context, or pagination/i
    );
    assert.match(
      getToolMetadata("file_search_ripgrep").description,
      /codebase, regex, glob, context, or large-result/i
    );
    assert.match(
      getToolMetadata("command_run").description,
      /prefer this for direct executable invocation/i
    );
    assert.match(
      getToolMetadata("terminal_run").description,
      /shell\/PowerShell semantics are required/i
    );
    assert.match(
      getToolMetadata("terminal_task_start").description,
      /long-running or interactive PowerShell task/i
    );
    assert.match(
      getToolMetadata("command_run").description,
      /terminal mode safe is package-manager-only.*ask\/full permit governed direct executables/i
    );
    assert.match(
      getToolMetadata("session_audit_search").description,
      /this session.*invocation\/audit projection.*file_provenance_lookup/i
    );
  });

  it("clarifies Safe command mode and durable provenance in public parameter descriptions", async () => {
    await withRegisteredV13Tools((tools) => {
      const commandDescription = String(
        tools.command_run.inputSchema.shape.command._def.description
      );
      assert.match(
        commandDescription,
        /terminal mode safe.*npm, pnpm, yarn, or bun.*ask\/full modes permit governed direct executables/i
      );

      const auditPathDescription = String(
        tools.session_audit_search.inputSchema.shape.path._def.description
      );
      assert.match(
        auditPathDescription,
        /invocation\/audit projection.*file_provenance_lookup.*durable mutation attribution/i
      );
      return undefined;
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

  it("carries the mandated 5.2 guidance in every description", () => {
    for (const name of ALL_V13_TOOL_NAMES) {
      const { description } = getToolMetadata(name);
      assert.ok(
        description.includes(PC_SCOPE_STATEMENT),
        name + " must state the real-PC scope"
      );
      assert.ok(
        description.includes(USER_ACTION_STATEMENT),
        name + " must tell the model to relay userAction"
      );
      assert.ok(
        description.length >= DESCRIPTION_MIN_LENGTH &&
          description.length <= DESCRIPTION_MAX_LENGTH,
        `${name} description length ${description.length} outside ${DESCRIPTION_MIN_LENGTH}-${DESCRIPTION_MAX_LENGTH}`
      );
    }
  });

  it("gives the model the 5.2 idempotencyKey semantics where it is accepted", async () => {
    await withRegisteredV13Tools((tools) => {
      for (const name of ["command_run", "winhelm_job_status"]) {
        const field = tools[name].inputSchema.shape.idempotencyKey;
        const description = String(field._def.description);
        assert.match(description, /dropped connection|recovers the same/i, name);
        assert.match(description, /not permission to re-run|never authorizes/i, name);
      }
      return undefined;
    });
  });

  it("describes every parameter of every registered tool", async () => {
    await withRegisteredV13Tools((tools) => {
      assert.strictEqual(Object.keys(tools).length, ALL_V14_TOOL_NAMES.length);
      assert.deepStrictEqual(collectParameterDescriptionIssues(tools), []);
      return undefined;
    });
  });
});
