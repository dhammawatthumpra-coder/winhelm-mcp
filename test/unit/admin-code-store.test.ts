import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdminAuthManager } from "../../src/admin/auth.js";

/**
 * DEF-02b: a code issued by one WinHelm instance (the one owning the local
 * control pipe) must unlock the Dashboard served by another instance.
 */
describe("Admin code cross-process store", () => {
  it("lets a different process exchange a code issued elsewhere", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-admin-code-")
    );
    const storePath = path.join(root, "admin-code.json");
    try {
      // Instance A: owns the local control pipe and issues the code.
      const issuer = new AdminAuthManager({
        sharedCodeStore: true,
        codeStorePath: storePath,
      });
      const issued = issuer.issueCode();

      // Instance B: serves the Dashboard and never saw the code in memory.
      const dashboard = new AdminAuthManager({
        sharedCodeStore: true,
        codeStorePath: storePath,
      });
      const session = dashboard.exchangeCode(issued.code);
      assert.ok(session, "dashboard must accept a code issued elsewhere");
      assert.ok(session!.csrfToken.length >= 32);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("consumes a shared code exactly once", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-admin-code-once-")
    );
    const storePath = path.join(root, "admin-code.json");
    try {
      const issuer = new AdminAuthManager({
        sharedCodeStore: true,
        codeStorePath: storePath,
      });
      const issued = issuer.issueCode();
      const dashboardA = new AdminAuthManager({
        sharedCodeStore: true,
        codeStorePath: storePath,
      });
      const dashboardB = new AdminAuthManager({
        sharedCodeStore: true,
        codeStorePath: storePath,
      });
      assert.ok(dashboardA.exchangeCode(issued.code));
      assert.strictEqual(dashboardB.exchangeCode(issued.code), undefined);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never stores the code itself, only a digest", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-admin-code-digest-")
    );
    const storePath = path.join(root, "admin-code.json");
    try {
      const issuer = new AdminAuthManager({
        sharedCodeStore: true,
        codeStorePath: storePath,
      });
      const issued = issuer.issueCode();
      const raw = await fs.readFile(storePath, "utf8");
      assert.ok(!raw.includes(issued.code), "raw code must not be stored");
      const parsed = JSON.parse(raw);
      assert.match(parsed.digestHex, /^[0-9a-f]{64}$/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an expired shared code and refresh invalidates the previous one", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-admin-code-expiry-")
    );
    const storePath = path.join(root, "admin-code.json");
    try {
      let now = 1_000;
      const issuer = new AdminAuthManager({
        now: () => now,
        codeTtlMs: 60_000,
        sharedCodeStore: true,
        codeStorePath: storePath,
      });
      const first = issuer.issueCode();
      now += 60_000;
      const dashboard = new AdminAuthManager({
        now: () => now,
        sharedCodeStore: true,
        codeStorePath: storePath,
      });
      assert.strictEqual(dashboard.exchangeCode(first.code), undefined);

      const second = issuer.refreshCode();
      assert.strictEqual(dashboard.exchangeCode(first.code), undefined);
      assert.ok(dashboard.exchangeCode(second.code));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});