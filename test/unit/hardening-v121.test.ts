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
import { SessionManager } from "../../src/gateway/session-manager.js";
import { createServer } from "../../src/gateway/server.js";
import { escapeHtml, getDashboardHtml } from "../../src/gateway/dashboard-html.js";
import { validateNetworkExposure, isLoopbackHost } from "../../src/utils/network-gate.js";

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

describe("Task 4 Hardening - allowSystemExecution: false consistency", () => {
  const configManager = ConfigManager.getInstance();

  after(async () => {
    await configManager.updateConfig({
      allowedDirectories: [process.cwd(), os.tmpdir(), "C:\\Windows"],
      allowSystemExecution: true,
    }, false);
    ConfigManager.resetWarningFlags();
  });

  it("powershell-runner should reject when cwd is omitted, allowSystemExecution is false, and process.cwd() is outside allowedDirectories", async () => {
    const isolatedDir = path.join(os.tmpdir(), `isolated-${Date.now()}`);
    await configManager.updateConfig({
      allowedDirectories: [isolatedDir],
      allowSystemExecution: false,
    }, false);

    await assert.rejects(
      async () => {
        await runPowerShell("Write-Output 'should fail'");
      },
      /(forbidden|not permitted)/
    );
  });

  it("isCommandAllowed should extract path tokens and allow permitted paths while blocking forbidden paths", async () => {
    const allowedDir = "D:\\mcp\\winhelm-mcp";
    await configManager.updateConfig({
      allowedDirectories: [allowedDir],
      allowSystemExecution: false,
    }, false);

    // Permitted absolute path
    const safeCmd = "Get-ChildItem -Path D:\\mcp\\winhelm-mcp\\src\\index.ts";
    const resSafe = configManager.isCommandAllowed(safeCmd);
    assert.strictEqual(resSafe.allowed, true, "Permitted path inside allowedDirectories should be allowed");

    // Forbidden absolute path
    const forbiddenCmd = "Start-Process C:\\Windows\\System32\\calc.exe";
    const resForbidden = configManager.isCommandAllowed(forbiddenCmd);
    assert.strictEqual(resForbidden.allowed, false, "Forbidden path outside allowedDirectories should be blocked");
    assert.ok(resForbidden.reason?.includes("references forbidden path"));

    // Forbidden bare drive
    const forbiddenDrive = "dir C:\\";
    const resDrive = configManager.isCommandAllowed(forbiddenDrive);
    assert.strictEqual(resDrive.allowed, false, "Forbidden drive should be blocked");
  });

  it("ConfigManager should log one-time warning on wildcard '*' in allowedDirectories", async () => {
    ConfigManager.resetWarningFlags();
    const originalConsoleWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: any[]) => {
      warnings.push(args.join(" "));
    };

    try {
      await configManager.updateConfig({
        allowedDirectories: ["*"],
        allowSystemExecution: false,
      }, false);
      configManager.logSecurityWarnings();

      // Trigger second time - should be one-time only
      configManager.logSecurityWarnings();

      const wildcardWarns = warnings.filter((w) => w.includes("allowedDirectories set to wildcard '*'"));
      assert.strictEqual(wildcardWarns.length, 1, "Wildcard warning should be logged exactly once");
    } finally {
      console.warn = originalConsoleWarn;
    }
  });
});

describe("Task 5 Hardening - URL Auth Token & Session Absolute Lifetime", () => {
  describe("SessionManager Absolute Lifetime", () => {
    it("should enforce absolute lifetime cap (12 hours) even if session is continuously accessed", () => {
      const sm = new SessionManager(15, 12);
      const sid = sm.createSession();

      assert.strictEqual(sm.validateSession(sid), true);

      // Simulate perpetual activity: lastAccessedAt is recent, but createdAt is 13 hours ago
      const session = (sm as any).sessions.get(sid);
      session.createdAt = Date.now() - 13 * 60 * 60 * 1000; // 13 hours ago
      session.lastAccessedAt = Date.now() - 1000; // 1 second ago

      assert.strictEqual(sm.validateSession(sid), false, "Session exceeding absolute lifetime must be invalidated");
      assert.strictEqual(sm.validateSession(sid), false, "Session must have been deleted from memory");
      sm.close();
    });

    it("should prune sessions exceeding absolute lifetime in cleanupExpiredSessions", () => {
      const sm = new SessionManager(15, 12);
      const sidValid = sm.createSession();
      const sidOverAbsolute = sm.createSession();

      const sOld = (sm as any).sessions.get(sidOverAbsolute);
      sOld.createdAt = Date.now() - 13 * 60 * 60 * 1000;
      sOld.lastAccessedAt = Date.now() - 1000;

      const pruned = sm.cleanupExpiredSessions();
      assert.ok(pruned >= 1, "Should prune at least 1 session exceeding absolute lifetime");
      assert.strictEqual(sm.validateSession(sidOverAbsolute), false);
      assert.strictEqual(sm.validateSession(sidValid), true);
      sm.close();
    });
  });

  describe("Server URL Query Token Protocol Isolation", () => {
    let serverInstance: any;
    let runningServer: any;
    const testPort = 18791; // Ground rules: Do NOT bind to 8788
    const testAuthToken = "test-secret-hardening-v121";

    before(async () => {
      serverInstance = createServer({
        port: testPort,
        host: "127.0.0.1",
        authToken: testAuthToken,
      });
      runningServer = await serverInstance.start();
    });

    after(async () => {
      if (serverInstance && runningServer) {
        await serverInstance.stop(runningServer);
      }
    });

    it("should NOT create session or send Set-Cookie when authenticating /mcp via query token", async () => {
      const initialSessions = serverInstance.sessionManager.getSessionCount();

      const res = await fetch(`http://127.0.0.1:${testPort}/mcp?token=${testAuthToken}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });

      const setCookie = res.headers.get("set-cookie");
      assert.strictEqual(setCookie, null, "/mcp query token must not issue Set-Cookie");

      const currentSessions = serverInstance.sessionManager.getSessionCount();
      assert.strictEqual(currentSessions, initialSessions, "/mcp query token must not allocate ephemeral session");
    });

    it("should NOT create session or send Set-Cookie when authenticating /sse via query token", async () => {
      const initialSessions = serverInstance.sessionManager.getSessionCount();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 400);

      try {
        const res = await fetch(`http://127.0.0.1:${testPort}/sse?token=${testAuthToken}`, {
          headers: {
            "Accept": "text/event-stream",
          },
          signal: controller.signal,
        });

        const setCookie = res.headers.get("set-cookie");
        assert.strictEqual(setCookie, null, "/sse query token must not issue Set-Cookie");
      } catch (err: any) {
        if (err.name !== "AbortError") throw err;
      } finally {
        clearTimeout(timeout);
      }

      const currentSessions = serverInstance.sessionManager.getSessionCount();
      assert.strictEqual(currentSessions, initialSessions, "/sse query token must not allocate ephemeral session");
    });

    it("should create session and Set-Cookie when authenticating browser endpoint via query token", async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/dashboard?token=${testAuthToken}`, {
        headers: {
          "Accept": "text/html",
        },
        redirect: "manual",
      });

      const setCookie = res.headers.get("set-cookie");
      assert.ok(setCookie && setCookie.includes("winhelm_session="), "Browser endpoint must issue winhelm_session cookie");

      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get("location"), "/dashboard");
    });
  });
});

describe("Task 6 Hardening - Dashboard Output Encoding & Strict CSP", () => {
  describe("escapeHtml utility", () => {
    it("should escape special HTML characters", () => {
      const malicious = `<script>alert("XSS & injection 'test'")</script>`;
      const escaped = escapeHtml(malicious);
      assert.strictEqual(
        escaped,
        "&lt;script&gt;alert(&quot;XSS &amp; injection &#39;test&#39;&quot;)&lt;/script&gt;"
      );
    });

    it("should safely handle null, undefined, numbers, and boolean values", () => {
      assert.strictEqual(escapeHtml(null), "");
      assert.strictEqual(escapeHtml(undefined), "");
      assert.strictEqual(escapeHtml(123), "123");
      assert.strictEqual(escapeHtml(0), "0");
      assert.strictEqual(escapeHtml(false), "false");
    });
  });

  describe("getDashboardHtml template security", () => {
    it("should include client-side escapeHtml function and escape log elements", () => {
      const html = getDashboardHtml("full");
      assert.ok(html.includes("function escapeHtml("), "Dashboard must include client-side escapeHtml function");
      assert.ok(html.includes("escapeHtml(log.detail)"), "log.detail must be escaped via escapeHtml");
      assert.ok(html.includes("escapeHtml(log.title"), "log.title must be escaped via escapeHtml");
      assert.ok(html.includes("escapeHtml(log.status"), "log.status must be escaped via escapeHtml");
      assert.ok(html.includes("escapeHtml(d.Name)"), "Drive name must be escaped via escapeHtml");
      assert.ok(html.includes("escapeHtml(g.name)"), "GPU name must be escaped via escapeHtml");
    });
  });

  describe("Dashboard Content-Security-Policy headers", () => {
    let serverInstance: any;
    let runningServer: any;
    const testPort = 18792; // Ground rules: Do NOT bind to 8788

    before(async () => {
      serverInstance = createServer({
        port: testPort,
        host: "127.0.0.1",
      });
      runningServer = await serverInstance.start();
    });

    after(async () => {
      if (serverInstance && runningServer) {
        await serverInstance.stop(runningServer);
      }
    });

    it("should return strict Content-Security-Policy headers on GET /", async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/`);
      assert.strictEqual(res.status, 200);
      const csp = res.headers.get("content-security-policy");
      assert.ok(csp, "CSP header must be present on /");
      assert.ok(csp.includes("default-src 'none'"));
      assert.ok(csp.includes("connect-src 'self'"));
      assert.ok(csp.includes("frame-ancestors 'none'"));
      assert.ok(csp.includes("form-action 'none'"));
    });

    it("should return strict Content-Security-Policy headers on GET /dashboard", async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/dashboard`);
      assert.strictEqual(res.status, 200);
      const csp = res.headers.get("content-security-policy");
      assert.ok(csp, "CSP header must be present on /dashboard");
      assert.ok(csp.includes("default-src 'none'"));
      assert.ok(csp.includes("connect-src 'self'"));
      assert.ok(csp.includes("frame-ancestors 'none'"));
      assert.ok(csp.includes("form-action 'none'"));
    });
  });
});

describe("Task 7 Hardening - Startup Network Exposure Gate", () => {
  describe("isLoopbackHost", () => {
    it("should identify IPv4 and IPv6 loopback addresses correctly", () => {
      assert.strictEqual(isLoopbackHost("127.0.0.1"), true);
      assert.strictEqual(isLoopbackHost("localhost"), true);
      assert.strictEqual(isLoopbackHost("::1"), true);
      assert.strictEqual(isLoopbackHost("[::1]"), true);
      assert.strictEqual(isLoopbackHost("127.0.0.2"), true);
      assert.strictEqual(isLoopbackHost("127.100.200.254"), true);
    });

    it("should reject non-loopback addresses including 0.0.0.0, LAN IPs, and wildcards", () => {
      assert.strictEqual(isLoopbackHost("0.0.0.0"), false, "0.0.0.0 binds to all interfaces and is not loopback");
      assert.strictEqual(isLoopbackHost("::"), false, ":: binds to all IPv6 interfaces and is not loopback");
      assert.strictEqual(isLoopbackHost("192.168.1.1"), false);
      assert.strictEqual(isLoopbackHost("10.0.0.1"), false);
      assert.strictEqual(isLoopbackHost("100.64.0.1"), false);
      assert.strictEqual(isLoopbackHost(""), false);
      assert.strictEqual(isLoopbackHost(undefined), false);
      assert.strictEqual(isLoopbackHost(null), false);
    });
  });

  describe("validateNetworkExposure", () => {
    it("should permit stdio transport without authentication regardless of host", () => {
      const res = validateNetworkExposure({
        host: "0.0.0.0",
        isStdio: true,
        authToken: undefined,
      });
      assert.strictEqual(res.allowed, true);
    });

    it("should permit loopback interfaces without authentication token", () => {
      const res1 = validateNetworkExposure({
        host: "127.0.0.1",
        isStdio: false,
        authToken: undefined,
      });
      assert.strictEqual(res1.allowed, true);

      const res2 = validateNetworkExposure({
        host: "localhost",
        isStdio: false,
        authToken: null,
      });
      assert.strictEqual(res2.allowed, true);
    });

    it("should block non-loopback interface (0.0.0.0, LAN) when authToken is missing", () => {
      const res0 = validateNetworkExposure({
        host: "0.0.0.0",
        isStdio: false,
        authToken: undefined,
      });
      assert.strictEqual(res0.allowed, false);
      assert.ok(res0.error?.includes("Server cannot bind to non-loopback address"));

      const resLan = validateNetworkExposure({
        host: "192.168.1.50",
        isStdio: false,
        authToken: "",
      });
      assert.strictEqual(resLan.allowed, false);
      assert.ok(resLan.error?.includes("without an authentication token"));
    });

    it("should permit non-loopback interface when authToken is provided", () => {
      const res0 = validateNetworkExposure({
        host: "0.0.0.0",
        isStdio: false,
        authToken: "valid-secret-token",
      });
      assert.strictEqual(res0.allowed, true);

      const resLan = validateNetworkExposure({
        host: "192.168.1.50",
        isStdio: false,
        authToken: "valid-secret-token",
      });
      assert.strictEqual(resLan.allowed, true);
    });
  });
});

// ─── Task 9: Robustness Caps & Safe Process Cleanup ───────────────────────────

import { isHostAllowed } from "../../src/gateway/server.js";
import { getFilePreviewHtml } from "../../src/gateway/preview-html.js";

describe("Task 9 — Robustness Caps & Safe Process Cleanup", () => {
  describe("isHostAllowed — 0.0.0.0 rejection", () => {
    it("should reject Host: 0.0.0.0 even when bindHost is 0.0.0.0", () => {
      assert.strictEqual(
        isHostAllowed("0.0.0.0", ["localhost"], "0.0.0.0"),
        false,
        "0.0.0.0 is a bind address and must never be allowed as a request Host"
      );
    });

    it("should reject Host: 0.0.0.0:8788 with port", () => {
      assert.strictEqual(isHostAllowed("0.0.0.0:8788", ["localhost"], "127.0.0.1"), false);
    });

    it("should still permit loopback 127.0.0.1 normally", () => {
      assert.strictEqual(isHostAllowed("127.0.0.1", [], "127.0.0.1"), true);
    });

    it("should permit explicit bind host when it is not 0.0.0.0", () => {
      assert.strictEqual(isHostAllowed("192.168.1.50", [], "192.168.1.50"), true);
    });
  });

  describe("getFilePreviewHtml — 5 MB file size guard", () => {
    let bigFilePath: string;

    before(async () => {
      bigFilePath = path.join(os.tmpdir(), `winhelm-preview-bigfile-${Date.now()}.txt`);
      const buf = Buffer.alloc(5 * 1024 * 1024 + 1, "x");
      await fs.writeFile(bigFilePath, buf);
    });

    after(async () => {
      try { await fs.rm(bigFilePath, { force: true }); } catch { /* ignore */ }
    });

    it("should reject files larger than 5 MB with an error page", async () => {
      const cm = ConfigManager.resetInstance();
      await cm.init({ allowedDirectories: [os.tmpdir()] });
      const html = await getFilePreviewHtml(bigFilePath);
      assert.ok(html.includes("too large"), `Expected 'too large' in error page, got: ${html.slice(0, 200)}`);
    });
  });

  describe("runPowerShell — stdout buffer capped at 1 MB", () => {
    before(async () => {
      const cm = ConfigManager.resetInstance();
      await cm.init({ allowedDirectories: ["D:\\"] });
    });

    it("should truncate stdout to at most 1 MB when output exceeds the cap", async () => {
      const lineKb = "A".repeat(1023);
      const lines = 2048;
      const command = `1..${lines} | ForEach-Object { '${lineKb}' }`;
      const result = await runPowerShell(command, { timeoutMs: 30000 });
      const byteLen = Buffer.byteLength(result.stdout, "utf-8");
      assert.ok(
        byteLen <= 1 * 1024 * 1024,
        `stdout exceeds 1MB cap: got ${byteLen} bytes`
      );
    });
  });
});



