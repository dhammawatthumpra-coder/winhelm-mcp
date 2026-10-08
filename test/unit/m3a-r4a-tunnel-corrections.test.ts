import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  QUALIFIED_TUNNEL_CLIENT_VERSION,
  qualifyTunnelDependency,
  probeManagedControlPlaneReadiness,
  stopManagedProcessSafely,
  type ManagedHealthCommandResult,
  type StartAttemptIdentity,
} from "../../src/integrations/chatgpt-tunnel.js";

const identity: StartAttemptIdentity = {
  pid: 43210,
  executablePath: "C:\\tools\\tunnel-client.exe",
  processCreatedAt: "2026-10-08T01:02:03.000Z",
};

function healthResult(overrides: Record<string, unknown> = {}): ManagedHealthCommandResult {
  const payload = {
    process: { pid: identity.pid, running: true },
    healthz: { ok: true },
    readyz: { ok: true },
    control_plane_poll: { ok: true },
    result: "ok",
    ...overrides,
  };
  return { code: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false };
}

describe("M3A R4A tunnel corrections", () => {
  it("pins the exact accepted v0.0.16 runtime identity", () => {
    assert.equal(
      QUALIFIED_TUNNEL_CLIENT_VERSION,
      "0.0.16+5f99daabd4aa4a77049e6d81d54a0d8c18335397"
    );
  });

  it("rejects v0.0.15 and altered v0.0.16 build identities", async () => {
    const fixture = path.resolve(import.meta.dirname, "../fixtures/m3a-p2/fake-tunnel-client.mjs");
    const previous = process.env.FAKE_TUNNEL_VERSION;
    try {
      for (const version of [
        "0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0",
        "0.0.16+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ]) {
        process.env.FAKE_TUNNEL_VERSION = version;
        const dependency = await qualifyTunnelDependency({
          schemaVersion: 1,
          executablePath: process.execPath,
          executableArgs: [fixture],
        });
        assert.equal(dependency.state, "unqualified", version);
      }
    } finally {
      if (previous === undefined) delete process.env.FAKE_TUNNEL_VERSION;
      else process.env.FAKE_TUNNEL_VERSION = previous;
    }
  });

  it("runs the exact structured health argv against the configured executable", async () => {
    let observed:
      | { command: string; args: string[]; options: { timeoutMs: number; cwd?: string } }
      | undefined;
    const ready = await probeManagedControlPlaneReadiness(
      "C:\\tools\\tunnel-client.exe",
      ["--profile-dir", "C:\\profile"],
      "http://127.0.0.1:18026",
      identity.pid,
      {
        run: async (command, args, options) => {
          observed = { command, args, options };
          return healthResult();
        },
      }
    );
    assert.equal(ready, true);
    assert.deepEqual(observed, {
      command: "C:\\tools\\tunnel-client.exe",
      args: [
        "--profile-dir",
        "C:\\profile",
        "health",
        "--json",
        "--url",
        "http://127.0.0.1:18026",
        "--pid",
        String(identity.pid),
        "--require-control-plane-poll",
      ],
      options: { timeoutMs: 5_000, cwd: "C:\\tools" },
    });
  });

  it("fails closed on command, timeout, JSON, PID, and readiness failures", async () => {
    const valid = healthResult();
    const cases: Array<[string, ManagedHealthCommandResult]> = [
      ["nonzero exit", { ...valid, code: 1 }],
      ["timeout", { ...valid, code: null, timedOut: true }],
      ["malformed JSON", { ...valid, stdout: "{bad" }],
      ["process not running", healthResult({ process: { pid: identity.pid, running: false } })],
      ["wrong process", healthResult({ process: { pid: identity.pid + 1, running: true } })],
      ["healthz false", healthResult({ healthz: { ok: false } })],
      ["readyz false", healthResult({ readyz: { ok: false } })],
      ["control-plane false", healthResult({ control_plane_poll: { ok: false }, result: "not_ready" })],
      ["result not ok", healthResult({ result: "degraded" })],
      ["missing control-plane field", healthResult({ control_plane_poll: undefined })],
    ];
    for (const [label, result] of cases) {
      assert.equal(
        await probeManagedControlPlaneReadiness("C:\\tools\\tunnel-client.exe", [], "http://127.0.0.1:18026", identity.pid, {
          run: async () => result,
        }),
        false,
        label
      );
    }
    assert.equal(
      await probeManagedControlPlaneReadiness("C:\\tools\\tunnel-client.exe", [], "http://127.0.0.1:18026", identity.pid, {
        run: async () => {
          throw new Error("not executable");
        },
      }),
      false,
      "execution failure"
    );
  });

  it("allows force stop only after the exact identity is re-proven", async () => {
    const kills: boolean[] = [];
    let identityQueries = 0;
    let waits = 0;
    await stopManagedProcessSafely(identity, {
      isAlive: () => true,
      queryIdentity: async () => {
        identityQueries += 1;
        return {
          exists: true,
          executablePath: identity.executablePath,
          createdAtIso: identity.processCreatedAt,
        };
      },
      taskkill: async (_pid, force) => void kills.push(force),
      waitForExit: async () => ++waits === 1 ? false : true,
    });
    assert.deepEqual(kills, [false, true]);
    assert.equal(identityQueries, 2);
  });

  it("does not force stop after path, creation-time, missing, or exited identity", async () => {
    const changedIdentities = [
      { exists: true, executablePath: "C:\\other\\tunnel-client.exe", createdAtIso: identity.processCreatedAt },
      { exists: true, executablePath: identity.executablePath, createdAtIso: "2026-10-08T01:02:09.000Z" },
      { exists: false },
    ];
    for (const changed of changedIdentities) {
      const kills: boolean[] = [];
      let identityQueries = 0;
      await assert.rejects(
        stopManagedProcessSafely(identity, {
          isAlive: () => true,
          queryIdentity: async () => {
            identityQueries += 1;
            return identityQueries === 1
              ? { exists: true, executablePath: identity.executablePath, createdAtIso: identity.processCreatedAt }
              : changed;
          },
          taskkill: async (_pid, force) => void kills.push(force),
          waitForExit: async () => false,
        }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: string }).code === "MANAGED_IDENTITY_UNPROVEN" &&
          "details" in error &&
          (error as { details: { stage?: string } }).details.stage === "force_escalation"
      );
      assert.deepEqual(kills, [false]);
    }

    const kills: boolean[] = [];
    let aliveChecks = 0;
    await stopManagedProcessSafely(identity, {
      isAlive: () => ++aliveChecks < 2,
      queryIdentity: async () => ({
        exists: true,
        executablePath: identity.executablePath,
        createdAtIso: identity.processCreatedAt,
      }),
      taskkill: async (_pid, force) => void kills.push(force),
      waitForExit: async () => false,
    });
    assert.deepEqual(kills, [false], "process exit during graceful wait must skip force");
  });

  it("does not gracefully or forcibly stop when the initial identity is unproven", async () => {
    const kills: boolean[] = [];
    await assert.rejects(
      stopManagedProcessSafely(identity, {
        isAlive: () => true,
        queryIdentity: async () => ({ exists: false }),
        taskkill: async (_pid, force) => void kills.push(force),
        waitForExit: async () => false,
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "details" in error &&
        (error as { details: { stage?: string } }).details.stage === "initial"
    );
    assert.deepEqual(kills, []);
  });

  it("does not force stop after a graceful exit", async () => {
    const kills: boolean[] = [];
    await stopManagedProcessSafely(identity, {
      isAlive: () => true,
      queryIdentity: async () => ({
        exists: true,
        executablePath: identity.executablePath,
        createdAtIso: identity.processCreatedAt,
      }),
      taskkill: async (_pid, force) => void kills.push(force),
      waitForExit: async () => true,
    });
    assert.deepEqual(kills, [false]);
  });
});
