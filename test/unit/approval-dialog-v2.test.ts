import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeRequestFolderAccess } from "../../src/permissions/tool-access.js";
import { escapeHtml, getDashboardHtml } from "../../src/gateway/dashboard-html.js";
import { translate } from "../../src/i18n/messages.js";

describe("Approval dialog folder resolution", () => {
  it("reports the folder and permission that authorize each path argument", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-approval-view-"));
    try {
      const folders = [
        { path: root, alias: "ws", permission: "readwrite" as const },
      ];

      const [write] = describeRequestFolderAccess(
        "file_write",
        { path: "@ws/note.txt", content: "x" },
        folders
      );
      assert.strictEqual(write.argument, "path");
      assert.strictEqual(write.requested, "@ws/note.txt");
      assert.strictEqual(write.resolved, path.join(root, "note.txt"));
      assert.strictEqual(write.allowed, true);
      assert.deepStrictEqual(write.folder, {
        alias: "ws",
        path: root,
        permission: "readwrite",
      });

      const readOnly = describeRequestFolderAccess(
        "file_read",
        { path: "@docs/note.txt" },
        [{ path: root, alias: "docs", permission: "read" }]
      );
      assert.strictEqual(readOnly[0].allowed, true);
      assert.strictEqual(readOnly[0].folder?.permission, "read");

      const writeToRead = describeRequestFolderAccess(
        "file_write",
        { path: "@docs/note.txt", content: "x" },
        [{ path: root, alias: "docs", permission: "read" }]
      );
      assert.strictEqual(writeToRead[0].allowed, false);
      assert.strictEqual(writeToRead[0].code, "FOLDER_READ_ONLY");
      assert.strictEqual(writeToRead[0].folder?.permission, "read");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("shows no folder for an ambiguous or unlisted path", () => {
    const ambiguous = describeRequestFolderAccess(
      "file_write",
      { path: "note.txt", content: "x" },
      [
        { path: "D:\\A", alias: "a", permission: "readwrite" },
        { path: "D:\\B", alias: "b", permission: "readwrite" },
      ]
    );
    assert.strictEqual(ambiguous.length, 1);
    assert.strictEqual(ambiguous[0].resolved, null);
    assert.strictEqual(ambiguous[0].allowed, false);
    assert.strictEqual(ambiguous[0].code, "AMBIGUOUS_PATH");
    assert.strictEqual(ambiguous[0].folder, null);

    const outside = describeRequestFolderAccess(
      "file_read",
      { path: "D:\\Elsewhere\\x.txt" },
      [{ path: "D:\\A", alias: "a", permission: "readwrite" }]
    );
    assert.strictEqual(outside[0].code, "FOLDER_NOT_APPROVED");
    assert.strictEqual(outside[0].folder, null);
  });

  it("covers multi-path tools and skips missing arguments", () => {
    const views = describeRequestFolderAccess(
      "file_copy",
      { source: "D:\\A\\a.txt", destination: "D:\\A\\b.txt" },
      [{ path: "D:\\A", alias: "a", permission: "readwrite" }]
    );
    assert.deepStrictEqual(
      views.map((view) => view.argument),
      ["source", "destination"]
    );
    assert.ok(views.every((view) => view.allowed));

    assert.deepStrictEqual(
      describeRequestFolderAccess("file_write", {}, [
        { path: "D:\\A", alias: "a", permission: "readwrite" },
      ]),
      []
    );
  });
});

describe("Dashboard approval dialog rendering", () => {
  const html = getDashboardHtml("full", {
    schemaMode: "v2",
    preset: "balanced",
    terminalMode: "ask",
  });

  it("renders arguments in an expanded, collapsible block", () => {
    assert.match(html, /const argsDetails = document\.createElement\('details'\);/);
    assert.match(html, /argsDetails\.open = true;/);
    assert.match(
      html,
      /addTextElement\(\s*argsDetails,\s*'summary',\s*DASHBOARD_MESSAGES\.approvalsArguments\s*\)/
    );
    assert.ok(html.includes("Approval arguments"));
  });

  it("renders the folder and permission for path arguments", () => {
    assert.match(html, /Array\.isArray\(job\.folderAccess\)/);
    assert.match(html, /String\(folder\.permission\)/);
    assert.match(html, /DASHBOARD_MESSAGES\.approvalsFolders/);
    assert.match(html, /DASHBOARD_MESSAGES\.approvalsNoFolder/);
    assert.ok(html.includes("Folders"));
    assert.strictEqual(html.includes("folderAccess').innerHTML"), false);
  });

  it("ships the new labels in both locales", () => {
    for (const key of [
      "dashboard.approvals.arguments",
      "dashboard.approvals.folders",
      "dashboard.approvals.noFolder",
    ] as const) {
      assert.ok(translate(key, {}, "en").trim().length > 0);
      assert.ok(translate(key, {}, "th").trim().length > 0);
      assert.notStrictEqual(
        translate(key, {}, "en"),
        translate(key, {}, "th")
      );
      assert.ok(html.includes(escapeHtml(translate(key, {}, "en"))));
    }
  });
});
