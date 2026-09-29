import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { isHostAllowed, safeCompare } from "../../src/gateway/server.js";
import { sanitizeText, sanitizeObject } from "../../src/utils/sanitizer.js";
import { RateLimiter } from "../../src/gateway/rate-limiter.js";
import { SessionManager } from "../../src/gateway/session-manager.js";

describe("Security Boundary Unit Tests (Priority 2.2)", () => {
  describe("isPathAllowed - Path Traversal & Drive Isolation", () => {
    const configManager = ConfigManager.getInstance();

    it("should allow files inside allowedDirectories", async () => {
      const allowedDir = process.cwd();
      await configManager.updateConfig({ allowedDirectories: [allowedDir] }, false);

      const targetFile = path.join(allowedDir, "package.json");
      const check = configManager.isPathAllowed(targetFile);
      assert.strictEqual(check.allowed, true);
    });

    it("should block path traversal attempts escaping the root (../)", async () => {
      const allowedDir = path.join(process.cwd(), "src");
      await configManager.updateConfig({ allowedDirectories: [allowedDir] }, false);

      // Attempting to escape out to parent directory
      const escapePath = path.join(allowedDir, "..", "package.json");
      const check = configManager.isPathAllowed(escapePath);
      assert.strictEqual(check.allowed, false);
      assert.ok(check.reason?.includes("forbidden by allowedDirectories"));
    });

    it("should block forward-slash path traversal escapes (../../)", async () => {
      const allowedDir = path.join(process.cwd(), "src");
      await configManager.updateConfig({ allowedDirectories: [allowedDir] }, false);

      const escapePath = `${allowedDir}/../../Windows/System32/cmd.exe`;
      const check = configManager.isPathAllowed(escapePath);
      assert.strictEqual(check.allowed, false);
    });

    it("should block UNC network paths escaping local boundaries", async () => {
      const allowedDir = process.cwd();
      await configManager.updateConfig({ allowedDirectories: [allowedDir] }, false);

      const uncPath = "\\\\192.168.1.50\\c$\\Windows\\win.ini";
      const check = configManager.isPathAllowed(uncPath);
      assert.strictEqual(check.allowed, false);
    });

    it("should fail-closed when allowedDirectories is empty", async () => {
      await configManager.updateConfig({ allowedDirectories: [] }, false);

      const check = configManager.isPathAllowed(path.join(process.cwd(), "package.json"));
      assert.strictEqual(check.allowed, false);
      assert.ok(check.reason?.includes("no allowedDirectories configured"));
    });

    it("should permit all paths when wildcard ['*'] is set", async () => {
      await configManager.updateConfig({ allowedDirectories: ["*"] }, false);

      const check = configManager.isPathAllowed("C:\\Windows\\win.ini");
      assert.strictEqual(check.allowed, true);

      // Restore allowedDirectories for subsequent tests
      await configManager.updateConfig({ allowedDirectories: [process.cwd()] }, false);
    });

    it("should handle case-insensitive paths correctly on Windows", async () => {
      const allowedDir = process.cwd();
      await configManager.updateConfig({ allowedDirectories: [allowedDir.toLowerCase()] }, false);

      const upperPath = path.join(allowedDir.toUpperCase(), "package.json");
      const check = configManager.isPathAllowed(upperPath);
      assert.strictEqual(check.allowed, true);
    });

    it("should block Unicode full-width and non-canonical path traversal attempts", async () => {
      const allowedDir = process.cwd();
      await configManager.updateConfig({ allowedDirectories: [allowedDir] }, false);

      const unicodeEscape = `${allowedDir}/\uFF0E\uFF0E/Windows/win.ini`;
      const check = configManager.isPathAllowed(unicodeEscape);
      assert.strictEqual(check.allowed, false);
    });

    it("should block cross-drive traversal attempts (e.g. C:\\Windows\\..)", async () => {
      await configManager.updateConfig({ allowedDirectories: ["D:\\allowed_workspace"] }, false);

      const crossDriveEscape = "C:\\Windows\\..\\Users\\admin\\.ssh\\id_rsa";
      const check = configManager.isPathAllowed(crossDriveEscape);
      assert.strictEqual(check.allowed, false);

      // Restore
      await configManager.updateConfig({ allowedDirectories: [process.cwd()] }, false);
    });
  });

  describe("isHostAllowed - DNS Rebinding & Host Header Validation", () => {
    const defaultAllowed = ["localhost", "127.0.0.1", "[::1]", "*.ts.net"];

    it("should permit loopback interfaces", () => {
      assert.strictEqual(isHostAllowed("localhost", defaultAllowed), true);
      assert.strictEqual(isHostAllowed("localhost:8788", defaultAllowed), true);
      assert.strictEqual(isHostAllowed("127.0.0.1", defaultAllowed), true);
      assert.strictEqual(isHostAllowed("127.0.0.1:8788", defaultAllowed), true);
      assert.strictEqual(isHostAllowed("::1", defaultAllowed), true);
      assert.strictEqual(isHostAllowed("[::1]:8788", defaultAllowed), true);
    });

    it("should permit explicitly bound host IP", () => {
      assert.strictEqual(isHostAllowed("192.168.1.100:8788", defaultAllowed, "192.168.1.100"), true);
      assert.strictEqual(isHostAllowed("192.168.1.100", defaultAllowed, "192.168.1.100"), true);
    });

    it("should permit Tailscale CGNAT IPs (100.64.0.0/10)", () => {
      assert.strictEqual(isHostAllowed("100.64.0.1:8788", defaultAllowed), true);
      assert.strictEqual(isHostAllowed("100.100.50.25:8788", defaultAllowed), true);
      assert.strictEqual(isHostAllowed("100.127.255.254:8788", defaultAllowed), true);
    });

    it("should permit Tailscale MagicDNS domains matching *.ts.net", () => {
      assert.strictEqual(isHostAllowed("my-machine.ts.net:8788", defaultAllowed), true);
      assert.strictEqual(isHostAllowed("alpha-beta.ts.net", defaultAllowed), true);
    });

    it("should strictly block DNS Rebinding and unauthorized domains", () => {
      assert.strictEqual(isHostAllowed("attacker.com", defaultAllowed), false);
      assert.strictEqual(isHostAllowed("evil.com:8788", defaultAllowed), false);
      assert.strictEqual(isHostAllowed("localhost.attacker.com", defaultAllowed), false);
      assert.strictEqual(isHostAllowed("127.0.0.1.nip.io:8788", defaultAllowed), false);
      assert.strictEqual(isHostAllowed("my-machine.ts.net.attacker.com", defaultAllowed), false);
      assert.strictEqual(isHostAllowed("", defaultAllowed), false);
      assert.strictEqual(isHostAllowed(undefined, defaultAllowed), false);
    });
  });

  describe("sanitizeText & sanitizeObject - Credential Masking", () => {
    it("should redact Bearer tokens", () => {
      const raw = "Authorization: Bearer super_secret_token_123456";
      const sanitized = sanitizeText(raw);
      assert.ok(!sanitized.includes("super_secret_token_123456"));
      assert.ok(sanitized.includes("Bearer ************"));
    });

    it("should redact API keys (sk-..., ghp_...)", () => {
      const openAi = "API Key: sk-proj-abcdef1234567890xyz";
      assert.ok(!sanitizeText(openAi).includes("abcdef1234567890xyz"));

      const github = "Token: ghp_1234567890abcdefghijklmnopqrstuv";
      assert.ok(!sanitizeText(github).includes("1234567890abcdef"));
    });

    it("should redact AWS Access Keys (AKIA...)", () => {
      const aws = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
      const sanitized = sanitizeText(aws);
      assert.ok(!sanitized.includes("IOSFODNN7EXAMPLE"));
      assert.ok(sanitized.includes("AKIA************"));
    });

    it("should deep-sanitize objects with sensitive keys", () => {
      const payload = {
        name: "test-user",
        authToken: "sensitive-auth-token-12345",
        config: {
          apiKey: "my-secret-key-9999",
          nested: {
            password: "super_secret_password",
            count: 42,
          },
        },
      };

      const clean = sanitizeObject(payload) as any;
      assert.strictEqual(clean.name, "test-user");
      assert.strictEqual(clean.authToken, "************");
      assert.strictEqual(clean.config.apiKey, "************");
      assert.strictEqual(clean.config.nested.password, "************");
      assert.strictEqual(clean.config.nested.count, 42);
    });
  });

  describe("safeCompare - Timing Safe Comparison", () => {
    it("should return true for identical strings", () => {
      assert.strictEqual(safeCompare("hunter2", "hunter2"), true);
      assert.strictEqual(safeCompare("", ""), true);
      assert.strictEqual(safeCompare("a".repeat(100), "a".repeat(100)), true);
    });

    it("should return false for mismatched strings of same length", () => {
      assert.strictEqual(safeCompare("hunter2", "hunter3"), false);
      assert.strictEqual(safeCompare("a".repeat(32), "a".repeat(31) + "b"), false);
    });

    it("should return false for mismatched strings of different lengths", () => {
      assert.strictEqual(safeCompare("hunter2", "hunter"), false);
      assert.strictEqual(safeCompare("short", "much_longer_string"), false);
      assert.strictEqual(safeCompare("", "a"), false);
    });
  });

  describe("RateLimiter - Threshold and Exclusion Boundaries", () => {
    it("should allow requests under rate limit threshold", () => {
      const limiter = new RateLimiter();
      const middleware = limiter.middleware();

      let allowedCount = 0;
      const fakeReq = { ip: "10.0.0.1", path: "/mcp", socket: {} } as any;
      const fakeRes = {
        status: () => ({ json: () => {} }),
      } as any;

      for (let i = 0; i < 5; i++) {
        middleware(fakeReq, fakeRes, () => {
          allowedCount++;
        });
      }
      assert.strictEqual(allowedCount, 5);
    });

    it("should bypass rate limiting for /health and /dashboard", () => {
      const limiter = new RateLimiter();
      const middleware = limiter.middleware();

      let passed = 0;
      const healthReq = { path: "/health" } as any;
      const dashReq = { path: "/dashboard" } as any;
      const fakeRes = {} as any;

      middleware(healthReq, fakeRes, () => passed++);
      middleware(dashReq, fakeRes, () => passed++);

      assert.strictEqual(passed, 2);
    });
  });

  describe("SessionManager - Ephemeral Lifecycle and Sliding Window", () => {
    it("should create unguessable 64-character hex session tokens", () => {
      const sm = new SessionManager(15);
      const sid = sm.createSession({ ip: "127.0.0.1" });
      assert.strictEqual(typeof sid, "string");
      assert.strictEqual(sid.length, 64);
      assert.strictEqual(sm.validateSession(sid), true);
      sm.close();
    });

    it("should reject non-existent or invalid session IDs", () => {
      const sm = new SessionManager(15);
      assert.strictEqual(sm.validateSession("non-existent-session-id"), false);
      assert.strictEqual(sm.validateSession(""), false);
      assert.strictEqual(sm.validateSession(undefined), false);
      sm.close();
    });

    it("should revoke sessions explicitly on logout", () => {
      const sm = new SessionManager(15);
      const sid = sm.createSession();
      assert.strictEqual(sm.validateSession(sid), true);

      sm.revokeSession(sid);
      assert.strictEqual(sm.validateSession(sid), false);
      sm.close();
    });

    it("should enforce single-use only on exchange tokens (Replay Attack Prevention)", () => {
      const sm = new SessionManager(15);
      const exToken = sm.createExchangeToken(5000);
      assert.strictEqual(typeof exToken, "string");
      assert.strictEqual(exToken.length, 64);

      // First consumption MUST succeed
      const firstUse = sm.consumeExchangeToken(exToken);
      assert.strictEqual(firstUse, true);

      // Second consumption (replay attack) MUST fail
      const secondUse = sm.consumeExchangeToken(exToken);
      assert.strictEqual(secondUse, false);

      sm.close();
    });

    it("should reject expired exchange tokens", async () => {
      const sm = new SessionManager(15);
      // Create exchange token with 1ms TTL
      const exToken = sm.createExchangeToken(1);

      await new Promise((r) => setTimeout(r, 15));
      const useExpired = sm.consumeExchangeToken(exToken);
      assert.strictEqual(useExpired, false);
      sm.close();
    });

    it("should throttle cookie refresh until 50% of sliding TTL has elapsed", () => {
      const sm = new SessionManager(15);
      const sid = sm.createSession();

      // Immediately after creation, refresh is NOT needed (< 50% TTL)
      assert.strictEqual(sm.shouldRefreshCookie(sid), false);

      // Fast-forward lastRefreshedAt to 8 minutes ago (> 7.5 min = 50%)
      const session = (sm as any).sessions.get(sid);
      session.lastRefreshedAt = Date.now() - 8 * 60 * 1000;

      assert.strictEqual(sm.shouldRefreshCookie(sid), true);
      sm.markCookieRefreshed(sid);
      assert.strictEqual(sm.shouldRefreshCookie(sid), false);

      sm.close();
    });

    it("should perform periodic memory cleanup and prune expired sessions", async () => {
      const sm = new SessionManager(1); // 1 minute TTL
      const sid1 = sm.createSession();
      const sid2 = sm.createSession();
      const exToken = sm.createExchangeToken(10); // 10ms

      assert.strictEqual(sm.getSessionCount(), 2);
      assert.strictEqual(sm.getExchangeTokenCount(), 1);

      // Force expiration
      const s1 = (sm as any).sessions.get(sid1);
      s1.lastAccessedAt = Date.now() - 2 * 60 * 1000;

      await new Promise((r) => setTimeout(r, 20));

      const pruned = sm.cleanupExpiredSessions();
      assert.ok(pruned >= 2); // 1 expired session + 1 expired exchange token
      assert.strictEqual(sm.getSessionCount(), 1);
      assert.strictEqual(sm.getExchangeTokenCount(), 0);

      sm.close();
    });
  });
});
