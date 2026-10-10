import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkFolderAccess,
  prepareFolderAccessContext,
  type ProtectedPathRule,
} from "../../src/permissions/folder-access.js";

describe("Protected-rule fail-closed evaluation (Fix 2)", () => {
  it("normal valid protected rules retain existing behavior in both direct and prepared modes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-fc-normal-"));
    try {
      const protectedFile = path.join(root, "protected.txt");
      const ordinaryFile = path.join(root, "ordinary.txt");
      const protectedTreeDir = path.join(root, "protected-dir");
      await fs.mkdir(protectedTreeDir);
      const childInTree = path.join(protectedTreeDir, "inner.txt");

      await fs.writeFile(protectedFile, "protected", "utf-8");
      await fs.writeFile(ordinaryFile, "ordinary", "utf-8");
      await fs.writeFile(childInTree, "tree-child", "utf-8");

      const rules: ProtectedPathRule[] = [
        { path: protectedFile, kind: "file", label: "synthetic-protected-file" },
        { path: protectedTreeDir, kind: "tree", label: "synthetic-protected-tree" },
      ];
      const folders = [{ path: root, permission: "readwrite" as const }];
      const prep = prepareFolderAccessContext(folders, rules);

      // Direct check: protected file blocked
      const directFile = checkFolderAccess(protectedFile, "read", folders, { protectedPaths: rules });
      assert.strictEqual(directFile.allowed, false);
      assert.strictEqual(directFile.code, "FOLDER_PROTECTED_PATH");

      // Prepared check: protected file blocked
      const prepFile = checkFolderAccess(protectedFile, "read", folders, { preparedContext: prep });
      assert.strictEqual(prepFile.allowed, false);
      assert.strictEqual(prepFile.code, "FOLDER_PROTECTED_PATH");

      // Direct check: protected tree child blocked
      const directTree = checkFolderAccess(childInTree, "read", folders, { protectedPaths: rules });
      assert.strictEqual(directTree.allowed, false);
      assert.strictEqual(directTree.code, "FOLDER_PROTECTED_PATH");

      // Prepared check: protected tree child blocked
      const prepTree = checkFolderAccess(childInTree, "read", folders, { preparedContext: prep });
      assert.strictEqual(prepTree.allowed, false);
      assert.strictEqual(prepTree.code, "FOLDER_PROTECTED_PATH");

      // Ordinary file allowed in both
      const directOrd = checkFolderAccess(ordinaryFile, "read", folders, { protectedPaths: rules });
      assert.strictEqual(directOrd.allowed, true);
      assert.strictEqual(directOrd.code, "FOLDER_ALLOWED");

      const prepOrd = checkFolderAccess(ordinaryFile, "read", folders, { preparedContext: prep });
      assert.strictEqual(prepOrd.allowed, true);
      assert.strictEqual(prepOrd.code, "FOLDER_ALLOWED");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("direct path evaluation failure fails closed with FOLDER_PROTECTED_PATH denial", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-fc-direct-fail-"));
    try {
      const ordinaryFile = path.join(root, "ordinary.txt");
      await fs.writeFile(ordinaryFile, "ordinary", "utf-8");

      // A synthetic rule whose canonicalization or evaluation throws (e.g. invalid/empty path)
      const malformedRule: ProtectedPathRule = {
        path: "" as any,
        kind: "file",
        label: "malformed-rule",
      };

      const folders = [{ path: root, permission: "readwrite" as const }];

      // In direct check, even though target is ordinaryFile, a failing protected rule must fail closed
      const result = checkFolderAccess(ordinaryFile, "read", folders, {
        protectedPaths: [malformedRule],
      });

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.code, "FOLDER_PROTECTED_PATH");
      assert.match(result.reason, /fail|protected/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepared context rule preparation failure fails closed across evaluations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-fc-prep-fail-"));
    try {
      const ordinaryFile = path.join(root, "ordinary.txt");
      await fs.writeFile(ordinaryFile, "ordinary", "utf-8");

      const malformedRule: ProtectedPathRule = {
        path: null as any,
        kind: "file",
        label: "malformed-rule-prep",
      };

      const folders = [{ path: root, permission: "readwrite" as const }];

      // prepareFolderAccessContext must capture the failure
      const prep = prepareFolderAccessContext(folders, [malformedRule]);
      assert.strictEqual(prep.hasFailedProtectedRule, true);

      // checkFolderAccess using this prepared context must fail closed
      const result = checkFolderAccess(ordinaryFile, "read", folders, {
        preparedContext: prep,
      });

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.code, "FOLDER_PROTECTED_PATH");
      assert.match(result.reason, /fail|protected/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
