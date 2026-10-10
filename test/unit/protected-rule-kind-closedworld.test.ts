import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkFolderAccess,
  isValidProtectedRuleKind,
  prepareFolderAccessContext,
  protectedRuleBlocksPath,
  type ProtectedPathRule,
} from "../../src/permissions/folder-access.js";
import { ConfigManager } from "../../src/config/config-manager.js";

const MALFORMED_KINDS: unknown[] = [
  undefined, // missing kind
  null, // null kind
  123, // numeric kind
  "", // empty string
  "bogus",
  "TREE", // wrong case must not be accepted
  "File",
  "tree ", // trailing space must not be accepted
  " file",
  {}, // object kind
  ["tree"], // array kind
];

function malformedRule(treePath: string, kind: unknown): ProtectedPathRule {
  return {
    path: treePath,
    kind: kind as ProtectedPathRule["kind"],
    label: "malformed-kind",
  };
}

describe("S2 closed-world protected rule kind validation (R2)", () => {
  it("validator accepts only exactly 'file' | 'tree'", () => {
    assert.strictEqual(isValidProtectedRuleKind("file"), true);
    assert.strictEqual(isValidProtectedRuleKind("tree"), true);
    for (const kind of MALFORMED_KINDS) {
      assert.strictEqual(
        isValidProtectedRuleKind(kind),
        false,
        `kind ${JSON.stringify(kind)} must be rejected`
      );
    }
  });

  it("malformed kind fails closed in direct evaluation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-kind-"));
    try {
      const treeDir = path.join(root, "protected-tree");
      await fs.mkdir(treeDir, { recursive: true });
      const descendant = path.join(treeDir, "child.txt");
      await fs.writeFile(descendant, "x", "utf8");
      const folders = [{ path: root, permission: "readwrite" as const }];

      for (const kind of MALFORMED_KINDS) {
        const rule = malformedRule(treeDir, kind);
        const res = checkFolderAccess(descendant, "read", folders, {
          protectedPaths: [rule],
        });
        assert.strictEqual(res.allowed, false, `direct: kind ${JSON.stringify(kind)} must deny`);
        assert.strictEqual(res.code, "FOLDER_PROTECTED_PATH", `direct: kind ${JSON.stringify(kind)} code`);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("malformed kind fails closed in prepared evaluation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-kindp-"));
    try {
      const treeDir = path.join(root, "protected-tree");
      await fs.mkdir(treeDir, { recursive: true });
      const descendant = path.join(treeDir, "child.txt");
      await fs.writeFile(descendant, "x", "utf8");
      const folders = [{ path: root, permission: "readwrite" as const }];

      for (const kind of MALFORMED_KINDS) {
        const rule = malformedRule(treeDir, kind);
        const prep = prepareFolderAccessContext(folders, [rule]);
        assert.strictEqual(
          prep.hasFailedProtectedRule,
          true,
          `prepared: kind ${JSON.stringify(kind)} must mark failed rule`
        );
        const res = checkFolderAccess(descendant, "read", folders, {
          preparedContext: prep,
        });
        assert.strictEqual(res.allowed, false, `prepared: kind ${JSON.stringify(kind)} must deny`);
        assert.strictEqual(res.code, "FOLDER_PROTECTED_PATH", `prepared: kind ${JSON.stringify(kind)} code`);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("one malformed rule denies the whole evaluation even among valid rules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-kindmix-"));
    try {
      const validTree = path.join(root, "valid-tree");
      await fs.mkdir(validTree, { recursive: true });
      const validChild = path.join(validTree, "inner.txt");
      await fs.writeFile(validChild, "x", "utf8");
      const malformedTree = path.join(root, "malformed-tree");
      await fs.mkdir(malformedTree, { recursive: true });
      const ordinary = path.join(root, "ordinary.txt");
      await fs.writeFile(ordinary, "x", "utf8");
      const folders = [{ path: root, permission: "readwrite" as const }];
      const rules: ProtectedPathRule[] = [
        { path: validTree, kind: "tree", label: "valid" },
        malformedRule(malformedTree, "bogus"),
      ];

      const direct = checkFolderAccess(ordinary, "read", folders, { protectedPaths: rules });
      assert.strictEqual(direct.allowed, false);
      assert.strictEqual(direct.code, "FOLDER_PROTECTED_PATH");

      const prep = prepareFolderAccessContext(folders, rules);
      assert.strictEqual(prep.hasFailedProtectedRule, true);
      const prepared = checkFolderAccess(ordinary, "read", folders, { preparedContext: prep });
      assert.strictEqual(prepared.allowed, false);
      assert.strictEqual(prepared.code, "FOLDER_PROTECTED_PATH");
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("protectedRuleBlocksPath throws on malformed kind (direct path converts to denial)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-kindblk-"));
    try {
      const treeDir = path.join(root, "t");
      await fs.mkdir(treeDir, { recursive: true });
      for (const kind of ["bogus", "TREE", "", null, 42]) {
        assert.throws(
          () => protectedRuleBlocksPath(malformedRule(treeDir, kind), path.join(treeDir, "x")),
          /kind/i,
          `kind ${JSON.stringify(kind)} must throw`
        );
      }
      // Valid kinds keep working.
      assert.strictEqual(
        protectedRuleBlocksPath({ path: treeDir, kind: "tree" }, path.join(treeDir, "x")),
        true
      );
      assert.strictEqual(
        protectedRuleBlocksPath({ path: treeDir, kind: "file" }, path.join(treeDir, "x")),
        false
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("valid file/tree rules keep exact behavior in both modes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-kindok-"));
    try {
      const pFile = path.join(root, "protected.txt");
      const pTree = path.join(root, "ptree");
      await fs.mkdir(pTree, { recursive: true });
      const pChild = path.join(pTree, "c.txt");
      const ordinary = path.join(root, "ordinary.txt");
      await fs.writeFile(pFile, "x", "utf8");
      await fs.writeFile(pChild, "x", "utf8");
      await fs.writeFile(ordinary, "x", "utf8");
      const folders = [{ path: root, permission: "readwrite" as const }];
      const rules: ProtectedPathRule[] = [
        { path: pFile, kind: "file" },
        { path: pTree, kind: "tree" },
      ];
      const prep = prepareFolderAccessContext(folders, rules);
      assert.strictEqual(prep.hasFailedProtectedRule, false);

      for (const target of [pFile, pChild]) {
        const d = checkFolderAccess(target, "read", folders, { protectedPaths: rules });
        assert.strictEqual(d.code, "FOLDER_PROTECTED_PATH");
        const p = checkFolderAccess(target, "read", folders, { preparedContext: prep });
        assert.strictEqual(p.code, "FOLDER_PROTECTED_PATH");
      }
      const o1 = checkFolderAccess(ordinary, "read", folders, { protectedPaths: rules });
      assert.strictEqual(o1.code, "FOLDER_ALLOWED");
      const o2 = checkFolderAccess(ordinary, "read", folders, { preparedContext: prep });
      assert.strictEqual(o2.code, "FOLDER_ALLOWED");
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("legacy prepared context still denies WinHelm's own protected paths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-kindleg-"));
    const configFile = path.join(dir, "config.json");
    await fs.writeFile(configFile, JSON.stringify({ allowedDirectories: ["*"] }), "utf8");
    try {
      const manager = ConfigManager.resetInstance(configFile);
      await manager.init(configFile);
      assert.strictEqual(manager.getConfigMode(), "legacy");
      const prepared = manager.preparePathAccessContext("read");
      const denied = prepared.checkPathAccess(configFile);
      assert.strictEqual(denied.allowed, false);
      assert.strictEqual(denied.code, "FOLDER_PROTECTED_PATH");
      const ordinary = path.join(dir, "ordinary.txt");
      await fs.writeFile(ordinary, "x", "utf8");
      assert.strictEqual(prepared.checkPathAccess(ordinary).allowed, true);
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
