import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FolderPermission, SchemaV2PermissionConfig, TerminalMode, ToolPolicy } from "../../src/config/schema-v2.js";
import { checkFolderAccess } from "../../src/permissions/folder-access.js";
import { evaluateSchemaV2ToolAccess } from "../../src/permissions/tool-access.js";

function makeConfig(
  folders: FolderPermission[],
  toolPolicy: Record<string, ToolPolicy> = {},
  terminalMode: TerminalMode = "off"
): SchemaV2PermissionConfig {
  return {
    schemaVersion: 2,
    folders,
    terminal: { mode: terminalMode },
    toolPolicy,
    approval: {
      channels: ["dashboard", "toast"],
      blockHoldMs: 60_000,
      jobTtlMs: 180_000,
      maxPending: 5,
    },
    network: { allowLoopback: false },
  };
}

describe("Schema-v2 folder access", () => {
  it("allows reads in read folders and rejects writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-folder-read-"));
    try {
      const file = path.join(root, "note.txt");
      await fs.writeFile(file, "hello", "utf-8");

      const folders: FolderPermission[] = [{ path: root, permission: "read" }];
      assert.strictEqual(checkFolderAccess(file, "read", folders).allowed, true);

      const write = checkFolderAccess(file, "write", folders);
      assert.strictEqual(write.allowed, false);
      assert.strictEqual(write.code, "FOLDER_READ_ONLY");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the most-specific nested folder permission", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-folder-nested-"));
    const writable = path.join(root, "writable");
    await fs.mkdir(writable);
    try {
      const folders: FolderPermission[] = [
        { path: root, permission: "read" },
        { path: writable, permission: "readwrite" },
      ];

      assert.strictEqual(
        checkFolderAccess(path.join(writable, "new.txt"), "write", folders).allowed,
        true
      );
      assert.strictEqual(
        checkFolderAccess(path.join(root, "other.txt"), "write", folders).code,
        "FOLDER_READ_ONLY"
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects paths outside configured folders", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-folder-in-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-folder-out-"));
    try {
      const result = checkFolderAccess(
        path.join(outside, "x.txt"),
        "read",
        [{ path: root, permission: "readwrite" }]
      );
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.code, "FOLDER_NOT_APPROVED");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects mutation of the configured root node but allows writing children", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-folder-root-"));
    try {
      const folders: FolderPermission[] = [{ path: root, permission: "readwrite" }];

      const rootMutation = checkFolderAccess(root, "write", folders, {
        denyRootMutation: true,
      });
      assert.strictEqual(rootMutation.code, "FOLDER_ROOT_MUTATION");

      const childWrite = checkFolderAccess(path.join(root, "child.txt"), "write", folders, {
        denyRootMutation: true,
      });
      assert.strictEqual(childWrite.allowed, true);

      const writeChildrenIntoRoot = checkFolderAccess(root, "write", folders, {
        denyRootMutation: false,
      });
      assert.strictEqual(writeChildrenIntoRoot.allowed, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows read through an in-root junction but rejects mutation through it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-folder-junction-"));
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "note.txt"), "hello", "utf-8");

    try {
      await fs.symlink(target, link, "junction");
      const throughLink = path.join(link, "note.txt");
      const folders: FolderPermission[] = [{ path: root, permission: "readwrite" }];

      assert.strictEqual(checkFolderAccess(throughLink, "read", folders).allowed, true);

      const write = checkFolderAccess(throughLink, "write", folders);
      assert.strictEqual(write.allowed, false);
      assert.strictEqual(write.code, "FOLDER_REPARSE_MUTATION");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Schema-v2 tool access classification", () => {
  it("fails closed when tool policy is missing", () => {
    const config = makeConfig([], {});
    const result = evaluateSchemaV2ToolAccess("system_info", {}, config);
    assert.strictEqual(result.decision, "deny");
    assert.strictEqual(result.code, "POLICY_OFF");
  });

  it("maps generic auto and ask policies", () => {
    const config = makeConfig([], {
      system_info: "auto",
      screen_capture: "ask",
    });

    assert.strictEqual(
      evaluateSchemaV2ToolAccess("system_info", {}, config).decision,
      "allow"
    );
    assert.strictEqual(
      evaluateSchemaV2ToolAccess("screen_capture", {}, config).decision,
      "ask"
    );
  });

  it("enforces read vs write for file tools before policy execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tool-file-"));
    try {
      const file = path.join(root, "note.txt");
      await fs.writeFile(file, "hello", "utf-8");
      const config = makeConfig(
        [{ path: root, permission: "read" }],
        { file_read: "auto", file_write: "auto" }
      );

      assert.strictEqual(
        evaluateSchemaV2ToolAccess("file_read", { path: file }, config).decision,
        "allow"
      );

      const write = evaluateSchemaV2ToolAccess(
        "file_write",
        { path: file, content: "changed" },
        config
      );
      assert.strictEqual(write.decision, "deny");
      assert.strictEqual(write.code, "FOLDER_READ_ONLY");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("enforces copy source-read/destination-write and move write/write semantics", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tool-cross-"));
    const readRoot = path.join(root, "read");
    const writeRoot = path.join(root, "write");
    await fs.mkdir(readRoot);
    await fs.mkdir(writeRoot);
    const source = path.join(readRoot, "source.txt");
    await fs.writeFile(source, "hello", "utf-8");

    try {
      const config = makeConfig(
        [
          { path: readRoot, permission: "read" },
          { path: writeRoot, permission: "readwrite" },
        ],
        { file_copy: "auto", file_move: "auto" }
      );

      const copy = evaluateSchemaV2ToolAccess(
        "file_copy",
        { source, destination: path.join(writeRoot, "copy.txt") },
        config
      );
      assert.strictEqual(copy.decision, "allow");

      const move = evaluateSchemaV2ToolAccess(
        "file_move",
        { source, destination: path.join(writeRoot, "moved.txt") },
        config
      );
      assert.strictEqual(move.decision, "deny");
      assert.strictEqual(move.code, "FOLDER_READ_ONLY");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows archive extraction into a readwrite configured root without treating it as root replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tool-unzip-"));
    const zipRoot = path.join(root, "zips");
    const targetRoot = path.join(root, "target");
    await fs.mkdir(zipRoot);
    await fs.mkdir(targetRoot);
    const zip = path.join(zipRoot, "archive.zip");
    await fs.writeFile(zip, "fixture", "utf-8");

    try {
      const config = makeConfig(
        [
          { path: zipRoot, permission: "read" },
          { path: targetRoot, permission: "readwrite" },
        ],
        { archive_unzip: "auto" }
      );

      const result = evaluateSchemaV2ToolAccess(
        "archive_unzip",
        { zip_path: zip, target_dir: targetRoot },
        config
      );
      assert.strictEqual(result.decision, "allow");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats system_open file targets as folder reads but non-file URLs as policy-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tool-open-"));
    try {
      const file = path.join(root, "note.txt");
      await fs.writeFile(file, "hello", "utf-8");
      const config = makeConfig(
        [{ path: root, permission: "read" }],
        { system_open: "auto" }
      );

      assert.strictEqual(
        evaluateSchemaV2ToolAccess("system_open", { target: file }, config).decision,
        "allow"
      );
      assert.strictEqual(
        evaluateSchemaV2ToolAccess("system_open", { target: "https://example.com" }, config).decision,
        "allow"
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("governs terminal execution tools by terminal.mode instead of toolPolicy", () => {
    const askConfig = makeConfig([], { terminal_run: "off" }, "ask");
    const ask = evaluateSchemaV2ToolAccess(
      "terminal_run",
      { command: "Write-Output hello" },
      askConfig
    );
    assert.strictEqual(ask.decision, "ask");

    const safeConfig = makeConfig([], { terminal_run: "auto" }, "safe");
    const safe = evaluateSchemaV2ToolAccess(
      "terminal_run",
      { command: "Write-Output hello" },
      safeConfig
    );
    assert.strictEqual(safe.decision, "deny");
    assert.strictEqual(safe.code, "TERMINAL_MODE_REQUIRED");

    const fullConfig = makeConfig([], { terminal_run: "off" }, "full");
    assert.strictEqual(
      evaluateSchemaV2ToolAccess(
        "terminal_run",
        { command: "Write-Output hello" },
        fullConfig
      ).decision,
      "allow"
    );
  });

  it("keeps terminal task list/logs under ordinary toolPolicy", () => {
    const config = makeConfig([], {
      terminal_task_list: "auto",
      terminal_task_logs: "ask",
    }, "off");

    assert.strictEqual(
      evaluateSchemaV2ToolAccess("terminal_task_list", {}, config).decision,
      "allow"
    );
    assert.strictEqual(
      evaluateSchemaV2ToolAccess("terminal_task_logs", { task_id: "x" }, config).decision,
      "ask"
    );
  });
});
