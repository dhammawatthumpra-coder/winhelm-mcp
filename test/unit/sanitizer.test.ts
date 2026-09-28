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

  it("should mask AWS access keys (AKIA[0-9A-Z]{16})", () => {
    const raw = "AWS Key: AKIAIOSFODNN7EXAMPLE in log and 'AKIA1234567890ABCDEF'";
    const sanitized = sanitizeText(raw);
    assert.ok(!sanitized.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(!sanitized.includes("AKIA1234567890ABCDEF"));
    assert.ok(sanitized.includes("AKIA************"));

    // Should not alter non-AKIA or invalid lengths
    assert.strictEqual(sanitizeText("AKIA123"), "AKIA123");
    assert.strictEqual(sanitizeText("AKIAIOSFODNN7EXAMPLETOOLONG"), "AKIAIOSFODNN7EXAMPLETOOLONG");
  });

  it("should mask single-line JSON keys like authToken, password, and x-api-key", () => {
    const raw = '{"authToken": "9dd1bbd0266db8a82a4cb3106d018dcdf149f104ab3d5263b0cb6c25c7606aca", "password": "mypassword123", "x-api-key": "secret-key-456"}';
    const sanitized = sanitizeText(raw);

    assert.ok(!sanitized.includes("9dd1bbd0266db8a82a4cb3106d018dcdf149f104ab3d5263b0cb6c25c7606aca"));
    assert.ok(!sanitized.includes("mypassword123"));
    assert.ok(!sanitized.includes("secret-key-456"));

    // Long tokens (>12 chars) masked to 12 asterisks
    assert.ok(sanitized.includes('"authToken": "************"'));
    assert.ok(sanitized.includes('"password": "************"'));
    assert.ok(sanitized.includes('"x-api-key": "************"'));
  });

  it("should mask multi-line JSON keys without corrupting structure or non-sensitive fields", () => {
    const multiLineJson = `{\n  "name": "winhelm-mcp",\n  "author": "Dhammawat",\n  "port": 8788,\n  "authToken": "super-secret-token-value-12345678",\n  "allowedDirectories": []\n}`;
    const sanitized = sanitizeText(multiLineJson);

    // Sensitive field must be masked
    assert.ok(!sanitized.includes("super-secret-token-value-12345678"));
    assert.ok(sanitized.includes('"authToken": "************"'));

    // Non-sensitive fields like name, author, port, allowedDirectories MUST NOT be masked
    assert.ok(sanitized.includes('"name": "winhelm-mcp"'), "Key 'name' should not be masked");
    assert.ok(sanitized.includes('"author": "Dhammawat"'), "Key 'author' should not be masked");
    assert.ok(sanitized.includes('"port": 8788'), "Key 'port' should not be masked");
    assert.ok(sanitized.includes('"allowedDirectories": []'), "Key 'allowedDirectories' should not be masked");
  });

  it("should sanitize logger.toolDone console output and log entry details", async () => {
    const { Logger } = await import("../../src/utils/logger.js");
    const logger = Logger.getInstance();
    const originalConsoleLog = console.log;
    const captured: string[] = [];

    console.log = (...args: any[]) => {
      captured.push(args.join(" "));
    };

    try {
      const sensitiveSummary = 'Read file: { "authToken": "9dd1bbd0266db8a82a4cb3106d018dcdf149f104ab3d5263b0cb6c25c7606aca" }';
      logger.toolDone("file_read", 25, sensitiveSummary);

      assert.strictEqual(captured.length, 1);
      const logLine = captured[0];

      // Console output must NOT leak the token
      assert.ok(!logLine.includes("9dd1bbd0266db8a82a4cb3106d018dcdf149f104ab3d5263b0cb6c25c7606aca"), "Token leaked in toolDone console log!");
      assert.ok(logLine.includes('"authToken": "************"'));

      // Log entry details in logger must also be sanitized
      const recent = logger.getRecentLogs(1)[0];
      assert.strictEqual(recent.type, "tool");
      assert.ok(!recent.detail?.includes("9dd1bbd0266db8a82a4cb3106d018dcdf149f104ab3d5263b0cb6c25c7606aca"));
      assert.ok(recent.detail?.includes('"authToken": "************"'));
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it("should sanitize entries written through FileLogger", async () => {
    const { FileLogger } = await import("../../src/utils/file-logger.js");
    const fileLogger = FileLogger.getInstance();

    const sensitiveEntry = {
      id: "test-id-123",
      timestamp: new Date().toISOString(),
      type: "tool" as const,
      level: "success" as const,
      title: 'tool_done: file_read',
      detail: 'Config: {"authToken": "supersecretkey99999", "name": "winhelm"}',
    };

    fileLogger.log(sensitiveEntry);
    await new Promise((r) => setTimeout(r, 100));

    // Export logs and verify the detail content was sanitized before disk persistence
    const exported = await fileLogger.exportLogs("json");
    assert.ok(!exported.includes("supersecretkey99999"), "Token leaked in persistent file logs!");
    const parsed = JSON.parse(exported);
    const found = parsed.find((e: any) => e.id === "test-id-123");
    assert.ok(found, "Entry should exist in exported logs");
    assert.ok(found.detail.includes('"authToken": "************"'));
    assert.ok(found.detail.includes('"name": "winhelm"'));
  });
});
