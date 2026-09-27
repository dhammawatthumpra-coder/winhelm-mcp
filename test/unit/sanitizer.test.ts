import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText, sanitizeObject } from "../../src/utils/sanitizer.js";

describe("Sanitizer & Secret Masking", () => {
  it("should mask Bearer tokens", () => {
    const raw = "Authorization: Bearer secret-token-xyz-123456";
    const sanitized = sanitizeText(raw);
    assert.ok(!sanitized.includes("secret-token-xyz-123456"));
    assert.ok(sanitized.includes("Bearer ************"));
  });

  it("should mask API keys (sk-..., ghp_...)", () => {
    const raw = "OpenAI key: sk-abcdef1234567890abcdef123456 and GitHub: ghp_1234567890abcdef123456";
    const sanitized = sanitizeText(raw);
    assert.ok(!sanitized.includes("sk-abcdef1234567890abcdef123456"));
    assert.ok(!sanitized.includes("ghp_1234567890abcdef123456"));
  });

  it("should mask password fields in objects", () => {
    const payload = {
      user: "admin",
      password: "SuperSecretPassword123!",
      nested: {
        api_key: "my-secret-key-value",
        normal: "hello",
      },
    };

    const clean = sanitizeObject(payload) as any;
    assert.strictEqual(clean.user, "admin");
    assert.strictEqual(clean.password, "************");
    assert.strictEqual(clean.nested.normal, "hello");
    assert.strictEqual(clean.nested.api_key, "************");
  });

  it("should sanitize secrets in logger.req console output without breaking ANSI escape codes", async () => {
    const { Logger } = await import("../../src/utils/logger.js");
    const logger = Logger.getInstance();
    const originalConsoleLog = console.log;
    const captured: string[] = [];

    console.log = (...args: any[]) => {
      captured.push(args.join(" "));
    };

    try {
      // 1. Call logger.req with sensitive query parameter
      logger.req("GET", "/mcp?token=supersecret123", 200, 10, "127.0.0.1");

      assert.strictEqual(captured.length, 1);
      const logLine = captured[0];

      // Must NOT contain sensitive token
      assert.ok(!logLine.includes("supersecret123"), "Sensitive token leaked in console log!");
      assert.ok(logLine.includes("token=************"));

      // 2. ANSI escape codes must remain intact (\x1b[36m for cyan [HTTP], \x1b[32m for green 200, etc.)
      assert.ok(logLine.includes("\x1b[36m[HTTP]\x1b[0m"));
      assert.ok(logLine.includes("\x1b[32m200\x1b[0m"));

      // 3. Normal query strings like /preview?path=README.md must not be over-masked
      captured.length = 0;
      logger.req("GET", "/preview?path=README.md", 200, 5, "127.0.0.1");
      assert.strictEqual(captured.length, 1);
      const normalLog = captured[0];
      assert.ok(normalLog.includes("/preview?path=README.md"), "Normal path parameter was over-masked!");
    } finally {
      console.log = originalConsoleLog;
    }
  });
});
