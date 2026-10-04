import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ConfigManager } from "../../src/config/config-manager.js";
import { createServer } from "../../src/gateway/server.js";
import {
  defaultAuthTokenPath,
  isValidAuthToken,
  readStoredAuthToken,
  resolveStartupAuthToken,
  writeStoredAuthToken,
} from "../../src/config/auth-token-store.js";
import { rotateAuthToken } from "../../src/config/auth-token-rotation.js";
import {
  getAdminAuthManager,
  resetAdminAuthManager,
} from "../../src/admin/runtime.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";

async function withTempDir(
  prefix: string,
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const previousStore = process.env.WINHELM_AUTH_TOKEN_PATH;
  try {
    await fn(dir);
  } finally {
    if (previousStore === undefined) {
      delete process.env.WINHELM_AUTH_TOKEN_PATH;
    } else {
      process.env.WINHELM_AUTH_TOKEN_PATH = previousStore;
    }
    ConfigManager.resetInstance();
    resetAdminAuthManager();
    resetApprovalEngine();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function cookiePair(setCookie: string | null): string {
  assert.ok(setCookie, "Expected Set-Cookie header");
  return setCookie.split(";")[0];
}

describe("Auth token store", () => {
  it("reports a missing store and a stored token", async () => {
    await withTempDir("winhelm-token-store-", async (dir) => {
      const filePath = path.join(dir, "auth-token");

      const missing = readStoredAuthToken(filePath);
      assert.strictEqual(missing.state, "missing");
      assert.strictEqual(missing.token, undefined);

      const token = "unit-test-token-value-123456";
      await writeStoredAuthToken(token, filePath);

      const stored = readStoredAuthToken(filePath);
      assert.strictEqual(stored.state, "ok");
      assert.strictEqual(stored.token, token);
    });
  });

  it("rejects short, whitespace, and empty tokens", async () => {
    await withTempDir("winhelm-token-invalid-", async (dir) => {
      const filePath = path.join(dir, "auth-token");

      assert.strictEqual(isValidAuthToken("short"), false);
      assert.strictEqual(
        isValidAuthToken("has space inside value 1234"),
        false
      );
      assert.strictEqual(isValidAuthToken(""), false);
      assert.strictEqual(
        isValidAuthToken("x".repeat(600)),
        false
      );

      await fs.writeFile(filePath, "tiny\n", "utf8");
      assert.strictEqual(readStoredAuthToken(filePath).state, "invalid");

      await assert.rejects(
        writeStoredAuthToken("tiny", filePath),
        /invalid WinHelm auth token/
      );
    });
  });

  it("treats an unreadable store as a failure, not as absent", async () => {
    await withTempDir("winhelm-token-unreadable-", async (dir) => {
      const filePath = path.join(dir, "auth-token");
      await fs.mkdir(filePath, { recursive: true });

      assert.strictEqual(
        readStoredAuthToken(filePath).state,
        "unreadable"
      );
    });
  });

  it("prefers --auth, then the store, then the config field", () => {
    const stored = {
      state: "ok" as const,
      token: "stored-token-value-1234",
      path: "fixture",
    };

    assert.strictEqual(
      resolveStartupAuthToken({
        cliToken: "cli-token-value-123456",
        stored,
        configToken: "config-token-value-1234",
      }),
      "cli-token-value-123456"
    );
    assert.strictEqual(
      resolveStartupAuthToken({
        stored,
        configToken: "config-token-value-1234",
      }),
      "stored-token-value-1234"
    );
    assert.strictEqual(
      resolveStartupAuthToken({
        stored: { state: "missing", path: "fixture" },
        configToken: "config-token-value-1234",
      }),
      "config-token-value-1234"
    );
    assert.strictEqual(
      resolveStartupAuthToken({ stored: { state: "missing", path: "fixture" } }),
      undefined
    );
  });

  it("keeps the default store path inside the protected data directory", async () => {
    await withTempDir("winhelm-token-path-", async (dir) => {
      delete process.env.WINHELM_AUTH_TOKEN_PATH;
      assert.strictEqual(
        defaultAuthTokenPath(),
        path.join(os.homedir(), ".winhelm", "auth-token")
      );

      const configFile = path.join(dir, "config.json");
      await fs.writeFile(
        configFile,
        JSON.stringify({
          schemaVersion: 2,
          folders: [],
          terminal: { mode: "off" },
          toolPolicy: {},
        }),
        "utf8"
      );
      const manager = ConfigManager.resetInstance(configFile);
      await manager.init(configFile);

      assert.strictEqual(
        manager.checkPathAccess(defaultAuthTokenPath(), "write").allowed,
        false
      );
      assert.strictEqual(
        manager.checkPathAccess(defaultAuthTokenPath(), "read").allowed,
        false
      );
    });
  });
});

describe("Auth token rotation", () => {
  it("persists the new token, applies it, and keeps the old token on write failure", async () => {
    await withTempDir("winhelm-token-rotate-", async (dir) => {
      const storePath = path.join(dir, "auth-token");
      const manager = ConfigManager.getInstance();
      manager.setRuntimeAuthToken("old-token-value-123456");

      const rotated = await rotateAuthToken({ manager, storePath });
      assert.ok(isValidAuthToken(rotated.token));
      assert.strictEqual(manager.getRuntimeAuthToken(), rotated.token);
      assert.strictEqual(
        readStoredAuthToken(storePath).token,
        rotated.token
      );

      // A store path that cannot be written must leave the live token intact.
      const blocked = path.join(dir, "blocked");
      await fs.mkdir(blocked, { recursive: true });
      await assert.rejects(
        rotateAuthToken({ manager, storePath: blocked })
      );
      assert.strictEqual(manager.getRuntimeAuthToken(), rotated.token);
    });
  });

  it("invalidates the previous token over HTTP and accepts the new one", async () => {
    await withTempDir("winhelm-token-http-", async (dir) => {
      process.env.WINHELM_AUTH_TOKEN_PATH = path.join(dir, "auth-token");
      const manager = ConfigManager.getInstance();
      const instance = createServer({
        port: 0,
        host: "127.0.0.1",
        authToken: "old-token-value-123456",
      });
      const server = await instance.start();
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const call = (token: string) =>
        fetch(`${base}/api/monitor/stats`, {
          headers: { Authorization: `Bearer ${token}` },
        });

      try {
        assert.strictEqual((await call("old-token-value-123456")).status, 200);

        const rotated = await rotateAuthToken({
          manager,
          storePath: process.env.WINHELM_AUTH_TOKEN_PATH,
        });

        assert.strictEqual(
          (await call("old-token-value-123456")).status,
          401
        );
        assert.strictEqual((await call(rotated.token)).status, 200);
      } finally {
        await instance.stop(server);
      }
    });
  });

  it("rotates through the admin API and reports the new token once", async () => {
    await withTempDir("winhelm-token-admin-", async (dir) => {
      process.env.WINHELM_AUTH_TOKEN_PATH = path.join(dir, "auth-token");
      const instance = createServer({
        port: 0,
        host: "127.0.0.1",
        authToken: "old-token-value-123456",
      });
      const server = await instance.start();
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      try {
        const issued = getAdminAuthManager().issueCode();
        const exchange = await fetch(`${base}/admin/auth/exchange`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: base,
          },
          body: JSON.stringify({ code: issued.code }),
        });
        assert.strictEqual(exchange.status, 200);
        const adminCookie = cookiePair(exchange.headers.get("set-cookie"));
        const csrf = ((await exchange.json()) as any).csrfToken as string;

        const missingCsrf = await fetch(
          `${base}/admin/auth/token/rotate`,
          {
            method: "POST",
            headers: { Cookie: adminCookie, Origin: base },
          }
        );
        assert.strictEqual(missingCsrf.status, 403);

        const missingConfirmation = await fetch(
          `${base}/admin/auth/token/rotate`,
          {
            method: "POST",
            headers: {
              Cookie: adminCookie,
              Origin: base,
              "x-winhelm-csrf": csrf,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          }
        );
        assert.strictEqual(missingConfirmation.status, 409);
        const missingConfirmationBody =
          (await missingConfirmation.json()) as any;
        assert.strictEqual(
          missingConfirmationBody.error.code,
          "MANDATORY_CONFIRMATION_REQUIRED"
        );

        const rotated = await fetch(`${base}/admin/auth/token/rotate`, {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ confirmation: "confirm" }),
        });
        assert.strictEqual(rotated.status, 200);
        const body = (await rotated.json()) as any;
        assert.ok(isValidAuthToken(body.token));
        assert.notStrictEqual(body.token, "old-token-value-123456");

        const oldTokenCall = await fetch(`${base}/api/monitor/stats`, {
          headers: { Authorization: "Bearer old-token-value-123456" },
        });
        assert.strictEqual(oldTokenCall.status, 401);

        const newTokenCall = await fetch(`${base}/api/monitor/stats`, {
          headers: { Authorization: `Bearer ${body.token}` },
        });
        assert.strictEqual(newTokenCall.status, 200);

        assert.strictEqual(
          readStoredAuthToken(process.env.WINHELM_AUTH_TOKEN_PATH!).token,
          body.token
        );
      } finally {
        await instance.stop(server);
      }
    });
  });

  it("refuses to rotate when no token is configured", async () => {
    await withTempDir("winhelm-token-none-", async (dir) => {
      process.env.WINHELM_AUTH_TOKEN_PATH = path.join(dir, "auth-token");

      // Hermetic config: a developer's local config must not decide this test.
      const configFile = path.join(dir, "config.json");
      await fs.writeFile(
        configFile,
        JSON.stringify({
          allowedDirectories: [],
          profile: "full",
          readOnly: false,
        }),
        "utf8"
      );
      const manager = ConfigManager.resetInstance(configFile);
      await manager.init(configFile);
      assert.ok(!manager.getConfig().authToken);
      manager.setRuntimeAuthToken(undefined);

      const instance = createServer({
        port: 0,
        host: "127.0.0.1",
        authToken: null,
      });
      const server = await instance.start();
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      try {
        const issued = getAdminAuthManager().issueCode();
        const exchange = await fetch(`${base}/admin/auth/exchange`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: base,
          },
          body: JSON.stringify({ code: issued.code }),
        });
        const adminCookie = cookiePair(exchange.headers.get("set-cookie"));
        const csrf = ((await exchange.json()) as any).csrfToken as string;

        const rotated = await fetch(`${base}/admin/auth/token/rotate`, {
          method: "POST",
          headers: {
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
        });
        assert.strictEqual(rotated.status, 409);
        const body = (await rotated.json()) as any;
        assert.strictEqual(body.error.code, "AUTH_TOKEN_NOT_CONFIGURED");
      } finally {
        await instance.stop(server);
      }
    });
  });
});
