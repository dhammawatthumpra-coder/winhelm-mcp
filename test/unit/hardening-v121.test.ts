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
import { createHash } from "node:crypto";
import { hashSessionId, AuditLogger } from "../../src/utils/audit-logger.js";
import { Logger } from "../../src/utils/logger.js";
import { sanitizeText, sanitizeObject } from "../../src/utils/sanitizer.js";

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

describe("Task 3 Hardening - Audit Log and Sanitizer Security", () => {
  it("hashSessionId should hash raw 64-hex session ID to sha256.slice(0, 12)", () => {
    const rawSessionId = "e83cf66fa2b794dc6be44d939611b816a7f805b45129665bc7aa9580a13d7904";
    const expected = createHash("sha256").update(rawSessionId).digest("hex").slice(0, 12);
    const hashed = hashSessionId(rawSessionId);
    assert.strictEqual(hashed, expected);
    assert.strictEqual(hashed?.length, 12);
    assert.ok(!rawSessionId.includes(hashed!));
  });

  it("hashSessionId should return undefined if sessionId is omitted", () => {
    assert.strictEqual(hashSessionId(undefined), undefined);
    assert.strictEqual(hashSessionId(""), undefined);
  });

  it("Logger should truncate tool input arguments to <= 500 characters", () => {
    const logger = Logger.getInstance();
    const giantArgs: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      giantArgs[`field_${i}`] = "x".repeat(50);
    }
    logger.toolStart("test_giant_args", giantArgs);

    const recent = logger.getRecentLogs(1)[0];
    assert.strictEqual(recent.type, "tool");
    assert.ok(recent.detail!.length <= 500, `detail length ${recent.detail!.length} exceeds 500`);
    assert.ok(recent.detail!.endsWith("..."));
  });

  it("Logger should truncate tool output summary to <= 200 characters", () => {
    const logger = Logger.getInstance();
    const giantSummary = "B".repeat(500);
    logger.toolDone("test_giant_done", 10, giantSummary);

    const recent = logger.getRecentLogs(1)[0];
    assert.strictEqual(recent.type, "tool");
    assert.ok(recent.detail!.length <= 200, `detail length ${recent.detail!.length} exceeds 200`);
    assert.ok(recent.detail!.endsWith("..."));
  });

  it("Logger should truncate tool error to <= 200 characters", () => {
    const logger = Logger.getInstance();
    const giantError = "C".repeat(500);
    logger.toolFail("test_giant_fail", 10, giantError);

    const recent = logger.getRecentLogs(1)[0];
    assert.strictEqual(recent.type, "tool");
    assert.ok(recent.detail!.length <= 200, `detail length ${recent.detail!.length} exceeds 200`);
    assert.ok(recent.detail!.endsWith("..."));
  });

  it("sanitizer should mask Bearer tokens with diverse boundary characters", () => {
    const cases = [
      'Bearer abcdef1234567890;',
      'Bearer "abcdef1234567890"',
      "Bearer 'abcdef1234567890'",
      'Bearer abcdef1234567890, next',
    ];
    for (const c of cases) {
      const sanitized = sanitizeText(c);
      assert.ok(!sanitized.includes("abcdef1234567890"), `Leaked in case: ${c}`);
      assert.ok(sanitized.includes("************"));
      assert.ok(sanitized.toLowerCase().includes("bearer"));
    }
  });

  it("sanitizer should mask exchange=, winhelm_session=, and session= in query and cookies", () => {
    const query = "/auth/exchange?exchange=secret_exchange_token_12345&foo=bar";
    const cookie = "Cookie: winhelm_session=sess_abcdef0123456789; other=123";
    const sessQuery = "/dashboard?session=user_session_token_99999&debug=true";

    const sQuery = sanitizeText(query);
    assert.ok(!sQuery.includes("secret_exchange_token_12345"));
    assert.ok(sQuery.includes("exchange=************"));

    const sCookie = sanitizeText(cookie);
    assert.ok(!sCookie.includes("sess_abcdef0123456789"));
    assert.ok(sCookie.includes("winhelm_session=************"));
    assert.ok(sCookie.includes("; other=123"));

    const sSess = sanitizeText(sessQuery);
    assert.ok(!sSess.includes("user_session_token_99999"));
    assert.ok(sSess.includes("session=************"));
  });

  it("sanitizeObject should mask exchange and session keys", () => {
    const obj = {
      exchange: "my_exchange_token_val",
      winhelm_session: "my_cookie_session_val",
      normal: "hello",
    };
    const clean = sanitizeObject(obj);
    assert.strictEqual(clean.exchange, "************");
    assert.strictEqual(clean.winhelm_session, "************");
    assert.strictEqual(clean.normal, "hello");
  });
});


