import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { ConfigManager } from "../../src/config/config-manager.js";
import { createServer } from "../../src/gateway/server.js";
import {
  getAdminAuthManager,
  resetAdminAuthManager,
} from "../../src/admin/runtime.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";

const FAKE_CLIENT = path.resolve(
  import.meta.dirname,
  "../fixtures/m3a-p2/fake-tunnel-client.mjs"
);

function cookiePair(setCookie: string | null): string {
  assert.ok(setCookie, "Expected Set-Cookie header");
  return setCookie.split(";")[0];
}

async function hashTree(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  const lines: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      const data = await fs.readFile(full);
      lines.push(`${full}:${data.length}`);
    }
  }
  return lines.join("\n");
}

async function makeFakeBackend(dir: string): Promise<{ root: string; configPath: string; markerPath: string; head: string }> {
  const root = path.join(dir, "backend");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "process.exit(0);\n", "utf8");
  const configPath = path.join(root, "winhelm.config.json");
  await fs.writeFile(configPath, "{}\n", "utf8");
  await fs.writeFile(path.join(root, "start-active-stdio.ps1"), "# fixture\n", "utf8");
  await fs.writeFile(path.join(root, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "--no-gpg-sign", "-m", "fixture"], { stdio: "ignore" });
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const markerPath = path.join(dir, "winhelm.active-backend.json");
  await fs.writeFile(
    markerPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "fixture",
      backendRoot: root,
      expectedHead: head,
      configPath,
    }),
    "utf8"
  );
  return { root, configPath, markerPath, head };
}

/**
 * M3A P2 — Admin-plane ChatGPT tunnel lifecycle endpoints: session-gated
 * read-only status, CSRF + typed-confirmation mutations, managed start/stop
 * against a deterministic fake tunnel-client, and the external no-kill rule.
 * The real tunnel-client daemon, profile, and active-backend marker are never
 * touched; all state lives in a scratch WINHELM_TUNNEL_STATE_DIR.
 */
describe("M3A P2: admin tunnel lifecycle endpoints", () => {
  let root: string;
  let stateDir: string;
  let backend: { root: string; configPath: string; markerPath: string; head: string };
  let profilePath: string;
  const savedEnv: Record<string, string | undefined> = {};

  function captureEnv(): void {
    for (const key of [
      "WINHELM_TUNNEL_STATE_DIR",
      "WINHELM_ACTIVE_BACKEND_MARKER",
      "FAKE_TUNNEL_VERSION",
      "FAKE_TUNNEL_REFUSE_DUPLICATE",
      "FAKE_TUNNEL_CRASH_BEFORE_READY_MS",
    ]) {
      savedEnv[key] = process.env[key];
    }
  }

  function restoreEnv(): void {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-m3a-p2-admin-"));
    stateDir = path.join(root, "tunnel-state");
    backend = await makeFakeBackend(root);
    profilePath = path.join(root, "profile.yaml");
    await fs.writeFile(profilePath, "fake: profile\n", "utf8");
    captureEnv();
    process.env.WINHELM_TUNNEL_STATE_DIR = stateDir;
    delete process.env.WINHELM_ACTIVE_BACKEND_MARKER;
    delete process.env.FAKE_TUNNEL_VERSION;
    delete process.env.FAKE_TUNNEL_REFUSE_DUPLICATE;
    delete process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS;

    const configFile = path.join(root, "winhelm.config.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({ schemaVersion: 2, folders: [], terminal: { mode: "off" } }),
      "utf8"
    );
    ConfigManager.resetInstance(configFile);
    resetAdminAuthManager();
    resetApprovalEngine();
  });

  afterEach(async () => {
    restoreEnv();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function setupServer() {
    const instance = createServer({
      port: 0,
      host: "127.0.0.1",
      authToken: "mcp-secret",
    });
    const server = await instance.start();
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const issued = getAdminAuthManager().issueCode();
    const exchange = await fetch(`${base}/admin/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ code: issued.code }),
    });
    assert.strictEqual(exchange.status, 200);
    const adminCookie = cookiePair(exchange.headers.get("set-cookie"));
    const csrf = ((await exchange.json()) as any).csrfToken as string;
    const headers = {
      Cookie: adminCookie,
      Origin: base,
      "x-winhelm-csrf": csrf,
      "Content-Type": "application/json",
    };
    return { base, headers, close: () => instance.stop(server) };
  }

  async function configureTunnel(headers: Record<string, string>, base: string): Promise<void> {
    const res = await fetch(`${base}/admin/tunnel/configure`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        executablePath: process.execPath,
        executableArgs: [FAKE_CLIENT],
        profilePath,
        markerPath: backend.markerPath,
      }),
    });
    assert.strictEqual(res.status, 200, `configure failed: ${JSON.stringify(await res.json())}`);
  }

  it("gates tunnel status behind an admin session and keeps it read-only", async () => {
    const { base, headers, close } = await setupServer();
    try {
      const unauth = await fetch(`${base}/admin/tunnel/status`);
      assert.strictEqual(unauth.status, 401);

      await configureTunnel(headers, base);
      const before = await hashTree(stateDir);
      const res = await fetch(`${base}/admin/tunnel/status`, {
        headers: { Cookie: headers.Cookie },
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as any;
      assert.ok(body.status, "status response must wrap a status projection");
      assert.strictEqual(body.status.dependency.state, "qualified");
      assert.strictEqual(body.status.profile.state, "ready");
      assert.strictEqual(body.status.backend.state, "ready");
      assert.strictEqual(body.status.daemon.ownership, "none");
      const after = await hashTree(stateDir);
      assert.strictEqual(after, before, "status GET must not mutate tunnel state");
    } finally {
      await close();
    }
  });

  it("requires CSRF and an admin session for configure, and persists only non-secret settings", async () => {
    const { base, headers, close } = await setupServer();
    try {
      const noOrigin = await fetch(`${base}/admin/tunnel/configure`, {
        method: "POST",
        headers: { Cookie: headers.Cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ executablePath: process.execPath }),
      });
      assert.strictEqual(noOrigin.status, 403);

      const noCsrf = await fetch(`${base}/admin/tunnel/configure`, {
        method: "POST",
        headers: { Cookie: headers.Cookie, Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ executablePath: process.execPath }),
      });
      assert.strictEqual(noCsrf.status, 403);

      const ok = await fetch(`${base}/admin/tunnel/configure`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          executablePath: process.execPath,
          executableArgs: [FAKE_CLIENT],
          profilePath,
          markerPath: backend.markerPath,
        }),
      });
      assert.strictEqual(ok.status, 200);

      // Persisted state must contain only non-secret lifecycle settings.
      const configRaw = await fs.readFile(
        path.join(stateDir, "lifecycle-config.json"),
        "utf8"
      );
      const persisted = JSON.parse(configRaw) as Record<string, unknown>;
      assert.strictEqual(persisted.schemaVersion, 1);
      assert.strictEqual(persisted.executablePath, process.execPath);
      assert.ok(!/token|secret|password|apikey/i.test(
        Object.keys(persisted).join(",")
      ));
    } finally {
      await close();
    }
  });

  it("requires typed confirmation for start and fails closed without it", async () => {
    const { base, headers, close } = await setupServer();
    try {
      await configureTunnel(headers, base);
      const res = await fetch(`${base}/admin/tunnel/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "nope" }),
      });
      assert.strictEqual(res.status, 409);
      const body = (await res.json()) as any;
      assert.strictEqual(body.error.code, "MANDATORY_CONFIRMATION_REQUIRED");
    } finally {
      await close();
    }
  });

  it("starts, reports managed_ready, rejects duplicate start, and stops with confirmation", async () => {
    const { base, headers, close } = await setupServer();
    try {
      await configureTunnel(headers, base);

      const start = await fetch(`${base}/admin/tunnel/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "confirm" }),
      });
      assert.strictEqual(start.status, 200);
      const startBody = (await start.json()) as any;
      assert.strictEqual(startBody.status.daemon.ownership, "managed");
      assert.strictEqual(startBody.status.daemon.state, "managed_ready");
      assert.ok(startBody.status.daemon.pid > 0);

      const duplicate = await fetch(`${base}/admin/tunnel/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "confirm" }),
      });
      assert.strictEqual(duplicate.status, 409);
      const duplicateBody = (await duplicate.json()) as any;
      assert.strictEqual(duplicateBody.error.code, "MANAGED_ALREADY_RUNNING");

      const stopNoConfirm = await fetch(`${base}/admin/tunnel/stop`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      assert.strictEqual(stopNoConfirm.status, 409);

      const stop = await fetch(`${base}/admin/tunnel/stop`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "ยืนยัน" }),
      });
      assert.strictEqual(stop.status, 200);
      const stopBody = (await stop.json()) as any;
      assert.strictEqual(stopBody.status.daemon.ownership, "none");
      assert.strictEqual(stopBody.status.daemon.state, "stopped");
    } finally {
      await close();
    }
  });

  it("restarts a managed tunnel through the same admin contract", async () => {
    const { base, headers, close } = await setupServer();
    try {
      await configureTunnel(headers, base);
      await fetch(`${base}/admin/tunnel/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "confirm" }),
      });
      const restart = await fetch(`${base}/admin/tunnel/restart`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "confirm" }),
      });
      assert.strictEqual(restart.status, 200);
      const restartBody = (await restart.json()) as any;
      assert.strictEqual(restartBody.status.daemon.state, "managed_ready");
      await fetch(`${base}/admin/tunnel/stop`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "confirm" }),
      });
    } finally {
      await close();
    }
  });

  it("refuses to stop an external unmanaged daemon and keeps it alive", async () => {
    const http = await import("node:http");
    const external = http.createServer((req, res) => {
      if ((req.url || "").split("?")[0] === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("live");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
    const address = external.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const { base, headers, close } = await setupServer();
      try {
        await fetch(`${base}/admin/tunnel/configure`, {
          method: "POST",
          headers,
          body: JSON.stringify({ healthUrl: `http://127.0.0.1:${port}` }),
        });
        const status = await fetch(`${base}/admin/tunnel/status`, {
          headers: { Cookie: headers.Cookie },
        });
        const body = (await status.json()) as any;
        assert.strictEqual(body.status.daemon.ownership, "external");
        assert.strictEqual(body.status.daemon.state, "external_running");
        assert.strictEqual(body.status.daemon.stopRestartAvailable, false);

        const stop = await fetch(`${base}/admin/tunnel/stop`, {
          method: "POST",
          headers,
          body: JSON.stringify({ confirmation: "confirm" }),
        });
        assert.strictEqual(stop.status, 409);
        const stopBody = (await stop.json()) as any;
        assert.strictEqual(stopBody.error.code, "TUNNEL_NOT_MANAGED");
        const probe = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.strictEqual(probe.status, 200, "external daemon must remain untouched");
      } finally {
        await close();
      }
    } finally {
      (external as unknown as { closeAllConnections: () => void }).closeAllConnections();
      await new Promise<void>((resolve) => external.close(() => resolve()));
    }
  });

  it("maps a stale backend marker to a bounded 409 with the blocking reason", async () => {
    const { base, headers, close } = await setupServer();
    try {
      await fetch(`${base}/admin/tunnel/configure`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          executablePath: process.execPath,
          executableArgs: [FAKE_CLIENT],
          profilePath,
          markerPath: backend.markerPath,
        }),
      });
      // Corrupt the marker to pin a stale HEAD (marker is a scratch fixture,
      // not the real active-backend marker).
      const marker = JSON.parse(await fs.readFile(backend.markerPath, "utf8")) as Record<string, unknown>;
      marker.expectedHead = "1".repeat(40);
      await fs.writeFile(backend.markerPath, JSON.stringify(marker), "utf8");

      const start = await fetch(`${base}/admin/tunnel/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "confirm" }),
      });
      assert.strictEqual(start.status, 409);
      const body = (await start.json()) as any;
      assert.strictEqual(body.error.code, "BACKEND_NOT_READY");
      assert.strictEqual(body.error.details?.reason, "HEAD_MISMATCH");
    } finally {
      await close();
    }
  });
});
