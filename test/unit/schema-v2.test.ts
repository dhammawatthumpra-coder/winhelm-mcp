import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/config/default-config.js";
import {
  DEFAULT_APPROVAL_CONFIG,
  isSchemaV2Config,
  normalizeApprovalConfig,
  validateApprovalConfig,
} from "../../src/config/schema-v2.js";
import { evaluateTerminalMode, evaluateToolPolicy } from "../../src/permissions/policy.js";

describe("Schema-v2 configuration primitives", () => {
  it("keeps the v1.2.1 default config on the legacy path", () => {
    assert.strictEqual(DEFAULT_CONFIG.schemaVersion, undefined);
    assert.strictEqual(isSchemaV2Config(DEFAULT_CONFIG), false);
  });

  it("recognizes only schemaVersion=2 as schema-v2", () => {
    assert.strictEqual(isSchemaV2Config({ schemaVersion: 2 }), true);
    assert.strictEqual(isSchemaV2Config({ schemaVersion: 1 }), false);
    assert.strictEqual(isSchemaV2Config({}), false);
    assert.strictEqual(isSchemaV2Config({ schemaVersion: "2" }), false);
  });

  it("uses implementation-baseline approval defaults without mutating input", () => {
    const input = { maxPending: 7 };
    const normalized = normalizeApprovalConfig(input);

    assert.deepStrictEqual(normalized, {
      blockHoldMs: 60_000,
      jobTtlMs: 180_000,
      maxPending: 7,
    });
    assert.deepStrictEqual(input, { maxPending: 7 });
    assert.deepStrictEqual(DEFAULT_APPROVAL_CONFIG, {
      blockHoldMs: 60_000,
      jobTtlMs: 180_000,
      maxPending: 5,
    });
  });

  it("accepts approval values inside the supported implementation envelope", () => {
    const result = validateApprovalConfig({
      blockHoldMs: 30_000,
      jobTtlMs: 120_000,
      maxPending: 10,
    });

    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  it("rejects unsafe or nonsensical approval timing values", () => {
    const result = validateApprovalConfig({
      blockHoldMs: 120_000,
      jobTtlMs: 10_000,
      maxPending: 0,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 3);
    assert.ok(result.errors.some((e) => e.includes("blockHoldMs")));
    assert.ok(result.errors.some((e) => e.includes("jobTtlMs")));
    assert.ok(result.errors.some((e) => e.includes("maxPending")));
  });
});

describe("Schema-v2 permission decision primitives", () => {
  it("maps auto/ask/off tool policy deterministically", () => {
    assert.strictEqual(evaluateToolPolicy("auto").decision, "allow");
    assert.strictEqual(evaluateToolPolicy("ask").decision, "ask");
    assert.strictEqual(evaluateToolPolicy("off").decision, "deny");
  });

  it("fails closed when a schema-v2 tool policy is missing", () => {
    const decision = evaluateToolPolicy(undefined);
    assert.strictEqual(decision.decision, "deny");
    assert.strictEqual(decision.code, "POLICY_OFF");
  });

  it("keeps safe terminal mode distinct from unrestricted execution", () => {
    const safe = evaluateTerminalMode("safe");
    assert.strictEqual(safe.decision, "allow");
    assert.strictEqual(safe.code, "TERMINAL_SAFE");
  });

  it("maps terminal ask/full/off modes without changing legacy code paths", () => {
    assert.strictEqual(evaluateTerminalMode("ask").decision, "ask");
    assert.strictEqual(evaluateTerminalMode("full").decision, "allow");
    assert.strictEqual(evaluateTerminalMode("dangerous").decision, "allow");
    assert.strictEqual(evaluateTerminalMode("off").decision, "deny");
  });
});
