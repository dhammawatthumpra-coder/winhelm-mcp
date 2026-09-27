import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { hashFile, tailFileContent, writeFileContent } from "../../src/engine/filesystem.js";
import {
  getNetworkInfo,
  listProcesses,
  queryEventLog,
  sendNotification,
} from "../../src/engine/system.js";

describe("Workstation & Inspection Tools (6 Golden Tools)", () => {
  const testDir = path.resolve(process.cwd(), "test-scratch-workstation");

  before(async () => {
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
    await fs.mkdir(testDir, { recursive: true });
  });

  after(async () => {
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("Feature 1: file_tail", () => {
    it("should tail the last N lines of a file with line numbers", async () => {
      const samplePath = path.join(testDir, "tail-sample.txt");
      const lines = Array.from({ length: 20 }, (_, i) => `Log line number ${i + 1}`);
      await writeFileContent(samplePath, lines.join("\n"));

      const res = await tailFileContent(samplePath, 5);
      assert.strictEqual(res.totalLines, 20);
      assert.strictEqual(res.linesReturned, 5);
      assert.ok(res.content.includes("16: Log line number 16"));
      assert.ok(res.content.includes("20: Log line number 20"));
      assert.ok(!res.content.includes("15: Log line number 15"));
    });

    it("should return all lines if requested count exceeds file length", async () => {
      const samplePath = path.join(testDir, "short.txt");
      await writeFileContent(samplePath, "alpha\nbeta\ngamma");

      const res = await tailFileContent(samplePath, 10);
      assert.strictEqual(res.totalLines, 3);
      assert.strictEqual(res.linesReturned, 3);
      assert.ok(res.content.includes("1: alpha"));
      assert.ok(res.content.includes("3: gamma"));
    });
  });

  describe("Feature 2: file_hash", () => {
    it("should compute SHA-256 and MD5 hash correctly", async () => {
      const hashFileSample = path.join(testDir, "hash-test.txt");
      const content = "Hello WinHelm Cryptographic Hash Verification";
      await writeFileContent(hashFileSample, content);

      const expectedSha256 = createHash("sha256").update(content).digest("hex");
      const expectedMd5 = createHash("md5").update(content).digest("hex");

      const shaRes = await hashFile(hashFileSample, "sha256");
      assert.strictEqual(shaRes.algorithm, "sha256");
      assert.strictEqual(shaRes.hash, expectedSha256);
      assert.strictEqual(shaRes.sizeBytes, Buffer.byteLength(content));

      const md5Res = await hashFile(hashFileSample, "md5");
      assert.strictEqual(md5Res.algorithm, "md5");
      assert.strictEqual(md5Res.hash, expectedMd5);
    });
  });

  describe("Feature 3: process_list", () => {
    it("should list top running processes sorted by memory", async () => {
      const procs = await listProcesses({ limit: 5, sortBy: "memory" });
      assert.ok(Array.isArray(procs));
      assert.ok(procs.length > 0 && procs.length <= 5);

      const first = procs[0];
      assert.ok(typeof first.pid === "number");
      assert.ok(typeof first.name === "string" && first.name.length > 0);
      assert.ok(typeof first.workingSetMB === "number");
    });

    it("should filter processes by name", async () => {
      const procs = await listProcesses({ filter: "node", limit: 10 });
      assert.ok(Array.isArray(procs));
      for (const p of procs) {
        assert.ok(p.name.toLowerCase().includes("node") || (p.path && p.path.toLowerCase().includes("node")));
      }
    });
  });

  describe("Feature 4: eventlog_query", () => {
    it("should query Windows Event Log without errors", async () => {
      const events = await queryEventLog({ logName: "Application", limit: 3, level: "All" });
      assert.ok(Array.isArray(events));
      if (events.length > 0) {
        const first = events[0];
        assert.ok(typeof first.id === "number");
        assert.ok(typeof first.level === "string");
        assert.ok(typeof first.message === "string");
      }
    });
  });

  describe("Feature 5: network_info", () => {
    it("should return network adapters, hostname, and connectivity info", async () => {
      const netInfo = await getNetworkInfo(false);
      assert.ok(typeof netInfo.hostname === "string" && netInfo.hostname.length > 0);
      assert.ok(Array.isArray(netInfo.adapters));
      assert.ok(netInfo.adapters.length > 0);
    });
  });

  describe("Feature 6: notification_send", () => {
    it("should execute toast notification command successfully", async () => {
      const res = await sendNotification("WinHelm Test", "Automated test notification", false);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.title, "WinHelm Test");
      assert.strictEqual(res.message, "Automated test notification");
    });
  });
});
