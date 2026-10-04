import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const prodPath = process.env.WINHELM_NATIVE_PROD_ADDON;
const testPath = process.env.WINHELM_NATIVE_TEST_ADDON;
assert.ok(prodPath, "WINHELM_NATIVE_PROD_ADDON is required");
assert.ok(testPath, "WINHELM_NATIVE_TEST_ADDON is required");

const prod = require(prodPath);
const native = require(testPath);
const childExe = process.env.WINHELM_A4_CHILD || join(dirname(prodPath), "a4_child.exe");
assert.ok(existsSync(childExe), "a4_child.exe test helper is required");

// The native child helper is subject to a machine-local sandbox policy that
// denies file writes under the user profile, so qualification artifacts live
// next to the build outputs instead of tmpdir().
const root = join(dirname(prodPath), "nb2-test-root");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function patternByte(index) {
  return (index * 31 + 7) & 0xff;
}

function patternBuffer(length, offset = 0) {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = patternByte(offset + i);
  }
  return out;
}

// Mirrors a4-child.cpp `write both`: 8 KiB chunks interleaved deterministically.
function simulateInterleaved(totalBytes, chunkSize = 8192) {
  const stdout = [];
  const stderr = [];
  let emitted = 0;
  let toStdout = true;
  let remaining = totalBytes;
  while (remaining > 0) {
    const take = Math.min(remaining, chunkSize);
    const target = toStdout ? stdout : stderr;
    for (let i = 0; i < take; i += 1) {
      target.push(patternByte(emitted + i));
    }
    emitted += take;
    remaining -= take;
    toStdout = !toStdout;
  }
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function child(name) {
  return join(root, name);
}

function a4Options(overrides = {}) {
  return {
    environment: [],
    captureLimitBytes: 4096,
    ...overrides,
  };
}

function assertInvalid(call, code, label) {
  assert.throws(
    call,
    (error) => {
      assert.equal(error.code, code, label);
      return true;
    },
    label,
  );
}

test("production addon still exports only the narrow NB1 top-level surface", () => {
  const names = Object.getOwnPropertyNames(prod).sort();
  assert.deepEqual(names, [
    "abi",
    "atomicReplace",
    "createExclusive",
    "napiVersion",
    "spawnContained",
    "stableReadOpen",
  ]);
});

test("NB-ENV-1 explicit environment entries are inherited exactly and parent-only sentinels are not", () => {
  process.env.WINHELM_PARENT_ONLY_SENTINEL = "token-do-not-inherit";
  process.env.WINHELM_ORDINARY_SENTINEL = "ordinary-data";

  const outPath = child("env-explicit.txt");
  const run = prod.spawnContained(childExe, [
    "env-report",
    outPath,
    "WINHELM_SUPPLIED_SENTINEL",
    "WINHELM_PARENT_ONLY_SENTINEL",
    "WINHELM_ORDINARY_SENTINEL",
    "ΦΩ-KEY",
    "PUNCT VALUE",
    "PATH",
  ], null, a4Options({
    environment: [
      { name: "WINHELM_SUPPLIED_SENTINEL", value: "supplied-42" },
      { name: "ΦΩ-KEY", value: "态-値 Ω" },
      { name: "PUNCT VALUE", value: "a b|c;d,e(f)" },
    ],
  }));
  try {
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    const lines = readFileSync(outPath, "utf8").trim().split("\n");
    const seen = Object.fromEntries(
      lines.map((line) => {
        const tab = line.indexOf("\t");
        return [line.slice(0, tab), line.slice(tab + 1)];
      }),
    );
    assert.equal(seen["WINHELM_SUPPLIED_SENTINEL"], "supplied-42");
    assert.equal(seen["WINHELM_PARENT_ONLY_SENTINEL"], "<MISSING>");
    assert.equal(seen["WINHELM_ORDINARY_SENTINEL"], "<MISSING>");
    assert.equal(seen["ΦΩ-KEY"], "态-値 Ω");
    assert.equal(seen["PUNCT VALUE"], "a b|c;d,e(f)");
    assert.equal(seen["PATH"], "<MISSING>");
  } finally {
    delete process.env.WINHELM_PARENT_ONLY_SENTINEL;
    delete process.env.WINHELM_ORDINARY_SENTINEL;
    run.close();
  }
});

test("NB-ENV-1 explicitly empty environment gives the child zero variables", () => {
  const outPath = child("env-count.txt");
  const run = prod.spawnContained(
    childExe,
    ["env-count", outPath],
    null,
    a4Options({ environment: [] }),
  );
  try {
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    assert.equal(readFileSync(outPath, "utf8").trim(), "0");
  } finally {
    run.close();
  }
});

test("NB-ENV-1 rejects duplicate case-insensitive environment names", () => {
  assertInvalid(
    () => prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      a4Options({
        environment: [
          { name: "DUPLICATE", value: "a" },
          { name: "duplicate", value: "b" },
        ],
      }),
    ),
    "INVALID_ARGUMENT",
    "case-insensitive duplicate environment names",
  );
});

test("NB-ENV-1 rejects invalid environment names and values", () => {
  assertInvalid(
    () => prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      a4Options({ environment: [{ name: "BAD=NAME", value: "x" }] }),
    ),
    "INVALID_ARGUMENT",
    "'=' in environment name",
  );
  assertInvalid(
    () => prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      a4Options({ environment: [{ name: "", value: "x" }] }),
    ),
    "INVALID_ARGUMENT",
    "empty environment name",
  );
  assertInvalid(
    () => prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      a4Options({ environment: [{ name: "A\u0000B", value: "x\u0000y" }] }),
    ),
    "INVALID_ARGUMENT",
    "embedded NUL in environment value",
  );
});

test("NB-ENV-1 rejects malformed option shapes", () => {
  assertInvalid(
    () => prod.spawnContained(childExe, ["exit", "0"], null, {}),
    "INVALID_ARGUMENT",
    "missing environment",
  );
  assertInvalid(
    () => prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      { environment: [], captureLimitBytes: -1 },
    ),
    "INVALID_ARGUMENT",
    "negative capture limit",
  );
  assertInvalid(
    () => prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      { environment: [], captureLimitBytes: 1.5 },
    ),
    "INVALID_ARGUMENT",
    "fractional capture limit",
  );
  assertInvalid(
    () => prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      { environment: [], captureLimitBytes: 0, extra: true },
    ),
    "INVALID_ARGUMENT",
    "unexpected option key",
  );
});

test("NB-PROC-2 child stdin is EOF-producing and non-interactive", () => {
  const outPath = child("stdin-report.txt");
  const run = prod.spawnContained(
    childExe,
    ["stdin-report", outPath],
    null,
    a4Options(),
  );
  try {
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    assert.equal(readFileSync(outPath, "utf8").trim(), "0");
  } finally {
    run.close();
  }
});

test("NB-PROC-2 empty stream completes with empty-stream SHA-256 and no truncation", () => {
  const run = prod.spawnContained(
    childExe,
    ["write", "stdout", "0"],
    null,
    a4Options({ captureLimitBytes: 4096 }),
  );
  try {
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    const state = run.streamState("stdout");
    assert.equal(state.complete, true);
    assert.equal(state.totalBytes, 0);
    assert.equal(state.retainedBytes, 0);
    assert.equal(state.truncated, false);
    assert.equal(state.error, null);
    assert.equal(state.sha256, sha256(Buffer.alloc(0)));
    assert.equal(run.streamCapture("stdout").length, 0);
  } finally {
    run.close();
  }
});

test("NB-PROC-2 small streams hash exactly and stay untruncated", () => {
  const run = prod.spawnContained(
    childExe,
    ["write", "both", "3333"],
    null,
    a4Options({ captureLimitBytes: 4096 }),
  );
  try {
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    const expected = simulateInterleaved(3333);
    for (const stream of ["stdout", "stderr"]) {
      const state = run.streamState(stream);
      assert.equal(state.complete, true);
      assert.equal(state.truncated, false);
      assert.equal(state.totalBytes, expected[stream].length);
      assert.equal(state.retainedBytes, expected[stream].length);
      assert.equal(state.sha256, sha256(expected[stream]));
      assert.deepEqual(run.streamCapture(stream), expected[stream]);
    }
  } finally {
    run.close();
  }
});

test("NB-PROC-2 streams far beyond the capture limit are truncated but fully hashed", () => {
  const total = 4 * 1024 * 1024;
  const limit = 10000;
  const run = prod.spawnContained(
    childExe,
    ["write", "stdout", String(total)],
    null,
    a4Options({ captureLimitBytes: limit }),
  );
  try {
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    const expected = patternBuffer(total);
    const state = run.streamState("stdout");
    assert.equal(state.complete, true);
    assert.equal(state.truncated, true);
    assert.equal(state.totalBytes, total);
    assert.equal(state.retainedBytes, limit);
    assert.equal(state.sha256, sha256(expected));
    assert.deepEqual(run.streamCapture("stdout"), expected.subarray(0, limit));
  } finally {
    run.close();
  }
});

test("NB-PROC-2 capture limit equal to output size does not set truncated", () => {
  const total = 10000;
  const run = prod.spawnContained(
    childExe,
    ["write", "stdout", String(total)],
    null,
    a4Options({ captureLimitBytes: total }),
  );
  try {
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    const state = run.streamState("stdout");
    assert.equal(state.truncated, false);
    assert.equal(state.retainedBytes, total);
    assert.equal(state.sha256, sha256(patternBuffer(total)));
  } finally {
    run.close();
  }
});

test("NB-PROC-2 zero capture limit retains nothing but hashes everything", () => {
  const total = 100000;
  const run = prod.spawnContained(
    childExe,
    ["write", "stdout", String(total)],
    null,
    a4Options({ captureLimitBytes: 0 }),
  );
  try {
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    const state = run.streamState("stdout");
    assert.equal(state.truncated, true);
    assert.equal(state.retainedBytes, 0);
    assert.equal(state.totalBytes, total);
    assert.equal(state.sha256, sha256(patternBuffer(total)));
  } finally {
    run.close();
  }
});

for (const scenario of [
  ["stdout-only", "stdout", "12MiB-stdout"],
  ["stderr-only", "stderr", "12MiB-stderr"],
]) {
  test(`NB-PROC-2 high-volume ${scenario[0]} completes without pipe deadlock`, () => {
    const total = 12 * 1024 * 1024;
    const run = prod.spawnContained(
      childExe,
      ["write", scenario[1], String(total)],
      null,
      a4Options({ captureLimitBytes: 65536 }),
    );
    try {
      assert.deepEqual(run.wait(60000), { status: "exited", exitCode: 0 });
      assert.equal(run.isInJob(), true);
      const expected = patternBuffer(total);
      const state = run.streamState(scenario[1]);
      assert.equal(state.complete, true);
      assert.equal(state.truncated, true);
      assert.equal(state.totalBytes, total);
      assert.equal(state.sha256, sha256(expected));
      assert.deepEqual(
        run.streamCapture(scenario[1]),
        expected.subarray(0, 65536),
      );
    } finally {
      run.close();
    }
  });
}

test("NB-PROC-2 simultaneous high-volume stdout and stderr completes without deadlock", () => {
  const total = 24 * 1024 * 1024;
  const run = prod.spawnContained(
    childExe,
    ["write", "both", String(total)],
    null,
    a4Options({ captureLimitBytes: 65536 }),
  );
  try {
    assert.deepEqual(run.wait(60000), { status: "exited", exitCode: 0 });
    assert.equal(run.isInJob(), true);
    const expected = simulateInterleaved(total);
    assert.equal(expected.stdout.length + expected.stderr.length, total);
    for (const stream of ["stdout", "stderr"]) {
      const state = run.streamState(stream);
      assert.equal(state.complete, true);
      assert.equal(state.totalBytes, expected[stream].length);
      assert.equal(state.sha256, sha256(expected[stream]));
    }
  } finally {
    run.close();
  }
});

test("NB-SINK-1 create_new sink succeeds on an absent path and mirrors the full stream", () => {
  const sinkPath = child("sink-create-new.txt");
  const total = 300000;
  const run = prod.spawnContained(
    childExe,
    ["write", "stdout", String(total)],
    null,
    a4Options({ stdoutSink: { path: sinkPath, mode: "create_new" } }),
  );
  try {
    assert.deepEqual(run.wait(30000), { status: "exited", exitCode: 0 });
    const expected = patternBuffer(total);
    assert.equal(readFileSync(sinkPath).length, total);
    assert.equal(sha256(readFileSync(sinkPath)), sha256(expected));
    const state = run.streamState("stdout");
    assert.equal(state.sha256, sha256(expected));
  } finally {
    run.close();
  }
});

test("NB-SINK-1 create_new sink rejects an existing path before user payload executes", async () => {
  const sinkPath = child("sink-existing.txt");
  const marker = child("sink-existing-marker.txt");
  writeFileSync(sinkPath, "already-here\n", "utf8");
  assert.equal(existsSync(marker), false);
  assertInvalid(
    () => prod.spawnContained(
      process.execPath,
      ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
      null,
      a4Options({ stdoutSink: { path: sinkPath, mode: "create_new" } }),
    ),
    "SINK_ALREADY_EXISTS",
    "create_new on existing sink path",
  );
  await sleep(150);
  assert.equal(existsSync(marker), false, "payload executed despite sink failure");
});

test("NB-SINK-1 overwrite sink replaces prior content with the exact stream", () => {
  const sinkPath = child("sink-overwrite.txt");
  writeFileSync(sinkPath, "STALE-CONTENT-".repeat(1000), "utf8");
  const total = 200000;
  const run = prod.spawnContained(
    childExe,
    ["write", "stderr", String(total)],
    null,
    a4Options({ stderrSink: { path: sinkPath, mode: "overwrite" } }),
  );
  try {
    assert.deepEqual(run.wait(30000), { status: "exited", exitCode: 0 });
    const expected = patternBuffer(total);
    assert.equal(sha256(readFileSync(sinkPath)), sha256(expected));
    assert.equal(run.streamState("stderr").sha256, sha256(expected));
  } finally {
    run.close();
  }
});

test("NB-SINK-1 append sink preserves the prefix and appends the stream exactly once", () => {
  const sinkPath = child("sink-append.txt");
  const prefix = "PREFIX-REMAINS\n";
  writeFileSync(sinkPath, prefix, "utf8");
  const total = 150000;
  const run = prod.spawnContained(
    childExe,
    ["write", "stdout", String(total)],
    null,
    a4Options({ stdoutSink: { path: sinkPath, mode: "append" } }),
  );
  try {
    assert.deepEqual(run.wait(30000), { status: "exited", exitCode: 0 });
    const expected = Buffer.concat([Buffer.from(prefix, "utf8"), patternBuffer(total)]);
    assert.equal(sha256(readFileSync(sinkPath)), sha256(expected));
  } finally {
    run.close();
  }
});

test("NB-SINK-1 same-path stdout/stderr sinks fail closed", () => {
  const sinkPath = child("sink-conflict.txt");
  assertInvalid(
    () => prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      a4Options({
        stdoutSink: { path: sinkPath, mode: "create_new" },
        stderrSink: { path: sinkPath.toUpperCase(), mode: "create_new" },
      }),
    ),
    "SINK_PATH_CONFLICT",
    "same-path sink defense",
  );
});

test("NB-SINK-1 injected sink write failure is fatal and never reports silent success", async () => {
  const sinkPath = child("sink-fail-inject.txt");
  const run = native.spawnContainedTest(
    childExe,
    ["write", "stdout", String(4 * 1024 * 1024)],
    null,
    null,
    a4Options({
      captureLimitBytes: 4096,
      stdoutSink: {
        path: sinkPath,
        mode: "overwrite",
        testFailAfterBytes: 1000,
      },
    }),
  );
  try {
    const waited = await run.waitAsync(30000);
    assert.equal(waited.status, "exited");
    const state = run.streamState("stdout");
    assert.equal(state.complete, true);
    assert.notEqual(state.error, null, "stream error state must be recorded");
    assert.equal(state.error.code, "STREAM_IO_FAILED");
    assert.equal(state.sha256, null, "no full-stream hash may be reported for a failed stream");
    await sleep(150);
  } finally {
    try { run.close(); } catch {}
  }
});

test("NB-HANDLE-2 unrelated inheritable sentinel handles do not reach the child", async () => {
  const sentinelPath = child("sentinel-handle.txt");
  const resultPath = child("sentinel-result.txt");
  writeFileSync(sentinelPath, "sentinel\n", "utf8");
  native.createTestInheritableSentinel(sentinelPath);
  try {
    const run = prod.spawnContained(
      childExe,
      ["probe-exclusive", sentinelPath, resultPath],
      null,
      a4Options(),
    );
    try {
      await sleep(400);
      native.releaseTestInheritableSentinel();
      assert.deepEqual(await run.waitAsync(15000), {
        status: "exited",
        exitCode: 0,
      });
      assert.equal(
        readFileSync(resultPath, "utf8").trim(),
        "OPENED",
        "child must be able to open the sentinel file only after the parent releases it",
      );
    } finally {
      run.close();
    }
  } finally {
    native.releaseTestInheritableSentinel();
  }
});

test("NB-WAIT-1 async wait keeps the Node event loop responsive", async () => {
  let timerFired = false;
  const run = prod.spawnContained(
    childExe,
    ["alloc", "1"],
    null,
    a4Options(),
  );
  try {
    const waitPromise = run.waitAsync(15000);
    setTimeout(() => {
      timerFired = true;
    }, 50).unref?.();
    const result = await waitPromise;
    assert.deepEqual(result, { status: "exited", exitCode: 0 });
    assert.equal(timerFired, true, "JS timer must run while native async wait is pending");
  } finally {
    run.close();
  }
});

test("NB-WAIT-1 async timeout resolves as timeout without terminating the process", async () => {
  const run = prod.spawnContained(
    childExe,
    ["alloc", "1"],
    null,
    a4Options(),
  );
  try {
    assert.deepEqual(await run.waitAsync(50), { status: "timeout" });
    const result = await run.waitAsync(15000);
    assert.deepEqual(result, { status: "exited", exitCode: 0 });
  } finally {
    run.close();
  }
});

test("NB-WAIT-1 terminate while an async wait is pending resolves the wait", async () => {
  const run = prod.spawnContained(
    childExe,
    ["alloc", "32"],
    null,
    a4Options(),
  );
  try {
    const waitPromise = run.waitAsync(15000);
    await sleep(50);
    run.terminate(5);
    assert.deepEqual(await waitPromise, { status: "exited", exitCode: 5 });
  } finally {
    run.close();
  }
});

test("NB-WAIT-1 overlapping async waits, sync waits, and close are deterministically rejected while pending", async () => {
  const run = prod.spawnContained(
    childExe,
    ["alloc", "1"],
    null,
    a4Options(),
  );
  try {
    for (const [label, value] of [
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["overflow", 0x1_0000_0000],
      ["string", "1"],
    ]) {
      assertInvalid(() => run.waitAsync(value), "INVALID_ARGUMENT", `waitAsync: ${label}`);
    }
    const pending = run.waitAsync(15000);
    assertInvalid(() => run.waitAsync(15000), "ASYNC_WAIT_PENDING", "overlapping async wait");
    assertInvalid(() => run.wait(15000), "ASYNC_WAIT_PENDING", "sync wait during async wait");
    assertInvalid(() => run.close(), "ASYNC_WAIT_PENDING", "close during async wait");
    await pending;
    run.close();
    assertInvalid(() => run.close(), "HANDLE_CLOSED", "double close");
  } finally {
    try { run.close(); } catch {}
  }
});

test("NB-WAIT-1 stream state is deterministic and final after an async wait resolves", async () => {
  const total = 50000;
  const run = prod.spawnContained(
    childExe,
    ["write", "stderr", String(total)],
    null,
    a4Options({ captureLimitBytes: 2048 }),
  );
  try {
    await run.waitAsync(15000);
    const state = run.streamState("stderr");
    assert.equal(state.complete, true);
    assert.equal(state.totalBytes, total);
    assert.equal(state.sha256, sha256(patternBuffer(total)));
  } finally {
    run.close();
  }
});

test("NB-RSS-1 peak RSS tracks the owned contained process only", () => {
  const small = prod.spawnContained(
    childExe,
    ["exit", "0"],
    null,
    a4Options(),
  );
  try {
    assert.deepEqual(small.wait(15000), { status: "exited", exitCode: 0 });
  } finally {
    small.close();
  }

  const large = prod.spawnContained(
    childExe,
    ["alloc", "128"],
    null,
    a4Options(),
  );
  try {
    assert.deepEqual(large.wait(15000), { status: "exited", exitCode: 0 });
    const peak = large.peakRss();
    assert.equal(typeof peak, "number");
    assert.ok(
      peak >= 96 * 1024 * 1024,
      `peak RSS floor not reached: ${peak}`,
    );
  } finally {
    large.close();
  }
});

test("NB-HANDLE-2 repeated A4 launch/cleanup cycles show no material handle leak", () => {
  const before = native.getCurrentProcessHandleCount();
  for (let i = 0; i < 40; i += 1) {
    const run = prod.spawnContained(
      childExe,
      ["exit", "0"],
      null,
      a4Options({ captureLimitBytes: 512 }),
    );
    assert.deepEqual(run.wait(15000), { status: "exited", exitCode: 0 });
    run.close();
  }
  const after = native.getCurrentProcessHandleCount();
  assert.ok(
    after <= before + 8,
    `handle count grew materially: before=${before}, after=${after}`,
  );
});

test("NB-PROC-1 legacy NB1 spawn form remains functional alongside the A4 form", () => {
  const legacy = native.spawnContainedTest(childExe, ["exit", "9"], null, null);
  try {
    assert.deepEqual(legacy.wait(15000), { status: "exited", exitCode: 9 });
  } finally {
    legacy.close();
  }
  const governed = prod.spawnContained(
    childExe,
    ["exit", "3"],
    null,
    a4Options(),
  );
  try {
    assert.deepEqual(governed.wait(15000), { status: "exited", exitCode: 3 });
  } finally {
    governed.close();
  }
});
