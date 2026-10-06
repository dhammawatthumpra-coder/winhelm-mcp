/**
 * Spec 3.4 Tier B native conformance tests.
 *
 * Verifies the narrow Tier-B native additions: the read-only
 * `memoryStatus` (GlobalMemoryStatusEx) module export and the
 * non-cancelling `resourceInfo` Job Object observation on governed
 * contained processes. Loaded from the same pinned build as the accepted
 * NB1/NB-ENV conformance suites.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const prodPath = process.env.WINHELM_NATIVE_PROD_ADDON;
assert.ok(prodPath, "WINHELM_NATIVE_PROD_ADDON is required");
const prod = require(prodPath);

const pingExe = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "ping.exe"
);

test("Tier B native memoryStatus exposes sane GlobalMemoryStatusEx counters", () => {
  const status = prod.memoryStatus();
  assert.equal(typeof status.memoryLoadPercent, "number");
  assert.ok(status.memoryLoadPercent >= 0 && status.memoryLoadPercent <= 100);
  assert.equal(typeof status.totalPhysBytes, "bigint");
  assert.equal(typeof status.availPhysBytes, "bigint");
  assert.ok(status.totalPhysBytes > 0n);
  assert.ok(status.availPhysBytes > 0n);
  assert.ok(status.availPhysBytes <= status.totalPhysBytes);
  assert.ok(status.totalPageFileBytes > 0n);
  assert.ok(status.availPageFileBytes >= 0n);
  assert.ok(status.availPageFileBytes <= status.totalPageFileBytes);
  assert.ok(status.totalVirtualBytes > 0n);
  assert.ok(status.availVirtualBytes >= 0n);
});

test("Tier B native resourceInfo observes a governed run without altering it", () => {
  const run = prod.spawnContained(pingExe, ["-n", "15", "127.0.0.1"], null, {
    environment: Object.entries(process.env)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ name, value })),
    captureLimitBytes: 65_536,
  });
  try {
    const first = run.resourceInfo();
    assert.equal(typeof first.peakWorkingSetBytes, "bigint");
    assert.equal(typeof first.currentPrivateBytes, "bigint");
    assert.ok(first.peakWorkingSetBytes > 0n);
    assert.ok(first.currentPrivateBytes > 0n);
    assert.equal(typeof first.userCpuTimeNs, "bigint");
    assert.equal(typeof first.kernelCpuTimeNs, "bigint");
    assert.ok(first.userCpuTimeNs >= 0n);
    assert.ok(first.kernelCpuTimeNs >= 0n);
    assert.ok(Array.isArray(first.pids));
    assert.ok(first.pids.includes(run.pid()));

    const second = run.resourceInfo();
    assert.ok(second.userCpuTimeNs >= first.userCpuTimeNs);
    assert.ok(second.kernelCpuTimeNs >= first.kernelCpuTimeNs);
    assert.ok(second.peakWorkingSetBytes >= first.peakWorkingSetBytes);
    assert.equal(run.isInJob(), true, "observation must not remove the process from the job");
    assert.equal(
      typeof run.wait(0).status,
      "string",
      "process must remain observable after monitoring"
    );
  } finally {
    run.close();
  }
});

test("Tier B resourceInfo is not present on the module surface itself", () => {
  assert.equal("resourceInfo" in prod, false);
});
