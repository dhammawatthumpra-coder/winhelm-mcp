import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  copyFileOrDir,
  createZip,
  deleteFileToRecycleBin,
  extractZip,
  moveFile,
  writeFileContent,
} from "../../src/engine/filesystem.js";
import { getGpuInfo, getServiceStatus, listServices } from "../../src/engine/system.js";
import { executeHttpRequest, pingEndpoint } from "../../src/engine/http-client.js";
import { ConfigManager } from "../../src/config/config-manager.js";

describe("New Enterprise Tools (Groups 1-4)", () => {
  const testDir = path.resolve(process.cwd(), "test-scratch-new-tools");
  const configManager = ConfigManager.getInstance();

  before(async () => {
    // Ensure test directory is clean
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
    await fs.mkdir(testDir, { recursive: true });
  });

  after(async () => {
    // Clean up test directory
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("Group 1: File Safety & Archives", () => {
    it("should copy a file and directory recursively", async () => {
      const srcFile = path.join(testDir, "src.txt");
      const dstFile = path.join(testDir, "dst.txt");
      await writeFileContent(srcFile, "Hello Copy");

      const res = await copyFileOrDir(srcFile, dstFile);
      assert.strictEqual(res.success, true);
      assert.strictEqual(existsSync(dstFile), true);
      const content = await fs.readFile(dstFile, "utf-8");
      assert.strictEqual(content, "Hello Copy");
    });

    it("should move/rename a file", async () => {
      const srcFile = path.join(testDir, "move-me.txt");
      const dstFile = path.join(testDir, "moved.txt");
      await writeFileContent(srcFile, "Hello Move");

      const res = await moveFile(srcFile, dstFile);
      assert.strictEqual(res.success, true);
      assert.strictEqual(existsSync(srcFile), false);
      assert.strictEqual(existsSync(dstFile), true);
    });

    it("should create and extract zip archives using native .NET", async () => {
      const zipFolder = path.join(testDir, "to-zip");
      await fs.mkdir(zipFolder, { recursive: true });
      await fs.writeFile(path.join(zipFolder, "file1.txt"), "Content 1");
      await fs.writeFile(path.join(zipFolder, "file2.txt"), "Content 2");

      const zipFile = path.join(testDir, "archive.zip");
      const extractFolder = path.join(testDir, "extracted");

      // Create ZIP
      const createRes = await createZip(zipFolder, zipFile);
      assert.strictEqual(createRes.success, true);
      assert.strictEqual(existsSync(zipFile), true);

      // Extract ZIP
      const extractRes = await extractZip(zipFile, extractFolder);
      assert.strictEqual(extractRes.success, true);
      assert.strictEqual(existsSync(path.join(extractFolder, "file1.txt")), true);
      assert.strictEqual(existsSync(path.join(extractFolder, "file2.txt")), true);
    });

    it("should delete file to Windows Recycle Bin safely", async () => {
      const target = path.join(testDir, "recycle-test.txt");
      await writeFileContent(target, "Safe delete test");
      assert.strictEqual(existsSync(target), true);

      const res = await deleteFileToRecycleBin(target);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.movedToRecycleBin, true);
      assert.strictEqual(existsSync(target), false);
    });

    it("should reject copyFileOrDir and createZip when source is forbidden by allowedDirectories", async () => {
      // Temporarily enforce allowedDirectories: [testDir]
      await configManager.updateConfig({ allowedDirectories: [testDir] }, false);

      const forbiddenSrc = "C:\\Windows\\System32\\drivers\\etc\\hosts";
      const dstFile = path.join(testDir, "copied-hosts.txt");

      // copyFileOrDir should reject forbidden source
      await assert.rejects(
        async () => {
          await copyFileOrDir(forbiddenSrc, dstFile);
        },
        (err: Error) => {
          return err.message.includes("forbidden by allowedDirectories policy");
        }
      );

      // createZip should reject forbidden source directory
      const forbiddenDir = "C:\\Windows\\System32";
      const zipDst = path.join(testDir, "forbidden.zip");
      await assert.rejects(
        async () => {
          await createZip(forbiddenDir, zipDst);
        },
        (err: Error) => {
          return err.message.includes("forbidden by allowedDirectories policy");
        }
      );

      // extractZip should reject forbidden zipPath
      const forbiddenZip = "C:\\Windows\\forbidden.zip";
      await assert.rejects(
        async () => {
          await extractZip(forbiddenZip, testDir);
        },
        (err: Error) => {
          return err.message.includes("forbidden by allowedDirectories policy");
        }
      );

      // Restore unrestricted config
      await configManager.updateConfig({ allowedDirectories: ["*"] }, false);
    });
  });

  describe("Group 2: GPU & Machine Learning", () => {
    it("should query GPU statistics with nvidia-smi or fallback", async () => {
      const gpuInfo = await getGpuInfo();
      assert.ok(typeof gpuInfo.hasNvidia === "boolean");
      assert.ok(Array.isArray(gpuInfo.gpus));

      if (gpuInfo.hasNvidia && gpuInfo.gpus.length > 0) {
        const gpu = gpuInfo.gpus[0];
        assert.ok(gpu.name.includes("NVIDIA") || gpu.name.includes("GeForce"));
        assert.ok(gpu.memoryTotalMB! > 0);
      }
    });
  });

  describe("Group 3: Web & Dev Server Verification", () => {
    it("should ping an HTTP endpoint and return latency and status", async () => {
      const ping = await pingEndpoint("https://example.com", 8000);
      assert.strictEqual(ping.ok, true);
      assert.strictEqual(ping.status, 200);
      assert.ok(ping.latencyMs > 0);
    });

    it("should handle unreachable endpoint gracefully", async () => {
      const ping = await pingEndpoint("http://127.0.0.1:9999/unreachable", 1500);
      assert.strictEqual(ping.ok, false);
      assert.strictEqual(ping.status, 0);
    });

    it("should execute HTTP GET request and parse response", async () => {
      const res = await executeHttpRequest({
        url: "https://example.com",
        method: "GET",
        timeoutMs: 8000,
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.includes("Example Domain"));
    });
  });

  describe("Group 4: Windows Services Manager", () => {
    it("should list Windows services with filter", async () => {
      const services = await listServices("ssh");
      assert.ok(Array.isArray(services));
      if (services.length > 0) {
        assert.ok(services[0].name.toLowerCase().includes("ssh"));
        assert.ok(services[0].status);
      }
    });

    it("should get specific service status", async () => {
      try {
        const status = await getServiceStatus("ssh-agent");
        assert.strictEqual(status.name, "ssh-agent");
        assert.ok(status.status);
      } catch (err: any) {
        // In case ssh-agent service is absent on some Windows SKU
        assert.ok(err.message.includes("ssh-agent"));
      }
    });
  });
});
