import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkFolderAccess } from "../../src/permissions/folder-access.js";
import { buildProtectedPathRules } from "../../src/permissions/protected-paths.js";

describe("Schema-v2 protected paths", () => {
  it("blocks an exact protected config file without blocking ordinary siblings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-protected-file-"));
    try {
      const configFile = path.join(root, "winhelm.config.json");
      const sibling = path.join(root, "project.txt");
      await fs.writeFile(configFile, "{}", "utf-8");
      await fs.writeFile(sibling, "hello", "utf-8");

      const rules = buildProtectedPathRules({
        configFilePath: configFile,
        dataDir: path.join(root, ".winhelm-data"),
      });
      const folders = [{ path: root, permission: "readwrite" as const }];

      const blocked = checkFolderAccess(configFile, "read", folders, {
        protectedPaths: rules,
      });
      assert.strictEqual(blocked.allowed, false);
      assert.strictEqual(blocked.code, "FOLDER_PROTECTED_PATH");

      const allowed = checkFolderAccess(sibling, "read", folders, {
        protectedPaths: rules,
      });
      assert.strictEqual(allowed.allowed, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("blocks protected data/log/install trees for both read and write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-protected-tree-"));
    try {
      const dataDir = path.join(root, "data");
      const logDir = path.join(root, "logs");
      const installRoot = path.join(root, "install");
      await Promise.all([
        fs.mkdir(dataDir),
        fs.mkdir(logDir),
        fs.mkdir(installRoot),
      ]);

      const dataFile = path.join(dataDir, "secret.json");
      const logFile = path.join(logDir, "audit.log");
      const installFile = path.join(installRoot, "index.js");
      await Promise.all([
        fs.writeFile(dataFile, "secret", "utf-8"),
        fs.writeFile(logFile, "audit", "utf-8"),
        fs.writeFile(installFile, "code", "utf-8"),
      ]);

      const rules = buildProtectedPathRules({
        dataDir,
        logDir,
        installRoot,
      });
      const folders = [{ path: root, permission: "readwrite" as const }];

      for (const target of [dataFile, logFile, installFile]) {
        assert.strictEqual(
          checkFolderAccess(target, "read", folders, { protectedPaths: rules }).code,
          "FOLDER_PROTECTED_PATH"
        );
        assert.strictEqual(
          checkFolderAccess(target, "write", folders, { protectedPaths: rules }).code,
          "FOLDER_PROTECTED_PATH"
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cannot bypass a protected tree by reading through an in-root junction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-protected-link-"));
    const protectedDir = path.join(root, "protected");
    const link = path.join(root, "alias");
    await fs.mkdir(protectedDir);
    await fs.writeFile(path.join(protectedDir, "secret.txt"), "secret", "utf-8");

    try {
      await fs.symlink(protectedDir, link, "junction");
      const rules = buildProtectedPathRules({ dataDir: protectedDir });
      const result = checkFolderAccess(
        path.join(link, "secret.txt"),
        "read",
        [{ path: root, permission: "readwrite" }],
        { protectedPaths: rules }
      );

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.code, "FOLDER_PROTECTED_PATH");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates identical protected tree rules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-protected-dedupe-"));
    try {
      const rules = buildProtectedPathRules({
        dataDir: root,
        logDir: root,
        installRoot: root,
      });
      assert.strictEqual(rules.length, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
