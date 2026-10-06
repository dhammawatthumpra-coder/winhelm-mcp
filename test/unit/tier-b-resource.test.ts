/**
 * Spec 3.4 Tier B targeted tests — resource monitoring contract.
 *
 * Covers Work Order §11 items 15–23: native memory_info sanity, the
 * absence of PowerShell/WMI dependencies, live governed-run Job Object
 * observation with session ownership, non-cancellation, retained-only
 * metrics for completed runs, and cross-session/unknown run denials.
 *
 * Native-dependent cases are skipped when the trusted addon is not built,
 * exactly like the accepted Tier A native tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trustedNativeAddonPath } from "../../src/native/boundary.js";
import { getNativeBoundary } from "../../src/native/boundary.js";
import {
  getRunManager,
  resetRunManager,
  RunNotFoundError,
  RunOwnershipError,
  setRunJournalPathForTesting,
} from "../../src/engine/run-manager.js";
import {
  monitorGovernedRun,
  readSystemMemoryInfo,
  resourceMonitorErrorResult,
} from "../../src/engine/resource-monitor.js";

const nativeAvailable = existsSync(trustedNativeAddonPath());
const pingExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "ping.exe");

async function tempJournalPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-res-"));
  return path.join(dir, "run-journal.jsonl");
}

test("Tier B resource monitoring contract", async (t) => {
  await t.test("memory_info returns sane non-negative native counters", {
    skip: nativeAvailable ? false : "native addon not built",
  }, () => {
    const info = readSystemMemoryInfo();
    assert.equal(info.source, "GlobalMemoryStatusEx");
    assert.ok(info.total_physical_bytes > 0);
    assert.ok(info.available_physical_bytes > 0);
    assert.ok(info.available_physical_bytes <= info.total_physical_bytes);
    assert.ok(info.memory_load_percent >= 0 && info.memory_load_percent <= 100);
    assert.ok(info.commit_total_bytes > 0);
    assert.ok(info.commit_available_bytes >= 0);
    assert.ok(info.commit_used_bytes >= 0);
    assert.ok(info.virtual_total_bytes > 0);
    assert.ok(info.virtual_available_bytes >= 0);
  });

  await t.test("memory_info engine uses the native boundary, not PowerShell or WMI", async () => {
    const enginePath = fileURLToPath(
      new URL("../../src/engine/resource-monitor.ts", import.meta.url)
    );
    const source = await fs.readFile(enginePath, "utf8");
    assert.ok(!source.includes("child_process"), "no process spawning allowed");
    assert.ok(
      !/powershell\.exe|\bwmic\b/i.test(source),
      "no PowerShell/WMI executable dependency allowed"
    );
    assert.ok(source.includes("getNativeBoundary()"), "must use the native boundary");
  });

  await t.test(
    "live governed run monitor returns matching run/session, contained PIDs, plausible metrics, and never cancels the run",
    { skip: nativeAvailable ? false : "native addon not built" },
    async () => {
      const journal = await tempJournalPath();
      setRunJournalPathForTesting(journal);
      resetRunManager();
      try {
        const boundary = getNativeBoundary();
        const environment = Object.entries(process.env)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({ name, value: value as string }));
        const native = boundary.spawnContained(
          pingExe,
          ["-n", "30", "127.0.0.1"],
          null,
          { environment, captureLimitBytes: 65_536 }
        );
        const sessionKey = "sess_tier_b_owner";
        const run = getRunManager().registerLaunch({
          sessionId: sessionKey,
          command: "ping -n 30 127.0.0.1",
          native,
        });

        const first = monitorGovernedRun(run.run_id, sessionKey);
        assert.equal(first.run_id, run.run_id);
        assert.equal(first.run_state, "running");
        assert.equal(first.source, "job_object");
        assert.equal(first.session_id, sessionKey);
        assert.ok(first.peak_working_set_bytes > 0);
        assert.ok(first.current_private_bytes > 0);
        assert.ok(first.user_cpu_time_ns >= 0);
        assert.ok(first.kernel_cpu_time_ns >= 0);
        assert.ok(first.contained_pids.includes(native.pid()));
        assert.ok(getRunManager().isLive(run.run_id), "observation must not cancel the run");

        await new Promise((resolve) => setTimeout(resolve, 150));
        const second = monitorGovernedRun(run.run_id, sessionKey);
        assert.ok(
          second.user_cpu_time_ns >= first.user_cpu_time_ns,
          "user CPU time must be monotonic while live"
        );
        assert.ok(
          second.kernel_cpu_time_ns >= first.kernel_cpu_time_ns,
          "kernel CPU time must be monotonic while live"
        );
        assert.ok(
          second.peak_working_set_bytes >= first.peak_working_set_bytes,
          "peak working set must be monotonic while live"
        );

        getRunManager().terminate(run);
        await run.settlement;
      } finally {
        resetRunManager();
        setRunJournalPathForTesting(undefined);
      }
    }
  );

  await t.test("cross-session run_id is denied", {
    skip: nativeAvailable ? false : "native addon not built",
  }, async () => {
    const journal = await tempJournalPath();
    setRunJournalPathForTesting(journal);
    resetRunManager();
    try {
      const boundary = getNativeBoundary();
      const environment = Object.entries(process.env)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => ({ name, value: value as string }));
      const native = boundary.spawnContained(
        pingExe,
        ["-n", "30", "127.0.0.1"],
        null,
        { environment, captureLimitBytes: 65_536 }
      );
      const run = getRunManager().registerLaunch({
        sessionId: "sess_tier_b_owner",
        command: "ping -n 30 127.0.0.1",
        native,
      });

      assert.throws(
        () => monitorGovernedRun(run.run_id, "sess_other_session"),
        (err: unknown) => err instanceof RunOwnershipError
      );
      assert.throws(
        () => monitorGovernedRun(run.run_id, "sess_other_session"),
        (err: unknown) =>
          resourceMonitorErrorResult(err).code === "RUN_PERMISSION_DENIED"
      );
      getRunManager().terminate(run);
      await run.settlement;
    } finally {
      resetRunManager();
      setRunJournalPathForTesting(undefined);
    }
  });

  await t.test("unknown run_id returns the structured RUN_NOT_FOUND error", {
    skip: nativeAvailable ? false : "native addon not built",
  }, () => {
    resetRunManager();
    assert.throws(
      () => monitorGovernedRun("run_does_not_exist", "sess_tier_b_owner"),
      (err: unknown) => err instanceof RunNotFoundError
    );
    try {
      monitorGovernedRun("run_does_not_exist", "sess_tier_b_owner");
    } catch (err) {
      assert.equal(
        resourceMonitorErrorResult(err).code,
        "RUN_NOT_FOUND"
      );
    }
  });

  await t.test(
    "completed run reports only truthfully retained metrics",
    { skip: nativeAvailable ? false : "native addon not built" },
    async () => {
      const journal = await tempJournalPath();
      setRunJournalPathForTesting(journal);
      resetRunManager();
      try {
        const boundary = getNativeBoundary();
        const environment = Object.entries(process.env)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({ name, value: value as string }));
        const native = boundary.spawnContained(
          pingExe,
          ["-n", "1", "127.0.0.1"],
          null,
          { environment, captureLimitBytes: 65_536 }
        );
        const run = getRunManager().registerLaunch({
          sessionId: "sess_tier_b_owner",
          command: "ping -n 1 127.0.0.1",
          native,
        });
        await run.settlement;

        const observation = monitorGovernedRun(run.run_id, "sess_tier_b_owner");
        assert.equal(observation.source, "retained");
        assert.equal(observation.run_state, "exited");
        assert.equal(observation.current_private_bytes, null);
        assert.equal(observation.user_cpu_time_ns, null);
        assert.equal(observation.kernel_cpu_time_ns, null);
        assert.equal(observation.contained_pids, null);
        if (observation.peak_working_set_bytes !== null) {
          assert.ok(observation.peak_working_set_bytes > 0);
        }
        assert.equal(observation.started_at_utc, run.started_at_utc);
      } finally {
        resetRunManager();
        setRunJournalPathForTesting(undefined);
      }
    }
  );
});
