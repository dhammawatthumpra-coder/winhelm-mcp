import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdminAuthManager } from "../../src/admin/auth.js";

describe("AdminAuthManager", () => {
  it("exchanges a valid code exactly once", () => {
    const manager = new AdminAuthManager();
    const issued = manager.issueCode();

    const session = manager.exchangeCode(issued.code);
    assert.ok(session);
    assert.ok(session.id.length >= 32);
    assert.ok(session.csrfToken.length >= 32);

    assert.strictEqual(manager.exchangeCode(issued.code), undefined);
  });

  it("does not consume the active code on a wrong attempt", () => {
    const manager = new AdminAuthManager();
    const issued = manager.issueCode();

    assert.strictEqual(manager.exchangeCode("definitely-wrong"), undefined);
    assert.ok(manager.exchangeCode(issued.code));
  });

  it("refresh invalidates the previous code", () => {
    const manager = new AdminAuthManager();
    const first = manager.issueCode();
    const second = manager.refreshCode();

    assert.notStrictEqual(first.code, second.code);
    assert.strictEqual(manager.exchangeCode(first.code), undefined);
    assert.ok(manager.exchangeCode(second.code));
  });

  it("expires a code after the configured TTL", () => {
    let now = 1_000;
    const manager = new AdminAuthManager({
      now: () => now,
      codeTtlMs: 300_000,
    });
    const issued = manager.issueCode();

    now += 300_000;
    assert.strictEqual(manager.exchangeCode(issued.code), undefined);
  });

  it("uses a sliding idle timeout for active admin sessions", () => {
    let now = 10_000;
    const manager = new AdminAuthManager({
      now: () => now,
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 1_000_000,
    });
    const session = manager.exchangeCode(manager.issueCode().code)!;

    now += 40_000;
    assert.ok(manager.validateSession(session.id));

    now += 40_000;
    assert.ok(manager.validateSession(session.id));

    now += 60_000;
    assert.strictEqual(manager.validateSession(session.id), undefined);
  });

  it("enforces absolute lifetime even when the idle window is repeatedly refreshed", () => {
    let now = 10_000;
    const manager = new AdminAuthManager({
      now: () => now,
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 120_000,
    });
    const session = manager.exchangeCode(manager.issueCode().code)!;

    now += 50_000;
    assert.ok(manager.validateSession(session.id));
    now += 50_000;
    assert.ok(manager.validateSession(session.id));
    now += 20_000;

    assert.strictEqual(manager.validateSession(session.id), undefined);
  });

  it("validates CSRF independently from the session cookie", () => {
    const manager = new AdminAuthManager();
    const session = manager.exchangeCode(manager.issueCode().code)!;

    assert.strictEqual(
      manager.validateCsrf(session.id, session.csrfToken),
      true
    );
    assert.strictEqual(
      manager.validateCsrf(session.id, "wrong-csrf-token"),
      false
    );
    assert.strictEqual(
      manager.validateCsrf("wrong-session", session.csrfToken),
      false
    );
  });

  it("supports explicit revocation and cleanup", () => {
    let now = 1_000;
    const manager = new AdminAuthManager({
      now: () => now,
      idleTimeoutMs: 100,
      absoluteLifetimeMs: 10_000,
    });

    const first = manager.exchangeCode(manager.issueCode().code)!;
    assert.strictEqual(manager.revokeSession(first.id), true);
    assert.strictEqual(manager.validateSession(first.id), undefined);

    const second = manager.exchangeCode(manager.issueCode().code)!;
    now += 101;
    assert.strictEqual(manager.cleanup(), 1);
    assert.strictEqual(manager.validateSession(second.id), undefined);
  });

  it("exposes the normative idle and absolute lifetimes in seconds", () => {
    const manager = new AdminAuthManager();
    assert.strictEqual(manager.idleTimeoutSeconds, 3600);
    assert.strictEqual(manager.absoluteLifetimeSeconds, 43200);
  });
});
