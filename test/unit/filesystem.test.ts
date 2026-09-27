import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import {
  editFileContent,
  listDirectory,
  readFileContent,
  searchInFiles,
  writeFileContent,
} from "../../src/engine/filesystem.js";

describe("Filesystem Engine", () => {
  const testDir = path.resolve("./test_temp_fs");
  const testFile = path.join(testDir, "sample.txt");

  before(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  after(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should write and read file content accurately", async () => {
    const content = "Line 1: Alpha\nLine 2: Beta\nLine 3: Gamma\nLine 4: ภาษาไทยทดสอบ";
    const writeRes = await writeFileContent(testFile, content);
    assert.strictEqual(writeRes.success, true);

    const readRes = await readFileContent(testFile);
    assert.strictEqual(readRes.content, content);
    assert.strictEqual(readRes.totalLines, 4);
  });

  it("should read line range with line numbering", async () => {
    const rangeRes = await readFileContent(testFile, 2, 3);
    assert.strictEqual(rangeRes.startLine, 2);
    assert.strictEqual(rangeRes.endLine, 3);
    assert.ok(rangeRes.content.includes("2: Line 2: Beta"));
    assert.ok(rangeRes.content.includes("3: Line 3: Gamma"));
    assert.ok(!rangeRes.content.includes("1: Line 1"));
  });

  it("should surgically edit unique text in file", async () => {
    const editRes = await editFileContent(testFile, "Line 2: Beta", "Line 2: Beta-Updated");
    assert.strictEqual(editRes.success, true);

    const readRes = await readFileContent(testFile);
    assert.ok(readRes.content.includes("Line 2: Beta-Updated"));
  });

  it("should throw error if oldText does not exist or is not unique", async () => {
    await assert.rejects(
      async () => {
        await editFileContent(testFile, "NonExistentString123", "NewText");
      },
      /old_text not found/
    );
  });

  it("should list files in directory", async () => {
    const list = await listDirectory(testDir);
    assert.ok(list.length > 0);
    const found = list.find((item) => item.name === "sample.txt");
    assert.ok(found);
    assert.strictEqual(found.type, "file");
  });

  it("should search text across files", async () => {
    const matches = await searchInFiles("ภาษาไทย", testDir);
    assert.ok(matches.length > 0);
    assert.strictEqual(matches[0].file, testFile);
    assert.ok(matches[0].text.includes("ภาษาไทยทดสอบ"));
  });

  it("should exclude dist, logs, .serena, and build directories from file search and recursive listing", async () => {
    const distDir = path.join(testDir, "dist");
    const logsDir = path.join(testDir, "logs");
    const serenaDir = path.join(testDir, ".serena");
    const srcDir = path.join(testDir, "src");

    await fs.mkdir(distDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(serenaDir, { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });

    await fs.writeFile(path.join(distDir, "bundle.cjs"), "const secretKey = 'FIND_ME_TARGET';", "utf-8");
    await fs.writeFile(path.join(logsDir, "app.log"), "2026-09-27 FIND_ME_TARGET in log", "utf-8");
    await fs.writeFile(path.join(serenaDir, "memory.json"), "FIND_ME_TARGET in memory", "utf-8");
    await fs.writeFile(path.join(srcDir, "index.ts"), "export const val = 'FIND_ME_TARGET';", "utf-8");

    // Test searchInFiles: should only find the match in src/, not in dist/, logs/, or .serena/
    const matches = await searchInFiles("FIND_ME_TARGET", testDir);
    assert.strictEqual(matches.length, 1, `Expected exactly 1 match in src/, got ${matches.length}`);
    assert.ok(matches[0].file.includes("src"));
    assert.ok(!matches.some((m) => m.file.includes("dist")));
    assert.ok(!matches.some((m) => m.file.includes("logs")));
    assert.ok(!matches.some((m) => m.file.includes(".serena")));

    // Test listDirectory with recursive: true: should not traverse into dist, logs, .serena
    const list = await listDirectory(testDir, true);
    const subPaths = list.map((item) => item.path);
    assert.ok(!subPaths.some((p) => p.includes("bundle.cjs")), "Should not traverse into dist/");
    assert.ok(!subPaths.some((p) => p.includes("app.log")), "Should not traverse into logs/");
    assert.ok(!subPaths.some((p) => p.includes("memory.json")), "Should not traverse into .serena/");
    assert.ok(subPaths.some((p) => p.includes("index.ts")), "Should traverse into src/");
  });
});
