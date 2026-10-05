import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import {
  NATIVE_CAPTURE_CEILING_BYTES,
  preflightGovernedCommandRun,
  runCommandGoverned,
} from "../../src/engine/command-runner.js";
import { validatePublicTimeoutMs } from "../../src/engine/command-env.js";
import {
  getRunManager,
  initializeRunManager,
  resetRunManager,
  setRunJournalPathForTesting,
} from "../../src/engine/run-manager.js";
import { StructuredToolError } from "../../src/errors/tool-error.js";
import { trustedNativeAddonPath } from "../../src/native/boundary.js";

let fixtureRoot: string | null = null;

async function makeFixture(terminalMode: "full" | "safe" = "full"): Promise<string> {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a4-command-"));
  setRunJournalPathForTesting(path.join(fixtureRoot, "run-journal.jsonl"));
  resetRunManager();
  const config = buildPresetConfig("balanced", {
    folders: [fixtureRoot],
    approvalMode: "smart",
  });
  config.terminal.mode = terminalMode;
  const manager = ConfigManager.resetInstance();
  await manager.updateConfig(config as any, false);
  return fixtureRoot;
}

afterEach(async () => {
  getRunManager().shutdownAll();
  resetRunManager();
  setRunJournalPathForTesting(undefined);
  ConfigManager.resetInstance();
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    fixtureRoot = null;
  }
});

const SESSION = "session-a4-owner";
const NODE = process.execPath;

function nodeScript(script: string): string[] {
  return ["-e", script];
}

function sha256Of(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativeAvailable(): boolean {
  return existsSync(trustedNativeAddonPath());
}

function processAlive(pid: number): boolean {
  try {
    const output = execFileSync(
      "tasklist.exe",
      ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
      { stdio: "pipe", encoding: "utf8" }
    );
    return output.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

describe("A4 governed command_run (sync)", () => {
  it("returns the full frozen output contract for a simple command", async () => {
    await makeFixture();
    const result = await runCommandGoverned({
      command: NODE,
      args: nodeScript('process.stdout.write("hello-governed")'),
      sessionId: SESSION,
    });

    if (result.status === "running") throw new Error("sync run must not return a handle");
    assert.strictEqual(result.status, "exited");
    assert.strictEqual(result.exit_code, 0);
    assert.strictEqual(result.stdout, "hello-governed");
    assert.strictEqual(result.stdout_bytes, "hello-governed".length);
    assert.strictEqual(result.stdout_truncated, false);
    assert.strictEqual(result.stdout_sha256, sha256Of("hello-governed"));
    assert.ok(result.peak_rss_bytes > 0);
    assert.ok(result.started_at_utc && result.ended_at_utc);
    assert.ok(result.wall_seconds >= 0);
    // Legacy schema-compatible projection.
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.aborted, false);
    assert.ok(result.run_id.startsWith("run_"));
  });

  it("builds a sanitized environment with the Trusted Sanitized PATH and no secrets", async () => {
    await makeFixture();
    process.env.MCP_AUTH_TOKEN = "secret-token-for-test";
    process.env.NODE_OPTIONS = "--inject-evil";
    try {
      const result = await runCommandGoverned({
        command: NODE,
        args: nodeScript(
          'process.stdout.write(JSON.stringify({path: process.env.PATH, token: process.env.MCP_AUTH_TOKEN ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null}))'
        ),
        env_mode: "sanitized",
        sessionId: SESSION,
      });
      if (result.status === "running") throw new Error("sync run expected");
      const reported = JSON.parse(result.stdout) as {
        path: string;
        token: string | null;
        nodeOptions: string | null;
      };
      assert.strictEqual(reported.path, path.dirname(NODE), "PATH must be the Trusted Sanitized PATH");
      assert.strictEqual(reported.token, null, "server auth token must never leak into children");
      assert.strictEqual(reported.nodeOptions, null, "execution-semantic variables must be dropped");
    } finally {
      delete process.env.MCP_AUTH_TOKEN;
      delete process.env.NODE_OPTIONS;
    }
  });

  it("passes the exact host environment when inherit is authorized", async () => {
    await makeFixture();
    process.env.WINHELM_A4_INHERIT_PROBE = "inherit-value";
    try {
      const result = await runCommandGoverned({
        command: NODE,
        args: nodeScript(
          'process.stdout.write(String(process.env.WINHELM_A4_INHERIT_PROBE))'
        ),
        env_mode: "inherit",
        sessionId: SESSION,
      });
      if (result.status === "running") throw new Error("sync run expected");
      assert.strictEqual(result.stdout, "inherit-value");
    } finally {
      delete process.env.WINHELM_A4_INHERIT_PROBE;
    }
  });

  it("starts truly empty with env_mode=empty (policy layer; runtime covered by native conformance)", async () => {
    await makeFixture();
    process.env.WINHELM_A4_EMPTY_PROBE = "should-not-be-there";
    try {
      // Policy layer: the prepared environment for empty mode carries only
      // the overlay (here: none). The runtime behavior of a truly empty
      // environment block is proven by the native NB-ENV explicit-empty
      // conformance test on the qualified Windows target; node.exe itself
      // cannot start under an empty block on Windows (CRT SystemRoot
      // requirement), so the child runtime is not probed here.
      const prepared = preflightGovernedCommandRun({
        command: NODE,
        args: [],
        env_mode: "empty",
        sessionId: SESSION,
      });
      assert.deepStrictEqual(prepared.envEntries, []);
    } finally {
      delete process.env.WINHELM_A4_EMPTY_PROBE;
    }
  });

  it("rejects forbidden overlay variables in every mode", async () => {
    await makeFixture();
    for (const envMode of ["sanitized", "inherit", "empty"] as const) {
      await assert.rejects(
        runCommandGoverned({
          command: NODE,
          args: [],
          env_mode: envMode,
          env: { NODE_OPTIONS: "--inject" },
          sessionId: SESSION,
        }),
        (err: unknown) => {
          if (!(err instanceof StructuredToolError)) return false;
          assert.strictEqual(err.code, "ILLEGAL_ENVIRONMENT_OVERRIDE");
          return true;
        }
      );
    }
  });

  it("rejects env_mode=inherit in safe terminal mode", async () => {
    await makeFixture("safe");
    await assert.rejects(
      runCommandGoverned({
        command: "npm",
        args: ["--version"],
        cwd: fixtureRoot as string,
        env_mode: "inherit",
        sessionId: SESSION,
      }),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "ILLEGAL_ENVIRONMENT_OVERRIDE");
        return true;
      }
    );
  });

  it("truncates memory capture but hashes the full stream", async () => {
    await makeFixture();
    const payload = "x".repeat(2_000);
    const result = await runCommandGoverned({
      command: NODE,
      args: nodeScript(`process.stdout.write(${JSON.stringify(payload)})`),
      max_capture_bytes: 64,
      sessionId: SESSION,
    });
    if (result.status === "running") throw new Error("sync run expected");
    assert.strictEqual(result.stdout_truncated, true);
    assert.strictEqual(result.stdout.length, 64, "memory capture is bounded");
    assert.strictEqual(result.stdout_bytes, payload.length, "byte count covers the full stream");
    assert.strictEqual(result.stdout_sha256, sha256Of(payload), "sha256 always covers the full stream");
  });

  it("pre-validates the 128 MiB capture ceiling structurally", async () => {
    await makeFixture();
    await assert.rejects(
      runCommandGoverned({
        command: NODE,
        args: [],
        max_capture_bytes: NATIVE_CAPTURE_CEILING_BYTES + 1,
        sessionId: SESSION,
      }),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "INPUT_TOO_LARGE");
        return true;
      }
    );
  });

  it("kills a sync run on timeout and reports timed_out", async () => {
    await makeFixture();
    const result = await runCommandGoverned({
      command: NODE,
      args: nodeScript("setTimeout(() => {}, 30_000)"),
      timeout_ms: 500,
      sessionId: SESSION,
    });
    if (result.status === "running") throw new Error("sync run expected");
    assert.strictEqual(result.timed_out, true);
    assert.strictEqual(result.timedOut, true);
  });

  it("writes authorized physical stdout sinks with all three modes", async () => {
    await makeFixture();
    const root = fixtureRoot as string;
    const sinkCreate = path.join(root, "out-create.log");
    const sinkAppend = path.join(root, "out-append.log");
    const sinkOverwrite = path.join(root, "out-overwrite.log");

    const first = await runCommandGoverned({
      command: NODE,
      args: nodeScript('process.stdout.write("one")'),
      stdout_file: sinkCreate,
      sessionId: SESSION,
    });
    if (first.status === "running") throw new Error("sync run expected");
    assert.strictEqual(await fs.readFile(sinkCreate, "utf8"), "one");
    assert.strictEqual(first.stdout_file, sinkCreate);

    await fs.writeFile(sinkAppend, "seed", "utf8");
    await runCommandGoverned({
      command: NODE,
      args: nodeScript('process.stdout.write("+two")'),
      stdout_file: sinkAppend,
      stdout_mode: "append",
      sessionId: SESSION,
    });
    assert.strictEqual(await fs.readFile(sinkAppend, "utf8"), "seed+two");

    await fs.writeFile(sinkOverwrite, "stale", "utf8");
    await runCommandGoverned({
      command: NODE,
      args: nodeScript('process.stdout.write("fresh")'),
      stdout_file: sinkOverwrite,
      stdout_mode: "overwrite",
      sessionId: SESSION,
    });
    assert.strictEqual(await fs.readFile(sinkOverwrite, "utf8"), "fresh");
  });

  it("rejects identical stdout/stderr sinks with STREAM_REDIRECTION_COLLISION", async () => {
    await makeFixture();
    const root = fixtureRoot as string;
    const same = path.join(root, "combined.log");
    await assert.rejects(
      runCommandGoverned({
        command: NODE,
        args: [],
        stdout_file: same,
        stderr_file: same,
        sessionId: SESSION,
      }),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "STREAM_REDIRECTION_COLLISION");
        return true;
      }
    );
    assert.strictEqual(existsSync(same), false, "collision rejection must precede sink creation");
  });

  it("rejects create_new sink collision on an existing file", async () => {
    await makeFixture();
    const root = fixtureRoot as string;
    const sink = path.join(root, "exists.log");
    await fs.writeFile(sink, "occupied", "utf8");
    await assert.rejects(
      runCommandGoverned({
        command: NODE,
        args: nodeScript('process.stdout.write("x")'),
        stdout_file: sink,
        sessionId: SESSION,
      }),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "SINK_ALREADY_EXISTS");
        return true;
      }
    );
    assert.strictEqual(await fs.readFile(sink, "utf8"), "occupied");
  });
});

describe("A4 async runs and command_wait", () => {
  it("launches asynchronously, keeps running across disconnect, and waits later", async () => {
    await makeFixture();
    const handle = await runCommandGoverned({
      command: NODE,
      args: nodeScript("setTimeout(() => process.stdout.write('late'), 400)"),
      async: true,
      sessionId: SESSION,
    });
    assert.strictEqual(handle.status, "running");
    assert.ok(handle.run_id.startsWith("run_"));

    const manager = getRunManager();
    const live = manager.getLive(handle.run_id);
    assert.ok(live, "async run must be live in the run manager");

    // Non-cancelling wait timeout.
    const early = await manager.waitForRun(live, 50);
    assert.strictEqual(early.status, "still_running");

    // A later wait observes the final result after native stream finalization.
    const final = await manager.waitForRun(live, 10_000);
    assert.strictEqual(final.status, "exited");
    if (final.status === "exited") {
      assert.strictEqual(final.stdout, "late");
      assert.strictEqual(final.exit_code, 0);
    }
  });

  it("enforces run ownership and existence for command_wait", async () => {
    await makeFixture();
    const handle = await runCommandGoverned({
      command: NODE,
      args: nodeScript("setTimeout(() => {}, 500)"),
      async: true,
      sessionId: SESSION,
    });

    await assert.rejects(
      (async () => {
        const manager = getRunManager();
        manager.requireOwnedRun(handle.run_id, "different-session");
      })(),
      (err: unknown) => err instanceof Error && err.name === "RunOwnershipError"
    );

    await assert.rejects(
      (async () => {
        const manager = getRunManager();
        manager.requireOwnedRun("run_missing", SESSION);
      })(),
      (err: unknown) => err instanceof Error && err.name === "RunNotFoundError"
    );
  });

  it("never launches a duplicate process for repeated waits", async () => {
    await makeFixture();
    const handle = await runCommandGoverned({
      command: NODE,
      args: nodeScript('process.stdout.write("once")'),
      async: true,
      sessionId: SESSION,
    });

    const manager = getRunManager();
    const live = manager.getLive(handle.run_id);
    const final1 = live
      ? await manager.waitForRun(live, 10_000)
      : manager.getStoredFinalResult(handle.run_id);
    const final2 = manager.getStoredFinalResult(handle.run_id);
    assert.ok(final1 && final1.status === "exited");
    assert.ok(final2 && final2.status === "exited");
    assert.strictEqual((final1 as any).stdout, "once");
    assert.strictEqual((final2 as any).stdout, "once", "repeated waits observe the same settled run, never a replay");
    // Exactly one run record exists; a duplicate launch would create another.
    assert.strictEqual(manager.getFinished(handle.run_id)?.run_id, handle.run_id);
  });
});

describe("A4 public timeout domain lock", () => {
  it("rejects 4294967295, out-of-domain, and malformed public timeouts", async () => {
    await makeFixture();
    for (const invalid of [
      4_294_967_295,
      4_294_967_296,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
    ]) {
      await assert.rejects(
        runCommandGoverned({
          command: NODE,
          args: [],
          timeout_ms: invalid,
          sessionId: SESSION,
        }),
        (err: unknown) => {
          if (!(err instanceof StructuredToolError)) return false;
          assert.strictEqual(err.code, "TIMEOUT_INVALID");
          return true;
        }
      );
    }

    assert.strictEqual(validatePublicTimeoutMs(0, { tool: "t", field: "timeout_ms" }), 0);
    assert.strictEqual(validatePublicTimeoutMs(1, { tool: "t", field: "timeout_ms" }), 1);
    assert.strictEqual(
      validatePublicTimeoutMs(4_294_967_294, { tool: "t", field: "timeout_ms" }),
      4_294_967_294
    );
  });

  it("rejects supplying both legacy timeoutMs and Spec timeout_ms", async () => {
    await makeFixture();
    assert.throws(
      () =>
        preflightGovernedCommandRun({
          command: NODE,
          args: [],
          timeoutMs: 1_000,
          timeout_ms: 2_000,
          sessionId: SESSION,
        }),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "COMMAND_RUN_REJECTED");
        return true;
      }
    );
  });
});

describe("A4 run manager durability", () => {
  it("reconciles previously-running journal records to aborted without replay", async () => {
    await makeFixture();
    const journal = path.join(fixtureRoot as string, "run-journal.jsonl");
    await fs.writeFile(
      journal,
      JSON.stringify({
        run_id: "run_abandoned",
        session_id: SESSION,
        command: "node -e stale",
        started_at_utc: new Date(Date.now() - 60_000).toISOString(),
        state: "running",
      }) + "\n",
      "utf8"
    );

    const reconciled = await initializeRunManager();
    assert.strictEqual(reconciled, 1);

    const manager = getRunManager();
    const record = manager.getFinished("run_abandoned");
    assert.ok(record);
    assert.strictEqual(record?.state, "aborted");
    assert.strictEqual(manager.isLive("run_abandoned"), false);
  });

  it("closes contained processes on server termination", async () => {
    await makeFixture();
    const handle = await runCommandGoverned({
      command: NODE,
      args: nodeScript("setInterval(() => {}, 1_000)"),
      async: true,
      sessionId: SESSION,
    });
    const manager = getRunManager();
    const live = manager.getLive(handle.run_id);
    assert.ok(live);
    const pid = live.native.pid();
    assert.ok(pid > 0);

    manager.shutdownAll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!processAlive(pid), "server termination must close the contained process tree");
  });
});
