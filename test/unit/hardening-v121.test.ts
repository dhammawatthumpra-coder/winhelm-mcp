import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { psQuote } from "../../src/utils/ps-quote.js";
import {
  deleteFileToRecycleBin,
  createZip,
  extractZip,
} from "../../src/engine/filesystem.js";
import {
  openTarget,
  killProcess,
  getServiceStatus,
  controlService,
  sendNotification,
} from "../../src/engine/system.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { getCleanChildEnv } from "../../src/utils/child-env.js";
import { runPowerShell } from "../../src/engine/powershell-runner.js";

const SMART_QUOTES = ["\u2018", "\u2019", "\u201A", "\u201B"]; // ‘, ’, ‚, ‛

describe("Task 1 Hardening - Unicode Smart Quotes & PowerShell Injection Prevention", () => {
  const testDir = path.join(os.tmpdir(), `winhelm-hardening-${Date.now()}`);
  const probeDir = path.join(testDir, "probes");

  before(async () => {
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(probeDir, { recursive: true });
    // Configure allowedDirectories for test
    const configManager = ConfigManager.getInstance();
    await configManager.updateConfig({
      allowedDirectories: [testDir, os.tmpdir(), "C:\\Windows"],
      allowSystemExecution: true,
    }, false);
  });

  after(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {}
    await ConfigManager.getInstance().updateConfig({
      allowedDirectories: [process.cwd(), os.tmpdir(), "C:\\Windows"],
      allowSystemExecution: true,
    }, false);
  });

  describe("psQuote helper", () => {
    it("should double standard ASCII single quotes", () => {
      assert.strictEqual(psQuote("O'Reilly"), "'O''Reilly'");
    });

    it("should double all 4 Unicode smart single quote variants", () => {
      assert.strictEqual(psQuote("a\u2018b"), "'a\u2018\u2018b'");
      assert.strictEqual(psQuote("a\u2019b"), "'a\u2019\u2019b'");
      assert.strictEqual(psQuote("a\u201Ab"), "'a\u201A\u201Ab'");
      assert.strictEqual(psQuote("a\u201Bb"), "'a\u201B\u201Bb'");
    });

    it("should reject strings containing NUL or newlines", () => {
      assert.throws(() => psQuote("foo\0bar"), /Invalid character/);
      assert.throws(() => psQuote("foo\nbar"), /Invalid character/);
      assert.throws(() => psQuote("foo\rbar"), /Invalid character/);
    });
  });

  describe("extractZip injection prevention across all smart quotes", () => {
    for (const q of SMART_QUOTES) {
      const charCode = q.charCodeAt(0).toString(16);
      it(`should prevent command injection via extractZip with quote U+${charCode}`, async () => {
        const probeFile = path.join(probeDir, `probe-extract-${charCode}.txt`);
        const malformedZip = path.join(testDir, `malicious${q}; New-Item -Path '${probeFile}' -ItemType File; #.zip`);
        const targetExtract = path.join(testDir, `out-${charCode}`);

        // extractZip should fail because file does not exist, but MUST NOT execute injected command
        await assert.rejects(async () => {
          await extractZip(malformedZip, targetExtract);
        });

        assert.strictEqual(existsSync(probeFile), false, `Probe file ${probeFile} must not be created`);
      });
    }
  });

  describe("createZip injection prevention across all smart quotes", () => {
    for (const q of SMART_QUOTES) {
      const charCode = q.charCodeAt(0).toString(16);
      it(`should prevent command injection via createZip with quote U+${charCode}`, async () => {
        const probeFile = path.join(probeDir, `probe-create-${charCode}.txt`);
        const sourceFolder = path.join(testDir, `src-${charCode}`);
        await fs.mkdir(sourceFolder, { recursive: true });
        await fs.writeFile(path.join(sourceFolder, "sample.txt"), "hello", "utf-8");

        const malformedZip = path.join(testDir, `target${q}; New-Item -Path '${probeFile}' -ItemType File; #.zip`);

        try {
          await createZip(sourceFolder, malformedZip);
        } catch {
          // May succeed or fail on literal path, but must NOT run injection
        }

        assert.strictEqual(existsSync(probeFile), false, `Probe file ${probeFile} must not be created`);
      });
    }
  });

  describe("deleteFileToRecycleBin injection prevention across all smart quotes", () => {
    for (const q of SMART_QUOTES) {
      const charCode = q.charCodeAt(0).toString(16);
      it(`should prevent command injection via deleteFileToRecycleBin with quote U+${charCode}`, async () => {
        const probeFile = path.join(probeDir, `probe-del-${charCode}.txt`);
        const malformedFile = path.join(testDir, `delfile${q}; New-Item -Path '${probeFile}' -ItemType File; #.txt`);

        try {
          await deleteFileToRecycleBin(malformedFile);
        } catch {
          // File not found or path error expected, but must NOT run injection
        }

        assert.strictEqual(existsSync(probeFile), false, `Probe file ${probeFile} must not be created`);

        // Also test an existing file with a smart quote in the name can be processed without crashing or injection
        const realFile = path.join(testDir, `real-${charCode}-${q}.txt`);
        await fs.writeFile(realFile, "data", "utf-8");
        try {
          await deleteFileToRecycleBin(realFile);
        } catch {
          // May fail on some headless CI/recycle bin configurations, but must not inject
        }
      });
    }
  });

  describe("openTarget injection prevention across all smart quotes", () => {
    for (const q of SMART_QUOTES) {
      const charCode = q.charCodeAt(0).toString(16);
      it(`should prevent command injection via openTarget with quote U+${charCode}`, async () => {
        const probeFile = path.join(probeDir, `probe-open-${charCode}.txt`);
        const malformedTarget = path.join(testDir, `target${q}; New-Item -Path '${probeFile}' -ItemType File; #.txt`);

        try {
          await openTarget(malformedTarget);
        } catch {
          // May fail because file doesn't exist, but must NOT run injection
        }

        assert.strictEqual(existsSync(probeFile), false, `Probe file ${probeFile} must not be created`);
      });
    }
  });

  describe("killProcess injection prevention across all smart quotes", () => {
    for (const q of SMART_QUOTES) {
      const charCode = q.charCodeAt(0).toString(16);
      it(`should prevent command injection via killProcess with quote U+${charCode}`, async () => {
        const probeFile = path.join(probeDir, `probe-kill-${charCode}.txt`);
        const malformedName = `proc${q}; New-Item -Path '${probeFile}' -ItemType File; #`;

        try {
          await killProcess(undefined, malformedName);
        } catch {
          // Process not found is expected
        }

        assert.strictEqual(existsSync(probeFile), false, `Probe file ${probeFile} must not be created`);
      });
    }
  });

  describe("service management injection prevention", () => {
    it("should reject service names with smart quotes and commands in getServiceStatus", async () => {
      const probeFile = path.join(probeDir, "probe-svc-status.txt");
      const badName = `WSearch’; New-Item -Path '${probeFile}' -ItemType File; #`;

      await assert.rejects(async () => {
        await getServiceStatus(badName);
      }, /Invalid service name/);

      assert.strictEqual(existsSync(probeFile), false);
    });

    it("should reject service names with smart quotes and commands in controlService", async () => {
      const probeFile = path.join(probeDir, "probe-svc-ctrl.txt");
      const badName = `Spooler’; New-Item -Path '${probeFile}' -ItemType File; #`;

      await assert.rejects(async () => {
        await controlService(badName, "start");
      }, /Invalid service name/);

      assert.strictEqual(existsSync(probeFile), false);
    });
  });

  describe("sendNotification injection prevention across smart quotes", () => {
    for (const q of SMART_QUOTES) {
      const charCode = q.charCodeAt(0).toString(16);
      it(`should prevent command injection via sendNotification with quote U+${charCode}`, async () => {
        const probeFile = path.join(probeDir, `probe-notify-${charCode}.txt`);
        const malformedTitle = `Alert${q}; New-Item -Path '${probeFile}' -ItemType File; #`;
        const malformedMsg = `Msg${q}; New-Item -Path '${probeFile}' -ItemType File; #`;

        try {
          await sendNotification(malformedTitle, malformedMsg, false);
        } catch {}

        assert.strictEqual(existsSync(probeFile), false, `Probe file ${probeFile} must not be created`);
      });
    }
  });
});

describe("Task 2 Hardening - Do Not Leak Server Auth Tokens to Child Processes", () => {
  it("getCleanChildEnv should strip sensitive environment variables", () => {
    process.env.MCP_AUTH_TOKEN = "CANARY_MCP_TOKEN_SECRET";
    process.env.AUTH_TOKEN = "CANARY_AUTH_TOKEN_SECRET";
    process.env.WINHELM_AUTH_TOKEN = "CANARY_WINHELM_SECRET";
    process.env.MCP_SECRET_KEY = "CANARY_SECRET_KEY";
    process.env.WINHELM_API_TOKEN = "CANARY_API_TOKEN";
    process.env.SAFE_CUSTOM_VAR = "CANARY_SAFE_VALUE";

    try {
      const clean = getCleanChildEnv();
      assert.strictEqual(clean.MCP_AUTH_TOKEN, undefined);
      assert.strictEqual(clean.AUTH_TOKEN, undefined);
      assert.strictEqual(clean.WINHELM_AUTH_TOKEN, undefined);
      assert.strictEqual(clean.MCP_SECRET_KEY, undefined);
      assert.strictEqual(clean.WINHELM_API_TOKEN, undefined);
      assert.strictEqual(clean.SAFE_CUSTOM_VAR, "CANARY_SAFE_VALUE");
      assert.strictEqual(clean.PYTHONIOENCODING, "utf-8");
    } finally {
      delete process.env.MCP_AUTH_TOKEN;
      delete process.env.AUTH_TOKEN;
      delete process.env.WINHELM_AUTH_TOKEN;
      delete process.env.MCP_SECRET_KEY;
      delete process.env.WINHELM_API_TOKEN;
      delete process.env.SAFE_CUSTOM_VAR;
    }
  });

  it("getCleanChildEnv should allow explicit non-sensitive overrides", () => {
    const clean = getCleanChildEnv({ CUSTOM_OVERRIDE: "test123" });
    assert.strictEqual(clean.CUSTOM_OVERRIDE, "test123");
  });

  it("child process executed via runPowerShell should not have access to server tokens", async () => {
    process.env.MCP_AUTH_TOKEN = "CANARY_MCP_LEAK_TEST";
    process.env.AUTH_TOKEN = "CANARY_AUTH_LEAK_TEST";

    try {
      const res = await runPowerShell("Write-Output \"MCP:$env:MCP_AUTH_TOKEN|AUTH:$env:AUTH_TOKEN\"");
      assert.strictEqual(res.exitCode, 0);
      assert.strictEqual(res.stdout.trim(), "MCP:|AUTH:");
      assert.ok(!res.stdout.includes("CANARY_MCP_LEAK_TEST"));
      assert.ok(!res.stdout.includes("CANARY_AUTH_LEAK_TEST"));
    } finally {
      delete process.env.MCP_AUTH_TOKEN;
      delete process.env.AUTH_TOKEN;
    }
  });
});

