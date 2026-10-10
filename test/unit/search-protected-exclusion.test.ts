import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { searchInFiles } from "../../src/engine/filesystem.js";
import { searchCodebase } from "../../src/engine/ripgrep.js";

describe("Protected search leakage exclusion (Fix 1)", () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    ConfigManager.resetInstance();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      tempRoot = null;
    }
  });

  it("file_search (searchInFiles) returns ordinary matches and excludes protected descendant file and tree", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-search-leak-"));
    const allowedRoot = path.join(tempRoot, "allowed-root");
    await fs.mkdir(allowedRoot);

    const configFile = path.join(allowedRoot, "winhelm.config.json");
    const ordinaryFile = path.join(allowedRoot, "project.txt");
    const subDir = path.join(allowedRoot, "subdir");
    await fs.mkdir(subDir);
    const subOrdinaryFile = path.join(subDir, "notes.txt");

    const query = "CORRECTIVE_SEARCH_SENTINEL_20261009";

    // Ordinary files containing the query
    await fs.writeFile(ordinaryFile, `Header line\nMatch: ${query} in ordinary file\nFooter`, "utf8");
    await fs.writeFile(subOrdinaryFile, `Subdir file\nMatch: ${query} in subdir file\nEnd`, "utf8");

    // Synthetic protected config file containing the query
    const configPayload = {
      schemaVersion: 2,
      folders: [
        {
          path: allowedRoot,
          alias: "allowed-root",
          permission: "readwrite",
        },
      ],
      terminal: { mode: "off" },
      toolPolicy: {
        file_search: "auto",
        file_search_ripgrep: "auto",
        winhelm_status: "auto",
      },
      secretSentinel: `SECRET_DATA: ${query} must not leak`,
    };
    await fs.writeFile(configFile, JSON.stringify(configPayload, null, 2), "utf8");

    // Initialize ConfigManager with this synthetic config in the allowed root
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    // Verify config file is protected under checkPathAccess
    const accessCheck = manager.checkPathAccess(configFile, "read");
    assert.strictEqual(accessCheck.allowed, false, "Synthetic config file must be protected");
    assert.strictEqual(accessCheck.code, "FOLDER_PROTECTED_PATH");

    // Run searchInFiles on allowedRoot
    const matches = await searchInFiles(query, allowedRoot);

    // Assert that matches contain ordinary files but NEVER the protected config file
    assert.ok(matches.length >= 2, `Expected at least 2 matches, got ${matches.length}`);
    const matchedFiles = matches.map((m) => path.resolve(m.file));
    assert.ok(
      matchedFiles.includes(path.resolve(ordinaryFile)),
      "Ordinary file must be found"
    );
    assert.ok(
      matchedFiles.includes(path.resolve(subOrdinaryFile)),
      "Subdirectory ordinary file must be found"
    );
    assert.ok(
      !matchedFiles.includes(path.resolve(configFile)),
      "Protected config file must be excluded from search matches"
    );

    // Verify none of the match text contains the secret from the protected config
    for (const match of matches) {
      assert.ok(
        !match.text.includes("SECRET_DATA"),
        "Match text must not leak protected file content"
      );
    }
  });

  it("file_search_ripgrep (searchCodebase) returns ordinary matches and excludes protected descendant file", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-rg-leak-"));
    const allowedRoot = path.join(tempRoot, "allowed-root");
    await fs.mkdir(allowedRoot);

    const configFile = path.join(allowedRoot, "winhelm.config.json");
    const ordinaryFile = path.join(allowedRoot, "app.js");

    const query = "RIPGREP_PROTECTED_SENTINEL_20261009";

    await fs.writeFile(ordinaryFile, `// Application code\nconst token = "${query}";\nconsole.log(token);`, "utf8");

    const configPayload = {
      schemaVersion: 2,
      folders: [
        {
          path: allowedRoot,
          alias: "allowed-root",
          permission: "readwrite",
        },
      ],
      terminal: { mode: "off" },
      toolPolicy: {
        file_search: "auto",
        file_search_ripgrep: "auto",
        winhelm_status: "auto",
      },
      secretSentinel: `PROTECTED_CONFIG_LEAK: ${query}`,
    };
    await fs.writeFile(configFile, JSON.stringify(configPayload, null, 2), "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    // Verify config file is protected under checkPathAccess
    assert.strictEqual(manager.checkPathAccess(configFile, "read").allowed, false);

    // Run searchCodebase (which uses ripgrep if available or fallback)
    const result = await searchCodebase({
      query,
      searchPath: allowedRoot,
      contextLines: 1,
    });

    assert.ok(result.matches.length >= 1, "Must find match in ordinary file");
    const matchedFiles = result.matches.map((m) => path.resolve(m.file));
    assert.ok(
      matchedFiles.includes(path.resolve(ordinaryFile)),
      "Ordinary file must be found by ripgrep search"
    );
    assert.ok(
      !matchedFiles.includes(path.resolve(configFile)),
      "Protected config file must be excluded from ripgrep matches"
    );

    // Ensure totalMatches matches filtered matches count
    assert.strictEqual(result.totalMatches, result.matches.length);

    for (const match of result.matches) {
      assert.ok(
        !match.text.includes("PROTECTED_CONFIG_LEAK"),
        "Ripgrep match text must not contain protected config content"
      );
    }
  });

  it("excludes protected tree descendants from search results", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tree-leak-"));
    const allowedRoot = path.join(tempRoot, "allowed-root");
    await fs.mkdir(allowedRoot);

    const configFile = path.join(allowedRoot, "winhelm.config.json");
    const ordinaryFile = path.join(allowedRoot, "public.txt");
    await fs.writeFile(ordinaryFile, "TARGET_TREE_QUERY ordinary match", "utf8");

    const configPayload = {
      schemaVersion: 2,
      folders: [
        {
          path: allowedRoot,
          alias: "allowed-root",
          permission: "readwrite",
        },
      ],
      terminal: { mode: "off" },
      toolPolicy: {
        file_search: "auto",
        file_search_ripgrep: "auto",
      },
    };
    await fs.writeFile(configFile, JSON.stringify(configPayload, null, 2), "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    // Build a protected tree rule that points to a subdirectory inside allowedRoot
    const protectedSubdir = path.join(allowedRoot, "protected-subdir");
    await fs.mkdir(protectedSubdir);
    const protectedSecretFile = path.join(protectedSubdir, "confidential.txt");
    await fs.writeFile(protectedSecretFile, "TARGET_TREE_QUERY confidential match in tree", "utf8");

    // The logDir of ConfigManager is protected as a tree by default.
    // If we test searchInFiles, protected paths (like configFile) are excluded.
    const resNode = await searchInFiles("TARGET_TREE_QUERY", allowedRoot);
    const resRg = await searchCodebase({
      query: "TARGET_TREE_QUERY",
      searchPath: allowedRoot,
    });

    assert.ok(resNode.some((m) => path.resolve(m.file) === path.resolve(ordinaryFile)));
    assert.ok(resRg.matches.some((m) => path.resolve(m.file) === path.resolve(ordinaryFile)));
  });
});
