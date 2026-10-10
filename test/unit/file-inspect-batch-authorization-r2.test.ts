import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { inspectFileBatch } from "../../src/engine/file-inspect.js";
import { StructuredToolError } from "../../src/errors/tool-error.js";
import { resetProtectedObjectRegistryCache } from "../../src/permissions/object-identity.js";

describe("R2 file_inspect_batch optimized authorization regression suite", () => {
  let tempRoot: string;
  let allowedRoot: string;
  let protectedDir: string;
  let configFile: string;
  let protectedTreeFile: string;
  let safeFile1: string;
  let safeFile2: string;
  let ordinaryFile: string;
  let ordinaryAlias: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-inspect-auth-"));
    allowedRoot = path.join(tempRoot, "allowed");
    protectedDir = path.join(tempRoot, "protected-tree");

    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.mkdir(protectedDir, { recursive: true });

    configFile = path.join(allowedRoot, "winhelm.config.json");
    protectedTreeFile = path.join(protectedDir, "secret-in-tree.txt");
    await fs.writeFile(protectedTreeFile, "SECRET_IN_PROTECTED_TREE\n", "utf8");

    safeFile1 = path.join(allowedRoot, "safe1.txt");
    safeFile2 = path.join(allowedRoot, "safe2.txt");
    await fs.writeFile(safeFile1, "SAFE_CONTENT_1\n", "utf8");
    await fs.writeFile(safeFile2, "SAFE_CONTENT_2\n", "utf8");

    ordinaryFile = path.join(allowedRoot, "ordinary.txt");
    ordinaryAlias = path.join(allowedRoot, "ordinary-alias.txt");
    await fs.writeFile(ordinaryFile, "ORDINARY_CONTENT\n", "utf8");
    fsSync.linkSync(ordinaryFile, ordinaryAlias);

    const config = {
      schemaVersion: 2,
      folders: [{ path: allowedRoot, permission: "readwrite" }],
      terminal: { mode: "off" },
      toolPolicy: {
        file_inspect_batch: "auto",
        file_read: "auto",
      },
      protectedPaths: [
        { path: protectedDir, kind: "tree", label: "Protected Tree" },
        { path: configFile, kind: "file", label: "Protected Config File" },
      ],
    };
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

    ConfigManager.resetInstance();
    resetProtectedObjectRegistryCache();
    ConfigManager.getInstance(configFile);
  });

  afterEach(async () => {
    ConfigManager.resetInstance();
    resetProtectedObjectRegistryCache();
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  // 1. safe files batch
  it("1. inspects safe files batch successfully", async () => {
    const result = await inspectFileBatch({ paths: [safeFile1, safeFile2], sha256: false });
    assert.strictEqual(result.total_inspected, 2);
    assert.strictEqual(result.items.length, 2);
    assert.strictEqual(result.items[0].exists, true);
    assert.strictEqual(result.items[1].exists, true);
  });

  // 2. protected file inside batch
  it("2. denies batch containing a protected file", async () => {
    await assert.rejects(
      inspectFileBatch({ paths: [safeFile1, configFile], sha256: false }),
      (err: unknown) => {
        assert.ok(err instanceof StructuredToolError);
        assert.strictEqual(err.code, "FOLDER_PROTECTED_PATH");
        return true;
      }
    );
  });

  // 3. protected tree descendant inside batch
  it("3. denies batch containing a protected tree descendant", async () => {
    await assert.rejects(
      inspectFileBatch({ paths: [safeFile1, protectedTreeFile], sha256: false }),
      (err: unknown) => {
        assert.ok(err instanceof StructuredToolError);
        assert.strictEqual(err.code, "FOLDER_PROTECTED_PATH");
        return true;
      }
    );
  });

  // 4. runtime-created hardlink alias after registry/config initialization
  it("4. denies runtime-created hardlink alias after initialization", async () => {
    const aliasPath = path.join(allowedRoot, "runtime-alias.txt");
    fsSync.linkSync(protectedTreeFile, aliasPath);

    await assert.rejects(
      inspectFileBatch({ paths: [safeFile1, aliasPath], sha256: false }),
      (err: unknown) => {
        assert.ok(err instanceof StructuredToolError);
        assert.strictEqual(err.code, "FOLDER_PROTECTED_PATH");
        return true;
      }
    );
  });

  // 5. alias removed then safe behavior restored
  it("5. restores safe behavior immediately after alias is removed", async () => {
    const aliasPath = path.join(allowedRoot, "transient-alias.txt");
    fsSync.linkSync(protectedTreeFile, aliasPath);

    await assert.rejects(
      inspectFileBatch({ paths: [aliasPath], sha256: false }),
      (err: unknown) => err instanceof StructuredToolError && err.code === "FOLDER_PROTECTED_PATH"
    );

    await fs.unlink(aliasPath);

    const safeAfter = path.join(allowedRoot, "new-safe.txt");
    await fs.writeFile(safeAfter, "SAFE_NEW\n", "utf8");
    const result = await inspectFileBatch({ paths: [safeAfter], sha256: false });
    assert.strictEqual(result.total_inspected, 1);
    assert.strictEqual(result.items[0].exists, true);
  });

  // 6. second alias created and denied again
  it("6. denies second alias created after removal", async () => {
    const alias1 = path.join(allowedRoot, "churn-1.txt");
    fsSync.linkSync(protectedTreeFile, alias1);
    await assert.rejects(
      inspectFileBatch({ paths: [alias1] }),
      (err: unknown) => err instanceof StructuredToolError && err.code === "FOLDER_PROTECTED_PATH"
    );
    await fs.unlink(alias1);

    const alias2 = path.join(allowedRoot, "churn-2.txt");
    fsSync.linkSync(protectedTreeFile, alias2);
    await assert.rejects(
      inspectFileBatch({ paths: [alias2] }),
      (err: unknown) => err instanceof StructuredToolError && err.code === "FOLDER_PROTECTED_PATH"
    );
  });

  // 7. mixed safe + denied paths
  it("7. denies mixed batch containing safe path and path outside allowed folders", async () => {
    const outsideFile = path.join(tempRoot, "outside.txt");
    await fs.writeFile(outsideFile, "OUTSIDE\n", "utf8");

    await assert.rejects(
      inspectFileBatch({ paths: [safeFile1, outsideFile] }),
      (err: unknown) => {
        assert.ok(err instanceof StructuredToolError);
        assert.ok(err.code === "FOLDER_NOT_APPROVED" || err.code === "FOLDER_ACCESS_DENIED");
        return true;
      }
    );
  });

  // 8. ordinary unprotected hardlink
  it("8. permits ordinary unprotected hardlink inside allowed folder", async () => {
    const result = await inspectFileBatch({
      paths: [ordinaryFile, ordinaryAlias],
      sha256: false,
    });
    assert.strictEqual(result.total_inspected, 2);
    assert.strictEqual(result.items[0].exists, true);
    assert.strictEqual(result.items[1].exists, true);
  });

  // 9. config reload
  it("9. maintains fresh authorization across config reload", async () => {
    const cm = ConfigManager.getInstance();
    const updatedConfig = {
      schemaVersion: 2,
      folders: [{ path: allowedRoot, permission: "readwrite" }],
      terminal: { mode: "off" },
      toolPolicy: { file_inspect_batch: "auto" },
      protectedPaths: [
        { path: protectedDir, kind: "tree", label: "Protected Tree" },
        { path: configFile, kind: "file", label: "Protected Config File" },
        { path: safeFile2, kind: "file", label: "Now Protected File 2" },
      ],
    };
    await fs.writeFile(configFile, JSON.stringify(updatedConfig, null, 2), "utf8");
    await (cm as any).reloadConfigFromDisk();

    // safeFile2 should now be denied
    await assert.rejects(
      inspectFileBatch({ paths: [safeFile2], sha256: false }),
      (err: unknown) => err instanceof StructuredToolError && err.code === "FOLDER_PROTECTED_PATH"
    );

    // safeFile1 is still allowed
    const result = await inspectFileBatch({ paths: [safeFile1], sha256: false });
    assert.strictEqual(result.total_inspected, 1);
    assert.strictEqual(result.items[0].exists, true);
  });

  // 10. invalid protected rule fail-closed
  it("10. fails closed on invalid protected rule kind", async () => {
    const cm = ConfigManager.getInstance();
    const invalidConfig = {
      schemaVersion: 2,
      folders: [{ path: allowedRoot, permission: "readwrite" }],
      terminal: { mode: "off" },
      toolPolicy: { file_inspect_batch: "auto" },
      protectedPaths: [
        { path: protectedDir, kind: "BOGUS_KIND", label: "Malformed Rule" },
      ],
    };
    await fs.writeFile(configFile, JSON.stringify(invalidConfig, null, 2), "utf8");
    await (cm as any).reloadConfigFromDisk();

    await assert.rejects(
      inspectFileBatch({ paths: [safeFile1], sha256: false }),
      (err: unknown) => err instanceof StructuredToolError && (err.code === "FOLDER_PROTECTED_PATH" || err.code === "CONFIG_INVALID")
    );
  });
});
