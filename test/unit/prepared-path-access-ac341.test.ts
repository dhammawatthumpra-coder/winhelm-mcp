import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { checkFolderAccess, prepareFolderAccessContext } from "../../src/permissions/folder-access.js";
import { buildProtectedPathRules } from "../../src/permissions/protected-paths.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";

let tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeV2Config(folders: Array<{ path: string; permission: "read" | "readwrite" }>) {
  const base = buildPresetConfig("balanced", { folders: folders.map((f) => f.path) });
  base.folders = folders.map((f) => ({ path: f.path, permission: f.permission }));
  return base;
}

afterEach(async () => {
  ConfigManager.resetInstance();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

describe("AC-3.4.1 Prepared Path Access Security Equivalence", () => {
  it("1. allowed read produces identical results in prepared and direct modes", async () => {
    const root = await createTempDir("ac341-read-");
    const testFile = path.join(root, "file.txt");
    await fs.writeFile(testFile, "content", "utf8");

    const config = makeV2Config([{ path: root, permission: "readwrite" }]);
    const manager = ConfigManager.resetInstance();
    await manager.updateConfig(config as any, false);

    const direct = manager.checkPathAccess(testFile, "read");
    const preparedContext = manager.preparePathAccessContext("read");
    const prepared = preparedContext.checkPathAccess(testFile);

    assert.strictEqual(direct.allowed, true);
    assert.strictEqual(prepared.allowed, true);
    assert.strictEqual(direct.code, prepared.code);
  });

  it("2. allowed write produces identical results in prepared and direct modes", async () => {
    const root = await createTempDir("ac341-write-");
    const testFile = path.join(root, "file.txt");
    await fs.writeFile(testFile, "content", "utf8");

    const config = makeV2Config([{ path: root, permission: "readwrite" }]);
    const manager = ConfigManager.resetInstance();
    await manager.updateConfig(config as any, false);

    const direct = manager.checkPathAccess(testFile, "write");
    const preparedContext = manager.preparePathAccessContext("write");
    const prepared = preparedContext.checkPathAccess(testFile);

    assert.strictEqual(direct.allowed, true);
    assert.strictEqual(prepared.allowed, true);
    assert.strictEqual(direct.code, prepared.code);
  });

  it("3. read-only write denial is enforced identically in prepared context", async () => {
    const root = await createTempDir("ac341-ro-");
    const testFile = path.join(root, "file.txt");
    await fs.writeFile(testFile, "content", "utf8");

    const config = makeV2Config([{ path: root, permission: "read" }]);
    const manager = ConfigManager.resetInstance();
    await manager.updateConfig(config as any, false);

    const direct = manager.checkPathAccess(testFile, "write");
    const preparedContext = manager.preparePathAccessContext("write");
    const prepared = preparedContext.checkPathAccess(testFile);

    assert.strictEqual(direct.allowed, false);
    assert.strictEqual(prepared.allowed, false);
    assert.strictEqual(direct.code, "FOLDER_READ_ONLY");
    assert.strictEqual(prepared.code, "FOLDER_READ_ONLY");
  });

  it("4. outside-folder denial is enforced identically in prepared context", async () => {
    const root = await createTempDir("ac341-in-");
    const outside = await createTempDir("ac341-out-");
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "secret", "utf8");

    const config = makeV2Config([{ path: root, permission: "readwrite" }]);
    const manager = ConfigManager.resetInstance();
    await manager.updateConfig(config as any, false);

    const direct = manager.checkPathAccess(outsideFile, "read");
    const preparedContext = manager.preparePathAccessContext("read");
    const prepared = preparedContext.checkPathAccess(outsideFile);

    assert.strictEqual(direct.allowed, false);
    assert.strictEqual(prepared.allowed, false);
    assert.strictEqual(direct.code, "FOLDER_NOT_APPROVED");
    assert.strictEqual(prepared.code, "FOLDER_NOT_APPROVED");
  });

  it("5. overlapping roots: most-specific folder wins in prepared context", async () => {
    const parentRoot = await createTempDir("ac341-parent-");
    const childRoot = path.join(parentRoot, "child-readonly");
    await fs.mkdir(childRoot);
    const childFile = path.join(childRoot, "data.txt");
    await fs.writeFile(childFile, "data", "utf8");

    const config = makeV2Config([
      { path: parentRoot, permission: "readwrite" },
      { path: childRoot, permission: "read" },
    ]);
    const manager = ConfigManager.resetInstance();
    await manager.updateConfig(config as any, false);

    const direct = manager.checkPathAccess(childFile, "write");
    const preparedContext = manager.preparePathAccessContext("write");
    const prepared = preparedContext.checkPathAccess(childFile);

    assert.strictEqual(direct.allowed, false);
    assert.strictEqual(prepared.allowed, false);
    assert.strictEqual(direct.code, "FOLDER_READ_ONLY");
    assert.strictEqual(prepared.code, "FOLDER_READ_ONLY");
  });

  it("6. protected file blocks exact file in prepared context", async () => {
    const root = await createTempDir("ac341-prot-file-");
    const configFile = path.join(root, "winhelm.config.json");
    const ordinaryFile = path.join(root, "ordinary.txt");
    await fs.writeFile(configFile, "{}", "utf8");
    await fs.writeFile(ordinaryFile, "hello", "utf8");

    const rules = buildProtectedPathRules({
      configFilePath: configFile,
      dataDir: path.join(root, "dummy-data"),
    });
    const folders = [{ path: root, permission: "readwrite" as const }];

    const prep = prepareFolderAccessContext(folders, rules);

    const directBlocked = checkFolderAccess(configFile, "read", folders, { protectedPaths: rules });
    const prepBlocked = checkFolderAccess(configFile, "read", folders, { preparedContext: prep });
    assert.strictEqual(directBlocked.allowed, false);
    assert.strictEqual(prepBlocked.allowed, false);
    assert.strictEqual(directBlocked.code, "FOLDER_PROTECTED_PATH");
    assert.strictEqual(prepBlocked.code, "FOLDER_PROTECTED_PATH");

    const directAllowed = checkFolderAccess(ordinaryFile, "read", folders, { protectedPaths: rules });
    const prepAllowed = checkFolderAccess(ordinaryFile, "read", folders, { preparedContext: prep });
    assert.strictEqual(directAllowed.allowed, true);
    assert.strictEqual(prepAllowed.allowed, true);
  });

  it("7. protected tree blocks descendants in prepared context", async () => {
    const root = await createTempDir("ac341-prot-tree-");
    const dataDir = path.join(root, "protected-data");
    await fs.mkdir(dataDir);
    const childFile = path.join(dataDir, "token.json");
    await fs.writeFile(childFile, "secret", "utf8");

    const rules = buildProtectedPathRules({
      configFilePath: path.join(root, "config.json"),
      dataDir,
    });
    const folders = [{ path: root, permission: "readwrite" as const }];

    const prep = prepareFolderAccessContext(folders, rules);

    const direct = checkFolderAccess(childFile, "read", folders, { protectedPaths: rules });
    const prepared = checkFolderAccess(childFile, "read", folders, { preparedContext: prep });

    assert.strictEqual(direct.allowed, false);
    assert.strictEqual(prepared.allowed, false);
    assert.strictEqual(direct.code, "FOLDER_PROTECTED_PATH");
    assert.strictEqual(prepared.code, "FOLDER_PROTECTED_PATH");
  });

  it("8. install-root protection is enforced identically in prepared context", async () => {
    const root = await createTempDir("ac341-install-");
    const config = makeV2Config([{ path: root, permission: "readwrite" }]);
    (config as any).development = { installRootAccess: "none" };
    const manager = ConfigManager.resetInstance();
    await manager.updateConfig(config as any, false);

    const installRoot = path.resolve(process.cwd());
    const installTarget = path.join(installRoot, "package.json");

    const direct = manager.checkPathAccess(installTarget, "read");
    const preparedContext = manager.preparePathAccessContext("read");
    const prepared = preparedContext.checkPathAccess(installTarget);

    assert.strictEqual(direct.allowed, false);
    assert.strictEqual(prepared.allowed, false);
  });

  it("9. invalid config fails closed in prepared context", async () => {
    const root = await createTempDir("ac341-invalid-");
    const target = path.join(root, "test.txt");
    await fs.writeFile(target, "content", "utf8");

    const configFile = path.join(root, "invalid.json");
    // Invalid schemaVersion sets configMode to invalid
    await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 999 }), "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    assert.strictEqual(manager.getConfigMode(), "invalid");

    const direct = manager.checkPathAccess(target, "read");
    const preparedContext = manager.preparePathAccessContext("read");
    const prepared = preparedContext.checkPathAccess(target);

    assert.strictEqual(direct.allowed, false);
    assert.strictEqual(prepared.allowed, false);
    assert.strictEqual(direct.code, "CONFIG_INVALID");
    assert.strictEqual(prepared.code, "CONFIG_INVALID");
  });

  it("10. reparse mutation denial is evaluated per-target even with prepared context", async () => {
    if (process.platform !== "win32") return;
    const root = await createTempDir("ac341-reparse-");
    const targetDir = path.join(root, "real");
    const linkDir = path.join(root, "link");
    await fs.mkdir(targetDir);

    try {
      await fs.symlink(targetDir, linkDir, "junction");
    } catch {
      return; // unprivileged junction creation fallback
    }

    const testFile = path.join(linkDir, "write.txt");

    const config = makeV2Config([{ path: root, permission: "readwrite" }]);
    const manager = ConfigManager.resetInstance();
    await manager.updateConfig(config as any, false);

    const direct = manager.checkPathAccess(testFile, "write", { rejectReparseMutation: true });
    const preparedContext = manager.preparePathAccessContext("write", { rejectReparseMutation: true });
    const prepared = preparedContext.checkPathAccess(testFile);

    assert.strictEqual(direct.allowed, false);
    assert.strictEqual(prepared.allowed, false);
    assert.strictEqual(direct.code, "FOLDER_REPARSE_MUTATION");
    assert.strictEqual(prepared.code, "FOLDER_REPARSE_MUTATION");
  });

  it("11. canonical path case behavior on Windows matches in prepared context", async () => {
    const root = await createTempDir("ac341-case-");
    const testFile = path.join(root, "MixedCaseFile.TXT");
    await fs.writeFile(testFile, "content", "utf8");

    const config = makeV2Config([{ path: root, permission: "read" }]);
    const manager = ConfigManager.resetInstance();
    await manager.updateConfig(config as any, false);

    const lowerTarget = path.join(root, "mixedcasefile.txt");
    const upperTarget = path.join(root, "MIXEDCASEFILE.TXT");

    const preparedContext = manager.preparePathAccessContext("read");

    const resLower = preparedContext.checkPathAccess(lowerTarget);
    const resUpper = preparedContext.checkPathAccess(upperTarget);

    assert.strictEqual(resLower.allowed, true);
    assert.strictEqual(resUpper.allowed, true);
  });

  it("12. config change/reload takes effect immediately without cross-call stale context", async () => {
    const folderA = await createTempDir("ac341-folder-a-");
    const folderB = await createTempDir("ac341-folder-b-");
    const fileA = path.join(folderA, "a.txt");
    const fileB = path.join(folderB, "b.txt");
    await fs.writeFile(fileA, "content A", "utf8");
    await fs.writeFile(fileB, "content B", "utf8");

    const manager = ConfigManager.resetInstance();

    // Initial config: only folderA allowed
    await manager.updateConfig(makeV2Config([{ path: folderA, permission: "read" }]) as any, false);

    const batch1 = manager.preparePathAccessContext("read");
    assert.strictEqual(batch1.checkPathAccess(fileA).allowed, true);
    assert.strictEqual(batch1.checkPathAccess(fileB).allowed, false);

    // Update config: remove folderA, add folderB
    await manager.updateConfig(makeV2Config([{ path: folderB, permission: "read" }]) as any, false);

    // Next batch call must immediately see updated config with no stale context
    const batch2 = manager.preparePathAccessContext("read");
    assert.strictEqual(batch2.checkPathAccess(fileA).allowed, false);
    assert.strictEqual(batch2.checkPathAccess(fileB).allowed, true);
  });
});
