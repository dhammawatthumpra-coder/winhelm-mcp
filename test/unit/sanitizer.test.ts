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
});
