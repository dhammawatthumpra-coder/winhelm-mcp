import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  QUALIFIED_TUNNEL_CLIENT_VERSION,
  TunnelLifecycleError,
  redactTunnelSecrets,
  loadTunnelLifecycleConfig,
  saveTunnelLifecycleConfig,
  loadManagedTunnelState,
  qualifyTunnelDependency,
  evaluateBackendReadiness,
  getTunnelStatus,
  startManagedTunnel,
  stopManagedTunnel,
  restartManagedTunnel,
} from "../../src/integrations/chatgpt-tunnel.js";

const FAKE_CLIENT = path.resolve(
  import.meta.dirname,
  "../fixtures/m3a-p2/fake-tunnel-client.mjs"
);

let scratch: string;
let stateDir: string;
let savedEnv: Record<string, string | undefined>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Builds a scratch fake backend that satisfies the active-backend readiness
 * contract: git repo with tracked launcher, dist/index.js, config file, and a
 * marker pinning the scratch HEAD. Never touches the real active backend.
 */
async function makeFakeBackend(
  dir: string,
  opts: {
    head?: string | null;
    includeDist?: boolean;
    includeConfig?: boolean;
    includeLauncher?: boolean;
    trackLauncher?: boolean;
  } = {}
): Promise<{ root: string; configPath: string; markerPath: string; head: string }> {
  const root = path.join(dir, "backend");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  if (opts.includeDist !== false) {
    await fs.writeFile(
      path.join(root, "dist", "index.js"),
      "process.exit(0);\n",
      "utf8"
    );
  }
  const configPath = path.join(root, "winhelm.config.json");
  if (opts.includeConfig !== false) {
    await fs.writeFile(configPath, "{}\n", "utf8");
  }
  if (opts.includeLauncher !== false) {
    await fs.writeFile(
      path.join(root, "start-active-stdio.ps1"),
      "# fake launcher fixture\n",
      "utf8"
    );
  }
  await fs.writeFile(path.join(root, "README.md"), "fixture backend\n", "utf8");
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", "README.md"], { stdio: "ignore" });
  if (opts.trackLauncher !== false && opts.includeLauncher !== false) {
    execFileSync("git", ["-C", root, "add", "start-active-stdio.ps1"], { stdio: "ignore" });
  }
  execFileSync("git", ["-C", root, "commit", "--no-gpg-sign", "-m", "fixture"], {
    stdio: "ignore",
  });
  const head = git(root, "rev-parse", "HEAD");
  const markerPath = path.join(dir, "winhelm.active-backend.json");
  await fs.writeFile(
    markerPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        mode: "fixture",
        backendRoot: root,
        expectedHead: opts.head === undefined ? head : opts.head,
        configPath,
      },
      null,
      2
    ),
    "utf8"
  );
  return { root, configPath, markerPath, head };
}

async function writeLifecycleConfig(patch: Record<string, unknown>): Promise<void> {
  const base = {
    schemaVersion: 1,
    ...patch,
  };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "lifecycle-config.json"),
    JSON.stringify(base, null, 2),
    "utf8"
  );
}

function fakeExeConfig(markerPath: string, profilePath: string, extra: Record<string, unknown> = {}) {
  return {
    executablePath: process.execPath,
    executableArgs: [FAKE_CLIENT],
    profilePath,
    markerPath,
    ...extra,
  };
}

describe("M3A P2: ChatGPT tunnel lifecycle service", () => {
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-m3a-p2-svc-"));
    stateDir = path.join(scratch, "state");
    savedEnv = {
      WINHELM_TUNNEL_STATE_DIR: process.env.WINHELM_TUNNEL_STATE_DIR,
      WINHELM_ACTIVE_BACKEND_MARKER: process.env.WINHELM_ACTIVE_BACKEND_MARKER,
    };
    process.env.WINHELM_TUNNEL_STATE_DIR = stateDir;
    delete process.env.WINHELM_ACTIVE_BACKEND_MARKER;
  });

  afterEach(async () => {
    if (savedEnv.WINHELM_TUNNEL_STATE_DIR === undefined) {
      delete process.env.WINHELM_TUNNEL_STATE_DIR;
    } else {
      process.env.WINHELM_TUNNEL_STATE_DIR = savedEnv.WINHELM_TUNNEL_STATE_DIR;
    }
    if (savedEnv.WINHELM_ACTIVE_BACKEND_MARKER === undefined) {
      delete process.env.WINHELM_ACTIVE_BACKEND_MARKER;
    } else {
      process.env.WINHELM_ACTIVE_BACKEND_MARKER = savedEnv.WINHELM_ACTIVE_BACKEND_MARKER;
    }
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("redacts secret-shaped values before any status leaves the service", () => {
    const input = {
      ok: true,
      authToken: "sk-live-secret-123",
      apiKey: "ak-999",
      clientSecret: "s3cret",
      password: "hunter2",
      authorization: "Bearer xyz",
      nested: { cloudflareToken: "cf-tok", safe: "keep-me" },
      list: [{ password: "p", name: "n" }],
    };
    const out = redactTunnelSecrets(input) as typeof input;
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes("sk-live-secret-123"));
    assert.ok(!serialized.includes("ak-999"));
    assert.ok(!serialized.includes("s3cret"));
    assert.ok(!serialized.includes("hunter2"));
    assert.ok(!serialized.includes("Bearer xyz"));
    assert.ok(!serialized.includes("cf-tok"));
    assert.ok(!serialized.includes("p,"));
    assert.strictEqual(out.nested.safe, "keep-me");
    assert.strictEqual(out.ok, true);
    assert.strictEqual((out.list[0] as any).name, "n");
  });

  it("loads a missing lifecycle config as not-present with defaults", async () => {
    const loaded = loadTunnelLifecycleConfig();
    assert.strictEqual(loaded.present, false);
    assert.strictEqual(loaded.corrupt, false);
    assert.strictEqual(loaded.config.schemaVersion, 1);
  });

  it("persists lifecycle config atomically and degrades corrupt config to read-only defaults", async () => {
    const cfg = await saveTunnelLifecycleConfig({
      executablePath: "C:\\x\\tunnel-client.exe",
      profilePath: "C:\\x\\profile.yaml",
    });
    assert.strictEqual(cfg.executablePath, "C:\\x\\tunnel-client.exe");
    const loaded = loadTunnelLifecycleConfig();
    assert.strictEqual(loaded.present, true);
    assert.strictEqual(loaded.config.profilePath, "C:\\x\\profile.yaml");

    await fs.writeFile(
      path.join(stateDir, "lifecycle-config.json"),
      "{not json",
      "utf8"
    );
    const corrupt = loadTunnelLifecycleConfig();
    assert.strictEqual(corrupt.present, true);
    assert.strictEqual(corrupt.corrupt, true);
    // Corrupt config must degrade to defaults (never trust partial values).
    assert.strictEqual(corrupt.config.executablePath, undefined);
  });

  it("qualifies only the exact reference tunnel-client version", async () => {
    const dep = await qualifyTunnelDependency({
      schemaVersion: 1,
      executablePath: process.execPath,
      executableArgs: [FAKE_CLIENT],
    });
    assert.strictEqual(dep.state, "qualified");
    assert.strictEqual(
      (dep as { version: string }).version,
      QUALIFIED_TUNNEL_CLIENT_VERSION
    );
  });

  it("reports unqualified versions without executing a managed start", async () => {
    const dep = await qualifyTunnelDependency({
      schemaVersion: 1,
      executablePath: process.execPath,
      executableArgs: [FAKE_CLIENT],
    });
    assert.strictEqual(dep.state, "qualified");

    // Unqualified version must be observable and rejected.
    await fs.writeFile(
      path.join(scratch, "profile.yaml"),
      "fake: profile\n",
      "utf8"
    );
    await writeLifecycleConfig({
      executablePath: process.execPath,
      executableArgs: [FAKE_CLIENT],
      profilePath: path.join(scratch, "profile.yaml"),
    });
    const savedVersion = process.env.FAKE_TUNNEL_VERSION;
    process.env.FAKE_TUNNEL_VERSION =
      "0.0.14+deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    let status;
    try {
      status = await getTunnelStatus();
    } finally {
      if (savedVersion === undefined) delete process.env.FAKE_TUNNEL_VERSION;
      else process.env.FAKE_TUNNEL_VERSION = savedVersion;
    }
    assert.strictEqual(status.dependency.state, "unqualified");
    assert.match(status.dependency.detail, /0\.0\.14/);
  });

  it("reports missing executable as dependency missing", async () => {
    const dep = await qualifyTunnelDependency({
      schemaVersion: 1,
      executablePath: path.join(scratch, "nope.exe"),
    });
    assert.strictEqual(dep.state, "missing");
  });

  it("rejects managed start when the active-backend marker HEAD is stale", async () => {
    const backend = await makeFakeBackend(scratch);
    const staleHead = "0".repeat(40);
    await fs.writeFile(
      backend.markerPath,
      JSON.stringify({
        schemaVersion: 1,
        mode: "fixture",
        backendRoot: backend.root,
        expectedHead: staleHead,
        configPath: backend.configPath,
      }),
      "utf8"
    );
    const profile = path.join(scratch, "profile.yaml");
    await fs.writeFile(profile, "fake: profile\n", "utf8");
    await writeLifecycleConfig(fakeExeConfig(backend.markerPath, profile));

    await assert.rejects(
      startManagedTunnel(),
      (err: unknown) =>
        err instanceof TunnelLifecycleError && err.code === "BACKEND_NOT_READY"
    );
    const readiness = await evaluateBackendReadiness();
    assert.strictEqual(readiness.ready, false);
    assert.strictEqual(readiness.reason, "HEAD_MISMATCH");
    // No managed state may be persisted for a rejected start.
    const state = loadManagedTunnelState();
    assert.strictEqual(state.state, null);
  });

  it("rejects managed start when the marker is missing or malformed", async () => {
    const backend = await makeFakeBackend(scratch);
    await fs.rm(backend.markerPath);
    await writeLifecycleConfig(
      fakeExeConfig(backend.markerPath, path.join(scratch, "profile.yaml"))
    );
    const missing = await evaluateBackendReadiness();
    assert.strictEqual(missing.ready, false);
    assert.strictEqual(missing.reason, "MARKER_MISSING");

    await fs.writeFile(backend.markerPath, "{oops", "utf8");
    const malformed = await evaluateBackendReadiness();
    assert.strictEqual(malformed.ready, false);
    assert.strictEqual(malformed.reason, "MARKER_MALFORMED");
  });

  it("rejects markers with unsupported schemaVersion or missing fields", async () => {
    const backend = await makeFakeBackend(scratch, { includeConfig: false });
    await writeLifecycleConfig(
      fakeExeConfig(backend.markerPath, path.join(scratch, "profile.yaml"))
    );
    const noConfig = await evaluateBackendReadiness();
    assert.strictEqual(noConfig.ready, false);
    assert.strictEqual(noConfig.reason, "BACKEND_CONFIG_MISSING");

    await fs.writeFile(
      backend.markerPath,
      JSON.stringify({
        schemaVersion: 2,
        backendRoot: backend.root,
        expectedHead: backend.head,
        configPath: backend.configPath,
      }),
      "utf8"
    );
    const badSchema = await evaluateBackendReadiness();
    assert.strictEqual(badSchema.ready, false);
    assert.strictEqual(badSchema.reason, "MARKER_SCHEMA_UNSUPPORTED");
  });

  it("rejects backends with missing dist, missing launcher, or untracked launcher", async () => {
    const noDist = await makeFakeBackend(path.join(scratch, "a"), {
      includeDist: false,
    });
    await writeLifecycleConfig(fakeExeConfig(noDist.markerPath, path.join(scratch, "p.yaml")));
    assert.strictEqual(
      (await evaluateBackendReadiness()).reason,
      "BACKEND_DIST_MISSING"
    );

    const noLauncher = await makeFakeBackend(path.join(scratch, "b"), {
      includeLauncher: false,
    });
    await writeLifecycleConfig(fakeExeConfig(noLauncher.markerPath, path.join(scratch, "p.yaml")));
    assert.strictEqual(
      (await evaluateBackendReadiness()).reason,
      "LAUNCHER_MISSING"
    );

    const untracked = await makeFakeBackend(path.join(scratch, "c"), {
      trackLauncher: false,
    });
    await writeLifecycleConfig(fakeExeConfig(untracked.markerPath, path.join(scratch, "p.yaml")));
    assert.strictEqual(
      (await evaluateBackendReadiness()).reason,
      "LAUNCHER_UNTRACKED"
    );
  });

  it("starts a managed tunnel with the fake fixture and reports managed_ready", async () => {
    const backend = await makeFakeBackend(scratch);
    const profile = path.join(scratch, "profile.yaml");
    await fs.writeFile(profile, "fake: profile\n", "utf8");
    await writeLifecycleConfig(fakeExeConfig(backend.markerPath, profile));

    const status = await startManagedTunnel();
    assert.strictEqual(status.daemon.ownership, "managed");
    assert.strictEqual(status.daemon.state, "managed_ready");
    assert.strictEqual(typeof status.daemon.pid, "number");
    assert.ok((status.daemon.pid as number) > 0);
    assert.ok(status.daemon.healthUrl?.startsWith("http://127.0.0.1:"));
    assert.strictEqual(status.daemon.stopRestartAvailable, true);

    const state = loadManagedTunnelState();
    assert.ok(state.state);
    assert.strictEqual(state.state.status, "ready");
    assert.ok(state.state.stateId);
    assert.ok(state.state.processCreatedAt);

    const stopped = await stopManagedTunnel();
    assert.strictEqual(stopped.daemon.ownership, "none");
    assert.strictEqual(stopped.daemon.state, "stopped");
  });

  it("rejects duplicate managed start while a managed daemon is live", async () => {
    const backend = await makeFakeBackend(scratch);
    const profile = path.join(scratch, "profile.yaml");
    await fs.writeFile(profile, "fake: profile\n", "utf8");
    await writeLifecycleConfig(fakeExeConfig(backend.markerPath, profile));

    await startManagedTunnel();
    try {
      await assert.rejects(
        startManagedTunnel(),
        (err: unknown) =>
          err instanceof TunnelLifecycleError &&
          err.code === "MANAGED_ALREADY_RUNNING"
      );
    } finally {
      await stopManagedTunnel();
    }
  });

  it("cleans up only the started child when readiness fails", async () => {
    const backend = await makeFakeBackend(scratch);
    const profile = path.join(scratch, "profile.yaml");
    await fs.writeFile(profile, "fake: profile\n", "utf8");
    await writeLifecycleConfig(fakeExeConfig(backend.markerPath, profile));

    const saved = process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS;
    process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS = "300";
    try {
      await assert.rejects(
        startManagedTunnel(),
        (err: unknown) =>
          err instanceof TunnelLifecycleError &&
          err.code === "TUNNEL_START_FAILED"
      );
    } finally {
      if (saved === undefined) delete process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS;
      else process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS = saved;
    }

    const state = loadManagedTunnelState();
    assert.strictEqual(state.state, null, "failed start must clear managed state");
    const urlFile = path.join(stateDir, "current-health-url.txt");
    assert.strictEqual(fsSync.existsSync(urlFile), false, "health url file must be cleaned");
  });

  it("refuses to stop an external/unmanaged daemon observed via health evidence", async () => {
    // A test-owned HTTP server plays the role of an externally started
    // tunnel-client: WinHelm has no managed state for it.
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if ((req.url || "").split("?")[0] === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("live");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const healthUrl = `http://127.0.0.1:${port}`;

    try {
      await writeLifecycleConfig({
        healthUrl,
        executablePath: process.execPath,
        executableArgs: [FAKE_CLIENT],
      });
      const status = await getTunnelStatus();
      assert.strictEqual(status.daemon.ownership, "external");
      assert.strictEqual(status.daemon.state, "external_running");
      assert.strictEqual(status.daemon.stopRestartAvailable, false);

      await assert.rejects(
        stopManagedTunnel(),
        (err: unknown) =>
          err instanceof TunnelLifecycleError && err.code === "TUNNEL_NOT_MANAGED"
      );
      // The external server must still be alive and serving.
      const probe = await fetch(`${healthUrl}/healthz`);
      assert.strictEqual(probe.status, 200);
    } finally {
      (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("cannot kill an unrelated process from stale managed state (PID reuse defense)", async () => {
    // Spawn a long-lived, unrelated helper process owned by the test.
    const helper = await import("node:child_process");
    const unrelated = helper.spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000);"],
      { stdio: "ignore" }
    );
    await new Promise((r) => setTimeout(r, 300));

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "managed-state.json"),
        JSON.stringify({
          schemaVersion: 1,
          stateId: "stale-state-id",
          pid: unrelated.pid,
          processCreatedAt: new Date(Date.now() - 86_400_000).toISOString(),
          executablePath: "Z:\\definitely\\not\\this\\tunnel-client.exe",
          profilePath: "Z:\\definitely\\not\\profile.yaml",
          startedAt: new Date(Date.now() - 86_400_000).toISOString(),
          healthUrl: "http://127.0.0.1:1",
          status: "ready",
        }),
        "utf8"
      );

      await assert.rejects(
        stopManagedTunnel(),
        (err: unknown) =>
          err instanceof TunnelLifecycleError &&
          err.code === "MANAGED_IDENTITY_UNPROVEN"
      );

      // The unrelated process must still be alive.
      let alive = true;
      try {
        process.kill(unrelated.pid!, 0);
      } catch {
        alive = false;
      }
      assert.strictEqual(alive, true, "stale state must never enable a kill");
      unrelated.kill();
    } catch (err) {
      unrelated.kill();
      throw err;
    }
  });

  it("degrades corrupt managed state to read-only observation without killing", async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "managed-state.json"),
      "{corrupt",
      "utf8"
    );
    const status = await getTunnelStatus();
    assert.strictEqual(status.managedStateCorrupt, true);
    assert.strictEqual(status.daemon.ownership, "none");
    assert.strictEqual(status.daemon.stopRestartAvailable, false);
    await assert.rejects(
      stopManagedTunnel(),
      (err: unknown) =>
        err instanceof TunnelLifecycleError &&
        err.code === "MANAGED_IDENTITY_UNPROVEN"
    );
  });

  it("never returns secret values through status even if state files are contaminated", async () => {
    const backend = await makeFakeBackend(scratch);
    const profile = path.join(scratch, "profile.yaml");
    await fs.writeFile(profile, "fake: profile\n", "utf8");
    await writeLifecycleConfig(
      fakeExeConfig(backend.markerPath, profile, {
        // Contaminate the persisted config with a secret-shaped field.
        apiKey: "sk-contaminated-secret-xyz",
        authToken: "Bearer leak-me",
      })
    );
    const status = await getTunnelStatus();
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes("sk-contaminated-secret-xyz"));
    assert.ok(!serialized.includes("leak-me"));
  });

  it("restart composes stop + start through the same service", async () => {
    const backend = await makeFakeBackend(scratch);
    const profile = path.join(scratch, "profile.yaml");
    await fs.writeFile(profile, "fake: profile\n", "utf8");
    await writeLifecycleConfig(fakeExeConfig(backend.markerPath, profile));

    await startManagedTunnel();
    const first = loadManagedTunnelState();
    const status = await restartManagedTunnel();
    assert.strictEqual(status.daemon.state, "managed_ready");
    const second = loadManagedTunnelState();
    assert.ok(second.state);
    assert.notStrictEqual(
      first.state?.stateId,
      second.state?.stateId,
      "restart must mint a new managed identity"
    );
    await stopManagedTunnel();
  });
});
