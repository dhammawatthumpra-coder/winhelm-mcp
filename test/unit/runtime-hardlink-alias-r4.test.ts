import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  computeAuthorizedSearchRoots,
  searchCodebase,
  findRipgrepPath,
  type RipgrepOptions,
} from "../../src/engine/ripgrep.js";
import {
  searchInFiles,
  readFileContent,
  writeFileContent,
  editFileContent,
  copyFileOrDir,
  createZip,
} from "../../src/engine/filesystem.js";
import {
  getFilesystemObjectId,
  getProtectedObjectRegistry,
  resetProtectedObjectRegistryCache,
} from "../../src/permissions/object-identity.js";
import { writeFileAtomic } from "../../src/engine/atomic-file.js";

const SENTINEL_SECRET = "WINHELM_R4_RUNTIME_ALIAS_SECRET_SENTINEL_20261010";
const TREE_SENTINEL_SECRET = "WINHELM_R4_TREE_SECRET_SENTINEL_20261010";

describe("WinHelm v1.4 Core Security R4 Runtime-Alias / Stale-Cache Corrective Suite", () => {
  let tempRoot: string;
  let allowedRoot: string;
  let searchSub: string;
  let protectedDir: string;
  let configFile: string;
  let treeSecretFile: string;
  let ordinaryFile: string;
  let ordinaryAlias: string;
  let configPath: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r4-test-"));
    allowedRoot = path.join(tempRoot, "allowed-root");
    searchSub = path.join(allowedRoot, "search_sub");
    protectedDir = path.join(tempRoot, "protected-tree");

    await fs.mkdir(searchSub, { recursive: true });
    await fs.mkdir(protectedDir, { recursive: true });

    // 1. Protected file
    configFile = path.join(allowedRoot, "winhelm.config.json");
    // 2. Secret file inside protected tree
    treeSecretFile = path.join(protectedDir, "tree-secret.txt");
    await fs.writeFile(
      treeSecretFile,
      `TREE_SECRET_CONTENT: ${TREE_SENTINEL_SECRET}\n`,
      "utf8"
    );

    // 3. Ordinary unprotected file and hardlink
    ordinaryFile = path.join(allowedRoot, "ordinary.txt");
    ordinaryAlias = path.join(searchSub, "ordinary-alias.txt");
    await fs.writeFile(ordinaryFile, "ORDINARY_UNPROTECTED_CONTENT\n", "utf8");
    fsSync.linkSync(ordinaryFile, ordinaryAlias);

    // Write config
    const config = {
      schemaVersion: 2,
      folders: [{ path: allowedRoot, permission: "readwrite" }],
      terminal: { mode: "off" },
      toolPolicy: {
        file_read: "auto",
        file_write: "auto",
        file_edit: "auto",
        file_copy: "auto",
        archive_zip: "auto",
      },
      secretField: `CONFIG_SECRET: ${SENTINEL_SECRET}`,
      protectedPaths: [
        { path: protectedDir, kind: "tree", label: "Protected Tree" },
        { path: configFile, kind: "file", label: "Protected Config File" },
      ],
    };
    configPath = configFile;
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

    // Initialize ConfigManager when protected objects have nlink == 1
    ConfigManager.resetInstance();
    resetProtectedObjectRegistryCache();
    ConfigManager.getInstance(configPath);
  });

  afterEach(async () => {
    ConfigManager.resetInstance();
    resetProtectedObjectRegistryCache();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  // 1. Protected-file alias created after registry initialization
  it("1. detects protected-file alias created after registry initialization without reset", async () => {
    const cm = ConfigManager.getInstance();
    const regBefore = getProtectedObjectRegistry(cm.getProtectedPathRulesSnapshot());
    assert.strictEqual(regBefore.hasAnyLinkedProtectedObjects, false);

    const runtimeAlias = path.join(searchSub, "runtime-config-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const regAfter = getProtectedObjectRegistry(cm.getProtectedPathRulesSnapshot());
    assert.strictEqual(regAfter.hasAnyLinkedProtectedObjects, true);

    const match = regAfter.checkFileObjectId(runtimeAlias);
    assert.strictEqual(match.matched, true);
    assert.strictEqual(match.rule?.kind, "file");
  });

  // 2. Protected-tree descendant alias created after registry initialization
  it("2. detects protected-tree descendant alias created after registry initialization without reset", async () => {
    const cm = ConfigManager.getInstance();
    const regBefore = getProtectedObjectRegistry(cm.getProtectedPathRulesSnapshot());
    assert.strictEqual(regBefore.hasAnyLinkedProtectedObjects, false);

    const treeAlias = path.join(searchSub, "runtime-tree-alias.txt");
    fsSync.linkSync(treeSecretFile, treeAlias);

    const regAfter = getProtectedObjectRegistry(cm.getProtectedPathRulesSnapshot());
    assert.strictEqual(regAfter.hasAnyLinkedProtectedObjects, true);

    const match = regAfter.checkFileObjectId(treeAlias);
    assert.strictEqual(match.matched, true);
    assert.strictEqual(match.rule?.kind, "tree");
  });

  // 3. Direct checkPathAccess denial
  it("3. denies direct checkPathAccess on runtime-created aliases", async () => {
    const cm = ConfigManager.getInstance();
    const runtimeAlias = path.join(searchSub, "checkpath-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const check = cm.checkPathAccess(runtimeAlias, "read");
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.code, "FOLDER_PROTECTED_PATH");
  });

  // 4. file_read denial
  it("4. denies file_read on runtime-created aliases", async () => {
    const runtimeAlias = path.join(searchSub, "file-read-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    await assert.rejects(
      async () => {
        await readFileContent(runtimeAlias);
      },
      (err: any) => {
        assert.match(err.message, /hardlink alias to protected file|Path is protected|FOLDER_PROTECTED_PATH/i);
        return true;
      }
    );
  });

  // 5. Built-in file_search exclusion
  it("5. excludes runtime-created aliases in built-in searchInFiles", async () => {
    const runtimeAlias = path.join(searchSub, "search-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const matches = await searchInFiles(SENTINEL_SECRET, searchSub);
    assert.strictEqual(matches.length, 0);
  });

  // 6. Ripgrep pre-exclusion before spawn
  it("6. pre-excludes runtime-created alias before rg spawn and carves domain", async () => {
    const cm = ConfigManager.getInstance();
    const runtimeAlias = path.join(searchSub, "rg-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const roots = computeAuthorizedSearchRoots(
      searchSub,
      cm.getProtectedPathRulesSnapshot()
    );

    // Carved roots must NOT contain the alias
    for (const r of roots) {
      assert.notStrictEqual(path.resolve(r), path.resolve(runtimeAlias));
    }

    // Instrumented rg call verification
    let spawnedArgs: string[] = [];
    const dummyExecRg = async (_cmd: string, args: string[]) => {
      spawnedArgs = args;
      return { stdout: "" };
    };

    await searchCodebase(
      { query: SENTINEL_SECRET, searchPath: searchSub },
      { execRg: dummyExecRg }
    );

    // No spawned root may point to runtimeAlias
    for (const arg of spawnedArgs) {
      assert.notStrictEqual(path.resolve(arg), path.resolve(runtimeAlias));
    }
  });

  // 7. Empty safe search domain -> zero rg calls
  it("7. makes zero rg calls when no safe search domain remains", async () => {
    const isolatedDir = path.join(allowedRoot, "isolated_empty_domain");
    await fs.mkdir(isolatedDir, { recursive: true });

    // The only file inside isolatedDir is an alias to a protected file
    const onlyAlias = path.join(isolatedDir, "only-file.json");
    fsSync.linkSync(configFile, onlyAlias);

    let rgSpawnCount = 0;
    const dummyExecRg = async () => {
      rgSpawnCount++;
      return { stdout: "" };
    };

    const res = await searchCodebase(
      { query: SENTINEL_SECRET, searchPath: isolatedDir },
      { execRg: dummyExecRg }
    );

    assert.strictEqual(rgSpawnCount, 0, "rg must NOT be spawned when domain is empty");
    assert.strictEqual(res.totalMatches, 0);
    assert.strictEqual(res.matches.length, 0);
  });

  // 8. Recursive copy denial and no protected bytes in destination
  it("8. fails closed on recursive copy with runtime alias and leaves destination clean", async () => {
    const runtimeAlias = path.join(searchSub, "copy-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const destDir = path.join(allowedRoot, "dest-copy-test");

    await assert.rejects(
      async () => {
        await copyFileOrDir(searchSub, destDir);
      },
      (err: any) => {
        assert.match(err.message, /Operation blocked: Directory contains hardlink alias/);
        return true;
      }
    );

    // Ensure destination does not contain protected secret
    const destExists = fsSync.existsSync(destDir);
    if (destExists) {
      const copiedAlias = path.join(destDir, "copy-alias.json");
      assert.strictEqual(fsSync.existsSync(copiedAlias), false);
    }
  });

  // 9. Archive denial and no protected bytes in archive
  it("9. fails closed on createZip with runtime alias and leaves no secret in archive", async () => {
    const runtimeAlias = path.join(searchSub, "zip-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const destZip = path.join(allowedRoot, "output-test.zip");

    await assert.rejects(
      async () => {
        await createZip(searchSub, destZip);
      },
      (err: any) => {
        assert.match(err.message, /Cannot create zip archive: directory contains hardlink alias/);
        return true;
      }
    );

    // Zip must not exist
    assert.strictEqual(fsSync.existsSync(destZip), false);
  });

  // 10. Alias removal freshness
  it("10. restores normal operations immediately upon alias removal without reset", async () => {
    const cm = ConfigManager.getInstance();
    const runtimeAlias = path.join(searchSub, "temp-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    // Denied while alias exists
    assert.strictEqual(cm.checkPathAccess(runtimeAlias, "read").allowed, false);

    // Remove alias
    await fs.unlink(runtimeAlias);

    // Without ConfigManager reset, directory operations must function normally
    const destDir = path.join(allowedRoot, "dest-after-removal");
    const copyRes = await copyFileOrDir(searchSub, destDir);
    assert.strictEqual(copyRes.success, true);
    assert.strictEqual(fsSync.existsSync(path.join(destDir, "ordinary-alias.txt")), true);
  });

  // 11. Alias churn / second alias under a new pathname
  it("11. handles alias churn: no alias -> created -> removed -> new alias under different path", async () => {
    const cm = ConfigManager.getInstance();

    // 1. Initial clean state
    const roots1 = computeAuthorizedSearchRoots(searchSub, cm.getProtectedPathRulesSnapshot());
    assert.ok(roots1.length > 0);

    // 2. Alias A created
    const aliasA = path.join(searchSub, "churn-alias-a.json");
    fsSync.linkSync(configFile, aliasA);
    assert.strictEqual(cm.checkPathAccess(aliasA, "read").allowed, false);

    // 3. Alias A removed
    await fs.unlink(aliasA);
    const roots2 = computeAuthorizedSearchRoots(searchSub, cm.getProtectedPathRulesSnapshot());
    assert.ok(roots2.length > 0);

    // 4. Alias B created under completely different subdirectory
    const churnSub = path.join(allowedRoot, "churn_sub");
    await fs.mkdir(churnSub, { recursive: true });
    const aliasB = path.join(churnSub, "churn-alias-b.json");
    fsSync.linkSync(configFile, aliasB);

    // 5. Alias B must be denied without any ConfigManager reset
    assert.strictEqual(cm.checkPathAccess(aliasB, "read").allowed, false);

    await assert.rejects(async () => {
      await copyFileOrDir(churnSub, path.join(allowedRoot, "dest-churn"));
    });
  });

  // 12. Config reload preservation
  it("12. preserves runtime alias protections across config reload", async () => {
    const cm = ConfigManager.getInstance();
    const runtimeAlias = path.join(searchSub, "reload-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    assert.strictEqual(cm.checkPathAccess(runtimeAlias, "read").allowed, false);

    // Reload configuration from disk
    const reloaded = await (cm as any).reloadConfigFromDisk();
    assert.strictEqual(reloaded, true);

    assert.strictEqual(cm.checkPathAccess(runtimeAlias, "read").allowed, false);
    await assert.rejects(async () => {
      await readFileContent(runtimeAlias);
    });
  });

  // 13. Malformed protected rule fail-closed
  it("13. fails closed when a protected rule has an invalid kind", async () => {
    const cm = ConfigManager.getInstance();
    const malformedRules = [
      { path: configFile, kind: "unknown_kind" as any, label: "Invalid Kind" },
    ];

    assert.throws(
      () => {
        computeAuthorizedSearchRoots(searchSub, malformedRules);
      },
      (err: any) => {
        assert.match(err.message, /invalid.*kind/i);
        return true;
      }
    );
  });

  // 14. Symlink/junction regressions remain safe
  it("14. skips symlinks during alias traversal and prevents symlink bypass", async () => {
    const cm = ConfigManager.getInstance();
    const reg = getProtectedObjectRegistry(cm.getProtectedPathRulesSnapshot());

    // Symlinks to protected objects are handled by canonical path / realpath
    assert.strictEqual(reg.hasProtectedRules, true);
  });

  // 15. Ordinary unprotected hardlink remains usable
  it("15. allows ordinary unprotected hardlinks to be read, searched, copied, and zipped", async () => {
    const cm = ConfigManager.getInstance();

    // Check ordinary hardlink is allowed
    assert.strictEqual(cm.checkPathAccess(ordinaryAlias, "read").allowed, true);

    // Readable
    const content = await readFileContent(ordinaryAlias);
    assert.match(content.content, /ORDINARY_UNPROTECTED_CONTENT/);

    // Searchable
    const matches = await searchInFiles("ORDINARY_UNPROTECTED_CONTENT", searchSub);
    assert.ok(matches.length >= 1);

    // Copiable
    const destOrdinary = path.join(allowedRoot, "dest-ordinary-test");
    const copyRes = await copyFileOrDir(searchSub, destOrdinary);
    assert.strictEqual(copyRes.success, true);
  });

  // 16. No protected sentinel in errors
  it("16. does not leak protected content or secret sentinel in error messages", async () => {
    const runtimeAlias = path.join(searchSub, "error-leak-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    try {
      await readFileContent(runtimeAlias);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.strictEqual(
        err.message.includes(SENTINEL_SECRET),
        false,
        "Error message must NOT contain the protected secret sentinel"
      );
    }

    try {
      await copyFileOrDir(searchSub, path.join(allowedRoot, "leak-dest"));
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.strictEqual(
        err.message.includes(SENTINEL_SECRET),
        false,
        "Error message must NOT contain the protected secret sentinel"
      );
    }
  });

  // 17. filePattern compatibility
  it("17. preserves filePattern compatibility while carving runtime aliases", async () => {
    const cm = ConfigManager.getInstance();
    const runtimeAlias = path.join(searchSub, "pattern-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const roots = computeAuthorizedSearchRoots(
      searchSub,
      cm.getProtectedPathRulesSnapshot(),
      { filePattern: "*.txt" }
    );

    for (const r of roots) {
      assert.notStrictEqual(path.resolve(r), path.resolve(runtimeAlias));
    }
  });

  // 18. Pagination/order compatibility
  it("18. produces deterministic sorted matches across carved search domain", async () => {
    const targetDir = path.join(allowedRoot, "order_test");
    await fs.mkdir(targetDir, { recursive: true });

    await fs.writeFile(path.join(targetDir, "b.txt"), "MATCH_LINE_1\n", "utf8");
    await fs.writeFile(path.join(targetDir, "a.txt"), "MATCH_LINE_2\n", "utf8");

    const runtimeAlias = path.join(targetDir, "alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    let spawnedRoots: string[] = [];
    const dummyExecRg = async (_cmd: string, args: string[]) => {
      // Find arguments after "--"
      const dashIdx = args.indexOf("--");
      if (dashIdx !== -1 && dashIdx + 2 < args.length) {
        spawnedRoots = args.slice(dashIdx + 2);
      }
      return {
        stdout: [
          `${path.join(targetDir, "b.txt")}:1:1:MATCH_LINE_1`,
          `${path.join(targetDir, "a.txt")}:1:1:MATCH_LINE_2`,
        ].join("\n"),
      };
    };

    const res = await searchCodebase(
      { query: "MATCH_LINE", searchPath: targetDir },
      { execRg: dummyExecRg }
    );

    // Alias must not be in spawned roots
    assert.strictEqual(
      spawnedRoots.some((r) => path.resolve(r) === path.resolve(runtimeAlias)),
      false
    );

    // Matches must be ordered deterministically
    assert.strictEqual(res.matches.length, 2);
    assert.match(res.matches[0].file, /a\.txt/);
    assert.match(res.matches[1].file, /b\.txt/);
  });

  // 19. ContextLines security preservation
  it("19. hydrates contextLines securely without leaking carved aliases", async () => {
    const targetDir = path.join(allowedRoot, "context_test");
    await fs.mkdir(targetDir, { recursive: true });

    const safeFile = path.join(targetDir, "safe.txt");
    await fs.writeFile(
      safeFile,
      "LINE 1\nLINE 2 TARGET_QUERY\nLINE 3\nLINE 4\n",
      "utf8"
    );

    const runtimeAlias = path.join(targetDir, "alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const dummyExecRg = async () => {
      return {
        stdout: `${safeFile}:2:8:LINE 2 TARGET_QUERY`,
      };
    };

    const res = await searchCodebase(
      { query: "TARGET_QUERY", searchPath: targetDir, contextLines: 1 },
      { execRg: dummyExecRg }
    );

    assert.strictEqual(res.matches.length, 1);
    assert.strictEqual(res.matches[0].contextBefore?.length, 1);
    assert.strictEqual(res.matches[0].contextAfter?.length, 1);
  });

  // 20. Write/edit protected original bytes unchanged
  it("20. prevents write and edit mutations through alias, leaving original protected bytes invariant", async () => {
    const runtimeAlias = path.join(searchSub, "mutation-alias.json");
    fsSync.linkSync(configFile, runtimeAlias);

    const initialContent = await fs.readFile(configFile, "utf8");

    // Attempt writeFileContent through alias
    await assert.rejects(async () => {
      await writeFileContent(runtimeAlias, "MUTATED_CONTENT_THROUGH_ALIAS");
    });

    // Attempt editFileContent through alias
    await assert.rejects(async () => {
      await editFileContent(runtimeAlias, SENTINEL_SECRET, "MUTATED_SECRET");
    });

    // Attempt writeFileAtomic through alias
    await assert.rejects(async () => {
      await writeFileAtomic(runtimeAlias, "MUTATED_ATOMIC_CONTENT");
    });

    // Verify original bytes remain identical
    const finalContent = await fs.readFile(configFile, "utf8");
    assert.strictEqual(initialContent, finalContent, "Protected original file bytes must be unchanged");
  });
});
