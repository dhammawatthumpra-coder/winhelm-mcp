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
});
