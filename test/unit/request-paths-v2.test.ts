import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { registerAllTools } from "../../src/tools/index.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";
import { evaluateSchemaV2ToolAccess } from "../../src/permissions/tool-access.js";
import { resolveRequestPath } from "../../src/permissions/request-paths.js";

const TWO_FOLDERS = [
  { path: "D:\\Workspace", alias: "ws", permission: "readwrite" as const },
  { path: "D:\\Docs", alias: "docs", permission: "read" as const },
];

describe("Schema-v2 request path resolution", () => {
  it("resolves @alias paths against the aliased folder", () => {
    const nested = resolveRequestPath("@ws/src/a.ts", TWO_FOLDERS);
    assert.deepStrictEqual(nested, {
      ok: true,
      path: path.resolve("D:\\Workspace", "src", "a.ts"),
      alias: "ws",
    });

    const root = resolveRequestPath("@docs", TWO_FOLDERS);
    assert.ok(root.ok);
    assert.strictEqual(root.path, path.resolve("D:\\Docs"));
  });

  it("matches aliases case-insensitively and rejects unknown aliases", () => {
    const upper = resolveRequestPath("@WS/a.ts", TWO_FOLDERS);
    assert.strictEqual(upper.ok, true);

    const unknown = resolveRequestPath("@nope/a.ts", TWO_FOLDERS);
    assert.strictEqual(unknown.ok, false);
    if (!unknown.ok) {
      assert.strictEqual(unknown.code, "FOLDER_NOT_APPROVED");
      assert.deepStrictEqual(unknown.folders, [
        {
          alias: "ws",
          path: "D:\\Workspace",
          permission: "readwrite",
        },
        { alias: "docs", path: "D:\\Docs", permission: "read" },
      ]);
    }
  });

  it("keeps an absolute path unchanged", () => {
    const resolved = resolveRequestPath("D:\\Other\\a.txt", TWO_FOLDERS);
    assert.deepStrictEqual(resolved, {
      ok: true,
      path: path.resolve("D:\\Other\\a.txt"),
      alias: null,
    });
  });

  it("resolves a relative path only while one folder is configured", () => {
    const single = resolveRequestPath("note.txt", [TWO_FOLDERS[0]]);
    assert.deepStrictEqual(single, {
      ok: true,
      path: path.resolve("D:\\Workspace", "note.txt"),
      alias: "ws",
    });

    const dot = resolveRequestPath(".", [TWO_FOLDERS[0]]);
    assert.ok(dot.ok);
    assert.strictEqual(dot.path, path.resolve("D:\\Workspace"));
  });

  it("refuses an ambiguous relative path with the folder list", () => {
    const ambiguous = resolveRequestPath("note.txt", TWO_FOLDERS);
    assert.strictEqual(ambiguous.ok, false);
    if (!ambiguous.ok) {
      assert.strictEqual(ambiguous.code, "AMBIGUOUS_PATH");
      assert.strictEqual(ambiguous.folders.length, 2);
      assert.deepStrictEqual(
        ambiguous.folders.map((folder) => folder.alias),
        ["ws", "docs"]
      );
      assert.deepStrictEqual(
        ambiguous.folders.map((folder) => folder.permission),
        ["readwrite", "read"]
      );
    }
  });

  it("refuses a relative path when no folder is configured", () => {
    const none = resolveRequestPath("note.txt", []);
    assert.strictEqual(none.ok, false);
    if (!none.ok) {
      assert.strictEqual(none.code, "FOLDER_NOT_APPROVED");
    }
  });

  it("rewrites the request argument to the path that was authorized", () => {
    const args: Record<string, unknown> = { path: "@ws/a.ts", content: "x" };
    const access = evaluateSchemaV2ToolAccess(
      "file_write",
      args,
      {
        schemaVersion: 2,
        folders: TWO_FOLDERS,
        terminal: { mode: "off" },
        toolPolicy: { file_write: "auto" },
      } as any
    );

    assert.strictEqual(access.decision, "allow");
    assert.strictEqual(args.path, path.resolve("D:\\Workspace", "a.ts"));
  });

  it("denies an ambiguous relative request without rewriting it", () => {
    const args: Record<string, unknown> = { path: "a.ts", content: "x" };
    const access = evaluateSchemaV2ToolAccess(
      "file_write",
      args,
      {
        schemaVersion: 2,
        folders: TWO_FOLDERS,
        terminal: { mode: "off" },
        toolPolicy: { file_write: "auto" },
      } as any
    );

    assert.strictEqual(access.decision, "deny");
    assert.strictEqual(access.code, "AMBIGUOUS_PATH");
    assert.ok(access.userAction);
    assert.strictEqual(args.path, "a.ts");
    const folders = access.details?.folders as any[];
    assert.strictEqual(folders.length, 2);
  });
});

async function withConfig(
  value: Record<string, unknown>,
  fn: (manager: ConfigManager) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-paths-"));
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

async function registeredTools(): Promise<Record<string, any>> {
  const server = new McpServer({ name: "paths-v2", version: "1.0.0" });
  registerAllTools(server);
  return (server as any)._registeredTools;
}

describe("Schema-v2 path resolution through the tool surface", () => {
  it("reads through @alias and executes against the resolved path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-alias-"));
    try {
      await fs.writeFile(
        path.join(root, "note.txt"),
        "hello-alias",
        "utf8"
      );

      await withConfig(
        {
          schemaVersion: 2,
          folders: [
            { path: root, alias: "ws", permission: "readwrite" },
          ],
          terminal: { mode: "off" },
          toolPolicy: { file_read: "auto" },
        },
        async () => {
          const tools = await registeredTools();
          const result = await tools.file_read.handler(
            { path: "@ws/note.txt" },
            { sessionId: "alias-session" }
          );

          assert.notStrictEqual(result.isError, true);
          assert.ok(
            String(result.content[0].text).includes("hello-alias")
          );
        }
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a relative path while a single folder is configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-single-"));
    try {
      await fs.writeFile(
        path.join(root, "note.txt"),
        "single-folder",
        "utf8"
      );

      await withConfig(
        {
          schemaVersion: 2,
          folders: [
            { path: root, alias: "ws", permission: "readwrite" },
          ],
          terminal: { mode: "off" },
          toolPolicy: { file_read: "auto" },
        },
        async () => {
          const tools = await registeredTools();
          const result = await tools.file_read.handler(
            { path: "note.txt" },
            { sessionId: "single-session" }
          );

          assert.notStrictEqual(result.isError, true);
          assert.ok(
            String(result.content[0].text).includes("single-folder")
          );
        }
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an ambiguous relative path and discloses the folders", async () => {
    const first = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-amb-a-"));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-amb-b-"));
    try {
      await withConfig(
        {
          schemaVersion: 2,
          folders: [
            { path: first, alias: "a", permission: "readwrite" },
            { path: second, alias: "b", permission: "read" },
          ],
          terminal: { mode: "off" },
          toolPolicy: { file_read: "auto" },
        },
        async () => {
          const tools = await registeredTools();
          const result = await tools.file_read.handler(
            { path: "note.txt" },
            { sessionId: "ambiguous-session" }
          );

          assert.strictEqual(result.isError, true);
          const payload = JSON.parse(result.content[0].text);
          assert.strictEqual(payload.error.code, "AMBIGUOUS_PATH");
          assert.deepStrictEqual(
            payload.error.details.folders.map((folder: any) => folder.alias),
            ["a", "b"]
          );
          assert.deepStrictEqual(
            payload.error.details.folders.map(
              (folder: any) => folder.permission
            ),
            ["readwrite", "read"]
          );
          assert.ok(payload.error.userAction);
        }
      );
    } finally {
      await fs.rm(first, { recursive: true, force: true });
      await fs.rm(second, { recursive: true, force: true });
    }
  });

  it("still enforces read-only folders after alias resolution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-ro-"));
    try {
      await withConfig(
        {
          schemaVersion: 2,
          folders: [
            { path: root, alias: "docs", permission: "read" },
          ],
          terminal: { mode: "off" },
          toolPolicy: { file_write: "auto" },
        },
        async () => {
          const tools = await registeredTools();
          const result = await tools.file_write.handler(
            { path: "@docs/new.txt", content: "nope" },
            { sessionId: "readonly-session" }
          );

          assert.strictEqual(result.isError, true);
          const payload = JSON.parse(result.content[0].text);
          assert.strictEqual(payload.error.code, "FOLDER_READ_ONLY");
          await assert.rejects(
            fs.stat(path.join(root, "new.txt"))
          );
        }
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps aliases out of legacy mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-legacy-"));
    try {
      await fs.writeFile(
        path.join(root, "note.txt"),
        "legacy-content",
        "utf8"
      );

      await withConfig(
        {
          allowedDirectories: [root],
          profile: "full",
          readOnly: false,
        },
        async () => {
          const tools = await registeredTools();
          const aliased = await tools.file_read.handler(
            { path: "@ws/note.txt" },
            { sessionId: "legacy-session" }
          );
          assert.strictEqual(aliased.isError, true);

          const absolute = await tools.file_read.handler(
            { path: path.join(root, "note.txt") },
            { sessionId: "legacy-session" }
          );
          assert.notStrictEqual(absolute.isError, true);
          assert.ok(
            String(absolute.content[0].text).includes("legacy-content")
          );
        }
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
