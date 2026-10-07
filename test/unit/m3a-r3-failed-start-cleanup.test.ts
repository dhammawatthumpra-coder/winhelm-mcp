import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import * as tunnel from "../../src/integrations/chatgpt-tunnel.js";
import {
  TunnelLifecycleError,
  startManagedTunnel,
  loadManagedTunnelState,
} from "../../src/integrations/chatgpt-tunnel.js";

/**
 * M3A R3: Failed-start identity-safe cleanup recovery tests.
 *
 * Requirements:
 * - Bind cleanup to full start-attempt identity/state, not PID alone.
 * - Re-observe and conjunctively prove PID + executable path + creation time before the first cleanup taskkill.
 * - Absent process => already exited, zero taskkill.
 * - Missing/malformed/mismatched path or creation time => zero taskkill.
 * - Re-prove identity again before any force-kill escalation.
 * - If identity disappears/changes after graceful attempt => NO force kill.
 * - Only still-proven exact start-attempt identity may be force-killed.
 * - Process-name kill remains prohibited.
 * - State/url cleanup may proceed without granting kill authority.
 */

describe("M3A R3: failed-start identity-safe cleanup recovery", () => {
  const PROVEN_EXE = "C:\\tools\\tunnel-client.exe";
  const PROVEN_CREATED = "2026-10-07T08:00:00.000Z";
  const TARGET_PID = 5432;

  const validAttemptIdentity = {
    pid: TARGET_PID,
    executablePath: PROVEN_EXE,
    processCreatedAt: PROVEN_CREATED,
  };

  describe("cleanupManagedStartAttempt pure & dependency-injected verification", () => {
    it("A. already exited (not alive / not found) => zero taskkill", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;
      assert.ok(typeof cleanupFn === "function", "cleanupManagedStartAttempt must be exported");

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => false,
        queryIdentity: async () => ({ exists: false }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
      });

      assert.strictEqual(taskkillCalls.length, 0, "must issue zero taskkill when process already exited");
      assert.strictEqual(result.gracefulKilled, false);
      assert.strictEqual(result.forceKilled, false);
    });

    it("B. observed process exists but executablePath missing => zero taskkill", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => true,
        queryIdentity: async () => ({
          exists: true,
          executablePath: undefined,
          createdAtIso: PROVEN_CREATED,
        }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
      });

      assert.strictEqual(taskkillCalls.length, 0, "must issue zero taskkill on missing path");
      assert.strictEqual(result.gracefulKilled, false);
      assert.strictEqual(result.forceKilled, false);
    });

    it("C. observed process exists but executablePath mismatched => zero taskkill", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => true,
        queryIdentity: async () => ({
          exists: true,
          executablePath: "C:\\Windows\\System32\\svchost.exe",
          createdAtIso: PROVEN_CREATED,
        }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
      });

      assert.strictEqual(taskkillCalls.length, 0, "must issue zero taskkill on mismatched path");
      assert.strictEqual(result.gracefulKilled, false);
      assert.strictEqual(result.forceKilled, false);
    });

    it("D. observed process exists but creation time missing => zero taskkill", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => true,
        queryIdentity: async () => ({
          exists: true,
          executablePath: PROVEN_EXE,
          createdAtIso: undefined,
        }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
      });

      assert.strictEqual(taskkillCalls.length, 0, "must issue zero taskkill on missing creation time");
      assert.strictEqual(result.gracefulKilled, false);
      assert.strictEqual(result.forceKilled, false);
    });

    it("E. observed creation time malformed => zero taskkill", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => true,
        queryIdentity: async () => ({
          exists: true,
          executablePath: PROVEN_EXE,
          createdAtIso: "invalid-timestamp",
        }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
      });

      assert.strictEqual(taskkillCalls.length, 0, "must issue zero taskkill on malformed creation time");
      assert.strictEqual(result.gracefulKilled, false);
      assert.strictEqual(result.forceKilled, false);
    });

    it("F. simulated PID reuse / creation-time mismatch => zero taskkill", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => true,
        queryIdentity: async () => ({
          exists: true,
          executablePath: PROVEN_EXE,
          createdAtIso: "2026-10-07T08:05:00.000Z", // 5 minutes later => reused PID
        }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
      });

      assert.strictEqual(taskkillCalls.length, 0, "must issue zero taskkill when PID reused with different timestamp");
      assert.strictEqual(result.gracefulKilled, false);
      assert.strictEqual(result.forceKilled, false);
    });

    it("G. complete matching identity => graceful cleanup allowed", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => true,
        queryIdentity: async () => ({
          exists: true,
          executablePath: PROVEN_EXE,
          createdAtIso: PROVEN_CREATED,
        }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
        waitForExit: async () => true, // exits during graceful window
      });

      assert.strictEqual(taskkillCalls.length, 1);
      assert.deepStrictEqual(taskkillCalls[0], {
        pid: TARGET_PID,
        force: false,
        tree: true,
      });
      assert.strictEqual(result.gracefulKilled, true);
      assert.strictEqual(result.forceKilled, false);
    });

    it("H. exits after graceful => no force kill", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => true,
        queryIdentity: async () => ({
          exists: true,
          executablePath: PROVEN_EXE,
          createdAtIso: PROVEN_CREATED,
        }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
        waitForExit: async () => true, // exited gracefully
      });

      assert.strictEqual(taskkillCalls.length, 1);
      assert.strictEqual(taskkillCalls[0].force, false);
      assert.strictEqual(result.gracefulKilled, true);
      assert.strictEqual(result.forceKilled, false);
    });

    it("I. identity changes / disappears before force => no force kill", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      let callCount = 0;
      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: (pid: number) => {
          // alive initially, but not during re-observation
          return callCount === 0;
        },
        queryIdentity: async () => {
          callCount++;
          if (callCount === 1) {
            // First check: matching identity
            return {
              exists: true,
              executablePath: PROVEN_EXE,
              createdAtIso: PROVEN_CREATED,
            };
          }
          // Second check before force kill: PID reused or exited
          return {
            exists: true,
            executablePath: "C:\\Windows\\System32\\notepad.exe",
            createdAtIso: "2026-10-07T08:06:00.000Z",
          };
        },
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
        waitForExit: async () => false, // graceful timeout expired
      });

      // Must have executed graceful kill, but MUST NOT execute force kill because identity changed!
      assert.strictEqual(taskkillCalls.length, 1);
      assert.strictEqual(taskkillCalls[0].force, false);
      assert.strictEqual(result.gracefulKilled, true);
      assert.strictEqual(result.forceKilled, false);
    });

    it("J. still-proven identity after graceful timeout => bounded force kill allowed", async () => {
      const taskkillCalls: Array<{ pid: number; force: boolean; tree: boolean }> = [];
      const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;

      const result = await cleanupFn(validAttemptIdentity, {
        isAlive: () => true,
        queryIdentity: async () => ({
          exists: true,
          executablePath: PROVEN_EXE,
          createdAtIso: PROVEN_CREATED,
        }),
        taskkill: async (pid: number, force: boolean, tree: boolean) => {
          taskkillCalls.push({ pid, force, tree });
        },
        waitForExit: async (_pid: number, timeoutMs: number) => {
          // graceful timeout fails, force timeout succeeds
          return timeoutMs <= 1000 ? false : true;
        },
        gracefulTimeoutMs: 500,
        forceTimeoutMs: 2000,
      });

      assert.strictEqual(taskkillCalls.length, 2);
      assert.deepStrictEqual(taskkillCalls[0], {
        pid: TARGET_PID,
        force: false,
        tree: true,
      });
      assert.deepStrictEqual(taskkillCalls[1], {
        pid: TARGET_PID,
        force: true,
        tree: true,
      });
      assert.strictEqual(result.gracefulKilled, true);
      assert.strictEqual(result.forceKilled, true);
    });
  });

  describe("live helper process & sidecar contract", () => {
    let scratchDir: string;
    let stateDir: string;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(async () => {
      scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-m3a-r3-"));
      stateDir = path.join(scratchDir, "state");
      savedEnv = {
        WINHELM_TUNNEL_STATE_DIR: process.env.WINHELM_TUNNEL_STATE_DIR,
      };
      process.env.WINHELM_TUNNEL_STATE_DIR = stateDir;
    });

    afterEach(async () => {
      if (savedEnv.WINHELM_TUNNEL_STATE_DIR === undefined) {
        delete process.env.WINHELM_TUNNEL_STATE_DIR;
      } else {
        process.env.WINHELM_TUNNEL_STATE_DIR = savedEnv.WINHELM_TUNNEL_STATE_DIR;
      }
      await fs.rm(scratchDir, { recursive: true, force: true });
    });

    it("K. unrelated helper survives every unproven cleanup case", async () => {
      // Spawn real unrelated node helper process
      const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      assert.ok(helper.pid, "helper must have PID");

      try {
        const cleanupFn = (tunnel as any).cleanupManagedStartAttempt;
        assert.ok(typeof cleanupFn === "function");

        // Attempt 1: Wrong executable path for real helper PID
        await cleanupFn({
          pid: helper.pid!,
          executablePath: "C:\\definitely\\nonexistent\\tunnel-client.exe",
          processCreatedAt: new Date().toISOString(),
        });

        // Verify helper is still alive
        let alive = true;
        try {
          process.kill(helper.pid!, 0);
        } catch {
          alive = false;
        }
        assert.strictEqual(alive, true, "helper must survive mismatched executablePath");

        // Attempt 2: Mismatched creation timestamp (simulated PID reuse)
        await cleanupFn({
          pid: helper.pid!,
          executablePath: process.execPath,
          processCreatedAt: "1999-01-01T00:00:00.000Z",
        });

        alive = true;
        try {
          process.kill(helper.pid!, 0);
        } catch {
          alive = false;
        }
        assert.strictEqual(alive, true, "helper must survive mismatched creation timestamp");

        // Attempt 3: Missing creation timestamp
        await cleanupFn({
          pid: helper.pid!,
          executablePath: process.execPath,
          processCreatedAt: "",
        });

        alive = true;
        try {
          process.kill(helper.pid!, 0);
        } catch {
          alive = false;
        }
        assert.strictEqual(alive, true, "helper must survive missing creation timestamp");
      } finally {
        helper.kill();
      }
    });

    it("L. state and url sidecars satisfy failed-start cleanup contract", async () => {
      const FAKE_CLIENT = path.resolve(
        import.meta.dirname,
        "../fixtures/m3a-p2/fake-tunnel-client.mjs"
      );
      await fs.mkdir(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, "managed-state.json");
      const urlFile = path.join(stateDir, "current-health-url.txt");

      // Set up minimal fake backend
      const backendRoot = path.join(scratchDir, "backend");
      await fs.mkdir(path.join(backendRoot, "dist"), { recursive: true });
      await fs.writeFile(path.join(backendRoot, "dist", "index.js"), "process.exit(0);\n", "utf8");
      const configPath = path.join(backendRoot, "winhelm.config.json");
      await fs.writeFile(configPath, "{}\n", "utf8");
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["-C", backendRoot, "init"], { stdio: "ignore" });
      execFileSync("git", ["-C", backendRoot, "config", "user.email", "test@test.local"], { stdio: "ignore" });
      execFileSync("git", ["-C", backendRoot, "config", "user.name", "Tester"], { stdio: "ignore" });
      await fs.writeFile(path.join(backendRoot, "start-active-stdio.ps1"), "# launcher\n", "utf8");
      execFileSync("git", ["-C", backendRoot, "add", "."], { stdio: "ignore" });
      execFileSync("git", ["-C", backendRoot, "commit", "--no-gpg-sign", "-m", "init"], { stdio: "ignore" });
      const head = execFileSync("git", ["-C", backendRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

      const markerPath = path.join(scratchDir, "winhelm.active-backend.json");
      await fs.writeFile(
        markerPath,
        JSON.stringify({
          schemaVersion: 1,
          mode: "fixture",
          backendRoot,
          expectedHead: head,
          configPath,
        }),
        "utf8"
      );

      const profile = path.join(scratchDir, "profile.yaml");
      await fs.writeFile(profile, "fake: profile\n", "utf8");

      const lifecycleConfig = {
        schemaVersion: 1,
        executablePath: process.execPath,
        executableArgs: [FAKE_CLIENT],
        profilePath: profile,
        markerPath,
      };
      await fs.writeFile(
        path.join(stateDir, "lifecycle-config.json"),
        JSON.stringify(lifecycleConfig, null, 2),
        "utf8"
      );

      const savedCrash = process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS;
      process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS = "300";
      try {
        await assert.rejects(
          startManagedTunnel(),
          (err: unknown) =>
            err instanceof TunnelLifecycleError && err.code === "TUNNEL_START_FAILED"
        );
      } finally {
        if (savedCrash === undefined) delete process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS;
        else process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS = savedCrash;
      }

      // Verify sidecars are cleaned up
      assert.strictEqual(fsSync.existsSync(stateFile), false, "managed-state.json must be cleaned up on failed start");
      assert.strictEqual(fsSync.existsSync(urlFile), false, "current-health-url.txt must be cleaned up on failed start");
    });
  });
});
