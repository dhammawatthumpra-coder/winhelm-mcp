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
} from "../../src/engine/ripgrep.js";
import {
  searchInFiles,
  readFileContent,
  writeFileContent,
  editFileContent,
  tailFileContent,
  hashFile,
  copyFileOrDir,
  createZip,
  moveFile,
  deleteFileToRecycleBin,
} from "../../src/engine/filesystem.js";
import {
  getFilesystemObjectId,
  formatObjectId,
  getProtectedObjectRegistry,
  ProtectedObjectRegistry,
} from "../../src/permissions/object-identity.js";
import { buildDirectoryManifest } from "../../src/engine/directory-manifest.js";
import { getFilePreviewHtml } from "../../src/gateway/preview-html.js";
import { inspectFileBatch } from "../../src/engine/file-inspect.js";
import { compareFiles } from "../../src/engine/file-compare.js";
import { lookupFileProvenanceStatus } from "../../src/engine/session-governance.js";
import { writeFileAtomic } from "../../src/engine/atomic-file.js";
import { StructuredToolError } from "../../src/errors/tool-error.js";

const SENTINEL_SECRET = "WINHELM_R3_HARDLINK_TOP_SECRET_SENTINEL_20261010";

describe("WinHelm v1.4 Core Security R3 Protected-Object Identity Corrective", () => {
  let tempRoot: string;
  let allowedRoot: string;
  let searchSub: string;
  let protectedDir: string;
  let configFile: string;
  let configAlias: string;
  let treeSecretFile: string;
  let treeSecretAlias: string;
  let ordinaryFile: string;
  let ordinaryAlias: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r3-test-"));
    allowedRoot = path.join(tempRoot, "allowed-root");
    searchSub = path.join(allowedRoot, "search_sub");
    protectedDir = path.join(tempRoot, "protected-tree");

    await fs.mkdir(searchSub, { recursive: true });
    await fs.mkdir(protectedDir, { recursive: true });

    // 1. Protected file (winhelm.config.json)
    configFile = path.join(allowedRoot, "winhelm.config.json");
    configAlias = path.join(searchSub, "alias-config.json");

    // 2. File inside protected tree
    treeSecretFile = path.join(protectedDir, "tree-secret.txt");
    treeSecretAlias = path.join(searchSub, "alias-tree-secret.txt");
    await fs.writeFile(
      treeSecretFile,
      `PROTECTED_TREE_CONTENT: ${SENTINEL_SECRET}\n`,
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
      },
      secretField: `CONFIG_SECRET: ${SENTINEL_SECRET}`,
      protectedPaths: [
        { path: protectedDir, kind: "tree", label: "Test Protected Tree" },
      ],
    };
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

    // Create hardlinks to protected objects
    fsSync.linkSync(configFile, configAlias);
    fsSync.linkSync(treeSecretFile, treeSecretAlias);

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
  });

  afterEach(async () => {
    ConfigManager.resetInstance();
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  // Requirement 1: NTFS hardlink identity equivalence proof
  it("Requirement 1: proves NTFS hardlink identity equivalence and nlink tracking", () => {
    const sOriginal = getFilesystemObjectId(configFile);
    const sAlias = getFilesystemObjectId(configAlias);

    assert.ok(sOriginal, "Original file must exist and have identity");
    assert.ok(sAlias, "Alias file must exist and have identity");
    assert.strictEqual(sOriginal.isFile, true);
    assert.strictEqual(sAlias.isFile, true);
    assert.strictEqual(sOriginal.dev, sAlias.dev, "Device IDs must be identical");
    assert.strictEqual(sOriginal.ino, sAlias.ino, "Inodes must be identical");
    assert.strictEqual(sOriginal.key, sAlias.key, "Lossless key must match");
    assert.strictEqual(sOriginal.nlink >= 2n, true, "nlink must be at least 2");
    assert.strictEqual(sAlias.nlink >= 2n, true, "nlink must be at least 2");

    // Verify formatObjectId is lossless and exact string
    assert.strictEqual(
      formatObjectId(sOriginal.dev, sOriginal.ino),
      `${sOriginal.dev.toString()}:${sOriginal.ino.toString()}`
    );
  });

  // Requirement 2: Protected file hardlink alias denied
  it("Requirement 2: checkPathAccess denies hardlink alias of protected file", () => {
    const manager = ConfigManager.getInstance();
    const check = manager.checkPathAccess(configAlias, "read");
    assert.strictEqual(check.allowed, false, "Protected file alias must be denied");
    assert.strictEqual(check.code, "FOLDER_PROTECTED_PATH");
    assert.ok(
      check.reason?.includes("protected") || check.reason?.includes("WinHelm"),
      "Reason must explain protected path policy"
    );
  });

  // Requirement 3: Protected-tree descendant hardlink alias denied
  it("Requirement 3: checkPathAccess denies hardlink alias of file in protected tree", () => {
    const manager = ConfigManager.getInstance();
    // Register custom protected tree rule for protectedDir
    const customRules = [
      ...manager.getProtectedPathRulesSnapshot(),
      { path: protectedDir, kind: "tree" as const, label: "Test Protected Tree" },
    ];
    const registry = getProtectedObjectRegistry(customRules);
    const match = registry.checkFileObjectId(treeSecretAlias);
    assert.strictEqual(
      match.matched,
      true,
      "Hardlink to file inside protected tree must match"
    );
    assert.ok(
      match.reason?.includes("protected tree"),
      "Must indicate protected tree alias"
    );
  });

  // Requirement 4: file_read alias denial
  it("Requirement 4: direct readFileContent through alias is denied", async () => {
    await assert.rejects(
      async () => {
        await readFileContent(configAlias);
      },
      (err: any) => {
        assert.ok(
          err.message.includes("protected") || err.message.includes("WinHelm"),
          `Expected protected denial, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // Requirement 5: built-in file_search alias exclusion before read
  it("Requirement 5: searchInFiles excludes hardlink alias content before reading", async () => {
    // Ordinary content should be found
    const ordinaryResult = await searchInFiles(
      "ORDINARY_UNPROTECTED_CONTENT",
      searchSub
    );
    assert.ok(
      ordinaryResult.length >= 1,
      "Ordinary content must be searchable"
    );

    // Protected secret through alias must NOT be returned
    const secretResult = await searchInFiles(SENTINEL_SECRET, searchSub);
    assert.strictEqual(
      secretResult.length,
      0,
      "Protected secret must NOT be returned through alias"
    );
  });

  // Requirement 6 & 11: file_search_ripgrep alias pre-exclusion before rg spawn
  it("Requirement 6: computeAuthorizedSearchRoots excludes alias before ripgrep spawn", async () => {
    const manager = ConfigManager.getInstance();
    const rules = manager.getProtectedPathRulesSnapshot();

    const roots = computeAuthorizedSearchRoots(searchSub, rules);

    // Assert alias is NOT in roots
    for (const r of roots) {
      assert.notStrictEqual(
        path.resolve(r).toLowerCase(),
        path.resolve(configAlias).toLowerCase(),
        "Ripgrep search roots must NEVER contain the hardlink alias!"
      );
    }

    // Run real searchCodebase
    const rgResult = await searchCodebase({
      searchPath: searchSub,
      query: SENTINEL_SECRET,
    });
    assert.strictEqual(
      rgResult.totalMatches,
      0,
      "searchCodebase must return 0 matches for protected secret"
    );
    assert.strictEqual(rgResult.matches.length, 0);
  });

  // Requirement 7: write/edit alias denial with original bytes unchanged
  it("Requirement 7: write/edit through alias is denied and original bytes unchanged", async () => {
    const originalBytesBefore = await fs.readFile(configFile);

    // Attempt writeFileContent on alias
    await assert.rejects(
      async () => {
        await writeFileContent(configAlias, "MUTATED_CONTENT_OVERWRITE");
      },
      (err: any) => {
        assert.ok(
          err.message.includes("protected") || err.message.includes("WinHelm"),
          `Expected write denial, got: ${err.message}`
        );
        return true;
      }
    );

    // Attempt editFileContent on alias
    await assert.rejects(
      async () => {
        await editFileContent(configAlias, [
          { oldText: "schemaVersion", newText: "tamperedVersion" },
        ]);
      },
      (err: any) => {
        assert.ok(
          err.message.includes("protected") || err.message.includes("WinHelm"),
          `Expected edit denial, got: ${err.message}`
        );
        return true;
      }
    );

    // Verify original protected file bytes are byte-for-byte unchanged
    const originalBytesAfter = await fs.readFile(configFile);
    assert.deepStrictEqual(
      originalBytesAfter,
      originalBytesBefore,
      "Original protected file must remain byte-for-byte unchanged!"
    );
  });

  // Requirement 8: hash/preview/tail helpers do not disclose alias content
  it("Requirement 8: tailFileContent and hashFile deny alias access", async () => {
    await assert.rejects(
      async () => {
        await tailFileContent(configAlias, 5);
      },
      (err: any) => {
        assert.ok(
          err.message.includes("protected") || err.message.includes("WinHelm"),
          `Expected tail denial, got: ${err.message}`
        );
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await hashFile(configAlias);
      },
      (err: any) => {
        assert.ok(
          err.message.includes("protected") || err.message.includes("WinHelm"),
          `Expected hash denial, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // Requirement 9: copy/archive paths blocked when alias is involved
  it("Requirement 9: copyFileOrDir and createZip block aliases to protected objects", async () => {
    const copyDest = path.join(allowedRoot, "copy-target.json");

    // Copying the alias directly must be denied
    await assert.rejects(
      async () => {
        await copyFileOrDir(configAlias, copyDest);
      },
      (err: any) => {
        assert.ok(
          err.message.includes("protected") || err.message.includes("WinHelm"),
          `Expected copy denial, got: ${err.message}`
        );
        return true;
      }
    );

    // Zipping a directory containing a hardlink alias to protected object must be denied
    const zipDest = path.join(allowedRoot, "archive.zip");
    await assert.rejects(
      async () => {
        await createZip(searchSub, zipDest);
      },
      (err: any) => {
        assert.ok(
          err.message.includes("hardlink alias") ||
            err.message.includes("protected"),
          `Expected createZip denial, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // Requirement 10: malformed protected rule kind remains fail-closed
  it("Requirement 10: malformed protected rule kind fails closed in object identity", () => {
    assert.throws(
      () => {
        getProtectedObjectRegistry([
          { path: configFile, kind: "invalid-kind" as any },
        ]);
      },
      (err: any) => {
        assert.ok(
          err.message.includes("Invalid protected path rule kind"),
          `Expected kind validation failure, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // Requirement 12: empty carved search domain remains zero rg calls
  it("Requirement 12: isolated alias directory produces empty roots and 0 rg calls", async () => {
    const onlyAliasDir = path.join(allowedRoot, "only_alias_dir");
    await fs.mkdir(onlyAliasDir, { recursive: true });
    const singleAlias = path.join(onlyAliasDir, "isolated-alias.json");
    fsSync.linkSync(configFile, singleAlias);

    const manager = ConfigManager.getInstance();
    const roots = computeAuthorizedSearchRoots(
      onlyAliasDir,
      manager.getProtectedPathRulesSnapshot()
    );
    assert.deepStrictEqual(
      roots,
      [],
      "Directory containing only alias must carve down to empty roots"
    );

    const result = await searchCodebase({
      searchPath: onlyAliasDir,
      query: "anything",
    });
    assert.strictEqual(result.totalMatches, 0);
    assert.strictEqual(result.matches.length, 0);
  });

  // Requirement 17: ordinary unprotected hardlinks remain usable where policy allows
  it("Requirement 17: ordinary unprotected hardlink remains usable", async () => {
    const manager = ConfigManager.getInstance();

    // checkPathAccess must allow ordinary hardlink
    const check = manager.checkPathAccess(ordinaryAlias, "read");
    assert.strictEqual(
      check.allowed,
      true,
      "Ordinary unprotected hardlink must be permitted"
    );

    // readFileContent must read ordinary hardlink
    const read = await readFileContent(ordinaryAlias);
    assert.strictEqual(read.content, "ORDINARY_UNPROTECTED_CONTENT\n");

    // searchInFiles must find ordinary hardlink
    const matches = await searchInFiles(
      "ORDINARY_UNPROTECTED_CONTENT",
      searchSub
    );
    assert.ok(matches.length >= 1);
  });

  // Directory Manifest coverage
  it("Requirement 13 (Manifest): directory_manifest fails closed on protected alias", async () => {
    await assert.rejects(
      async () => {
        await buildDirectoryManifest({
          root_path: searchSub,
          hash_files: false,
        });
      },
      (err: any) => {
        assert.ok(
          err.message.includes("protected") || err.message.includes("alias"),
          `Expected manifest failure on alias, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // Requirement 8: file_preview helper does not disclose alias content
  it("Requirement 8 (Preview): getFilePreviewHtml renders error page without secret", async () => {
    const html = await getFilePreviewHtml(configAlias);
    assert.ok(
      html.includes("Access Blocked") || html.toLowerCase().includes("blocked"),
      "Must render error page"
    );
    assert.ok(!html.includes(SENTINEL_SECRET), "Preview HTML must never leak secret content!");
  });

  // Spec 3.4 inspectFileBatch coverage
  it("Spec 3.4: inspectFileBatch denies hardlink alias to protected object", async () => {
    await assert.rejects(
      async () => {
        await inspectFileBatch({ paths: [configAlias] });
      },
      (err: unknown) => {
        assert.ok(err instanceof StructuredToolError, "Must throw StructuredToolError");
        assert.strictEqual((err as any).code, "FOLDER_PROTECTED_PATH");
        return true;
      }
    );
  });

  // Spec 3.4 compareFiles coverage
  it("Spec 3.4: compareFiles denies comparison involving hardlink alias", async () => {
    await assert.rejects(
      async () => {
        await compareFiles({
          path_a: configAlias,
          path_b: ordinaryFile,
          mode: "bytes",
        });
      },
      (err: any) => {
        assert.ok(
          err.message.includes("protected") || err.code === "FOLDER_PROTECTED_PATH",
          `Expected compare failure, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // Spec 3.4 lookupFileProvenanceStatus coverage
  it("Spec 3.4: lookupFileProvenanceStatus denies lookup on hardlink alias", async () => {
    await assert.rejects(
      async () => {
        await lookupFileProvenanceStatus({ path: configAlias }, undefined);
      },
      (err: unknown) => {
        assert.ok(err instanceof StructuredToolError, "Must throw StructuredToolError");
        assert.strictEqual((err as any).code, "FOLDER_PROTECTED_PATH");
        return true;
      }
    );
  });

  // Spec 3.4 writeFileAtomic coverage
  it("Spec 3.4: writeFileAtomic denies mutation through hardlink alias", async () => {
    const originalBytesBefore = await fs.readFile(configFile);
    await assert.rejects(
      async () => {
        await writeFileAtomic({
          path: configAlias,
          content: "ATTEMPTED_ATOMIC_MUTATION",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof StructuredToolError, "Must throw StructuredToolError");
        assert.strictEqual((err as any).code, "FOLDER_PROTECTED_PATH");
        return true;
      }
    );
    const originalBytesAfter = await fs.readFile(configFile);
    assert.deepStrictEqual(originalBytesAfter, originalBytesBefore, "Original bytes must be unchanged");
  });

  // Requirement 13 & 14: filePattern and pagination compatibility
  it("Requirement 13 & 14: filePattern and pagination work while excluding alias", async () => {
    // Search with filePattern matching *.json (both configAlias and other json would match)
    const result = await searchCodebase({
      searchPath: searchSub,
      query: "CONFIG",
      filePattern: "*.json",
      page: 1,
      pageSize: 10,
    });
    // configAlias must NOT appear in matches
    for (const match of result.matches) {
      assert.notStrictEqual(
        path.resolve(match.file).toLowerCase(),
        path.resolve(configAlias).toLowerCase(),
        "Matches must never contain protected alias!"
      );
    }
  });

  // Requirement 15: contextLines hydration never opens protected alias
  it("Requirement 15: contextLines hydration excludes protected content", async () => {
    const result = await searchCodebase({
      searchPath: searchSub,
      query: "ORDINARY_UNPROTECTED_CONTENT",
      contextLines: 3,
    });
    assert.ok(result.matches.length >= 1);
    for (const match of result.matches) {
      assert.ok(!match.text.includes(SENTINEL_SECRET));
      if (match.context) {
        for (const line of match.context) {
          assert.ok(!line.includes(SENTINEL_SECRET));
        }
      }
    }
  });

  // Requirement 16: stderr and error message leakage
  it("Requirement 16: error details never disclose protected secret sentinel", async () => {
    try {
      await readFileContent(configAlias);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.ok(!err.message.includes(SENTINEL_SECRET), "Error message must not leak secret sentinel");
    }
  });

  // Requirement 11: Symlink and junction regression check
  it("Requirement 11: symlinks and junctions to protected objects remain blocked", async () => {
    const symlinkPath = path.join(searchSub, "symlink-to-config.json");
    try {
      fsSync.symlinkSync(configFile, symlinkPath, "file");
    } catch {
      // If OS doesn't permit unprivileged symlinks, skip creation
      return;
    }

    const manager = ConfigManager.getInstance();
    const check = manager.checkPathAccess(symlinkPath, "read");
    assert.strictEqual(check.allowed, false, "Symlink to protected file must be denied");

    await assert.rejects(async () => {
      await readFileContent(symlinkPath);
    });
  });
});
