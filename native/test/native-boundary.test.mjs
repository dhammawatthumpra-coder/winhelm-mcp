import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const helpers = join(here, "helpers");
const prodPath = process.env.WINHELM_NATIVE_PROD_ADDON;
const testPath = process.env.WINHELM_NATIVE_TEST_ADDON;
assert.ok(prodPath, "WINHELM_NATIVE_PROD_ADDON is required");
assert.ok(testPath, "WINHELM_NATIVE_TEST_ADDON is required");

const prod = require(prodPath);
const native = require(testPath);
const root = mkdtempSync(join(tmpdir(), "winhelm-nb1-"));

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(intervalMs);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return false;
  }
}

function tempArtifactsFor(target) {
  const dir = dirname(target);
  const prefix = "." + target.split(/[\\/]/).at(-1) + ".winhelm.tmp.";
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dir, name));
}

test("production addon exports only the narrow native capability surface", () => {
  const names = Object.getOwnPropertyNames(prod).sort();
  assert.deepEqual(names, [
    "abi",
    "atomicReplace",
    "createExclusive",
    "napiVersion",
    "spawnContained",
    "stableReadOpen",
  ]);
  assert.equal(prod.abi, "node-api");
  assert.equal(prod.napiVersion, 10);
  assert.equal("atomicReplaceTest" in prod, false);
  assert.equal("spawnContainedTest" in prod, false);
  assert.equal("getCurrentProcessHandleCount" in prod, false);
});

test("NB-FILE-1 retained stable-read handle hashes through the retained handle and denies writers", () => {
  const path = join(root, "stable.txt");
  const content = Buffer.from("stable-read-content\n", "utf8");
  writeFileSync(path, content);

  const handle = prod.stableReadOpen(path);
  const snapshot = handle.snapshot();
  assert.equal(snapshot.bytes, content.length);
  assert.equal(snapshot.sha256, sha256(content));
  assert.equal(snapshot.reparsePoint, false);

  assert.equal(readFileSync(path, "utf8"), content.toString("utf8"));

  const denied = spawnSync(process.execPath, [join(helpers, "writer-attempt.mjs"), path], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(denied.status, 42, denied.stderr || denied.stdout);

  handle.close();

  const allowed = spawnSync(process.execPath, [join(helpers, "writer-attempt.mjs"), path], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
});

test("NB-FILE-1 preserves native sharing violation information when acquisition conflicts with a writer", async () => {
  const path = join(root, "stable-conflict.txt");
  const ready = join(root, "writer-ready.txt");
  writeFileSync(path, "writer-held\n", "utf8");

  const child = spawn(process.execPath, [join(helpers, "hold-writer.mjs"), path, ready], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitFor(() => existsSync(ready));
    assert.throws(
      () => prod.stableReadOpen(path),
      (error) => {
        assert.equal(error.code, "STABLE_READ_UNAVAILABLE");
        assert.equal(error.nativeCode, 32);
        return true;
      },
    );
  } finally {
    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000).catch(() => {});
  }
});

test("NB-FILE-1 reports reparse metadata for a representative junction without traversing it", () => {
  const targetDir = join(root, "junction-target");
  const junction = join(root, "junction-link");
  mkdirSync(targetDir);
  writeFileSync(join(targetDir, "inside.txt"), "inside\n", "utf8");
  symlinkSync(targetDir, junction, "junction");

  const handle = prod.stableReadOpen(junction);
  const metadata = handle.metadata();
  handle.close();

  assert.equal(metadata.reparsePoint, true);
  assert.notEqual(metadata.reparseTag, 0);
});

test("NB-FILE-2 CREATE_NEW exclusive creation never overwrites an existing target", () => {
  const path = join(root, "exclusive.txt");
  const first = Buffer.from("first\n");
  const second = Buffer.from("second\n");

  const created = prod.createExclusive(path, first);
  assert.equal(created.created, true);
  assert.equal(created.flushed, true);
  assert.equal(readFileSync(path, "utf8"), "first\n");

  assert.throws(
    () => prod.createExclusive(path, second),
    (error) => {
      assert.equal(error.code, "FILE_ALREADY_EXISTS");
      assert.ok(error.nativeCode === 80 || error.nativeCode === 183);
      return true;
    },
  );
  assert.equal(readFileSync(path, "utf8"), "first\n");
});

test("NB-FILE-2 atomic replace flushes before exact MoveFileExW commit and uses same-directory staging", () => {
  const path = join(root, "atomic-success.txt");
  writeFileSync(path, "old-complete\n", "utf8");

  const result = prod.atomicReplace(path, Buffer.from("new-complete\n"));
  assert.equal(result.flushed, true);
  assert.equal(result.committed, true);
  assert.equal(result.moveFlags, 9);
  assert.equal(resolve(result.tempDirectory).toLowerCase(), resolve(result.targetDirectory).toLowerCase());
  assert.equal(readFileSync(path, "utf8"), "new-complete\n");
  assert.deepEqual(tempArtifactsFor(path), []);
});

test("NB-FILE-2 injected pre-commit failures preserve complete old content and clean staging files", () => {
  const path = join(root, "atomic-fail.txt");
  const old = "OLD-COMPLETE-" + "A".repeat(65536);
  const newer = "NEW-COMPLETE-" + "B".repeat(65536);

  for (const failpoint of ["after_create", "after_write", "after_flush"]) {
    writeFileSync(path, old, "utf8");
    assert.throws(
      () => native.atomicReplaceTest(path, Buffer.from(newer), failpoint),
      (error) => {
        assert.equal(error.code, "TEST_FAILPOINT");
        return true;
      },
    );
    assert.equal(readFileSync(path, "utf8"), old);
    assert.deepEqual(tempArtifactsFor(path), []);
  }
});

test("NB-FILE-2 crash-after-flush stress never exposes partial or mixed target content", () => {
  const path = join(root, "atomic-crash.txt");
  const old = "OLD-COMPLETE-" + "C".repeat(131072);
  writeFileSync(path, old, "utf8");

  for (let i = 0; i < 12; i += 1) {
    const token = String(i).padStart(3, "0");
    const child = spawnSync(
      process.execPath,
      [join(helpers, "atomic-crash-child.mjs"), path, token],
      {
        env: { ...process.env, WINHELM_NATIVE_TEST_ADDON: testPath },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(child.status, 86, child.stderr || child.stdout);
    assert.equal(readFileSync(path, "utf8"), old);
    for (const artifact of tempArtifactsFor(path)) {
      unlinkSync(artifact);
    }
  }
});

test("NB-FILE-2 repeated successful commits always produce complete new content", () => {
  const path = join(root, "atomic-stress.txt");
  writeFileSync(path, "seed", "utf8");
  for (let i = 0; i < 80; i += 1) {
    const value = "VALUE-" + String(i).padStart(4, "0") + "-" + String(i % 10).repeat(65536);
    prod.atomicReplace(path, Buffer.from(value));
    assert.equal(readFileSync(path, "utf8"), value);
  }
  assert.deepEqual(tempArtifactsFor(path), []);
});

test("NB-PROC-1 configuration/assignment/pre-resume failures never execute user payload", async () => {
  const cases = [
    ["before_job_config", "TEST_FAILPOINT"],
    ["force_job_config_failure", "JOB_CONFIG_FAILED"],
    ["before_assign", "TEST_FAILPOINT"],
    ["force_assign_failure", "JOB_ASSIGN_FAILED"],
    ["before_resume", "TEST_FAILPOINT"],
  ];
  for (const [failpoint, expectedCode] of cases) {
    const marker = join(root, "sentinel-" + failpoint + ".json");
    assert.equal(existsSync(marker), false);
    assert.throws(
      () => native.spawnContainedTest(
        process.execPath,
        [join(helpers, "payload-sentinel.mjs"), marker],
        null,
        failpoint,
      ),
      (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(typeof error.nativeCode, "number");
        return true;
      },
    );
    await sleep(150);
    assert.equal(existsSync(marker), false, "payload executed at " + failpoint);
  }
});

test("NB-PROC-1 rejects oversized Windows command lines before CreateProcessW", () => {
  assert.throws(
    () => prod.spawnContained(process.execPath, ["X".repeat(32760)]),
    (error) => {
      assert.equal(error.code, "INPUT_TOO_LARGE");
      return true;
    },
  );
});

test("NB-PROC-1 production sequence is suspended -> configured -> assigned -> resumed and wait is deterministic", () => {
  const cmd = join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const run = native.spawnContained(cmd, ["/d", "/s", "/c", "exit 7"]);
  assert.deepEqual(run.testSteps(), [
    "CREATE_SUSPENDED",
    "JOB_CONFIGURED",
    "ASSIGNED_TO_JOB",
    "RESUMED",
  ]);
  assert.equal(run.isInJob(), true);
  const waited = run.wait(5000);
  assert.deepEqual(waited, { status: "exited", exitCode: 7 });
  run.close();
});

test("NB-PROC-1 Job Object contains immediate descendants and kill-on-job-close terminates the tree", async () => {
  const statePath = join(root, "tree-state.txt");
  const run = native.spawnContained(
    process.execPath,
    [join(helpers, "tree-root.mjs"), statePath],
  );

  try {
    await waitFor(() => {
      if (!existsSync(statePath)) return false;
      const lines = readFileSync(statePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      return lines.length >= 3;
    }, 10000);

    const entries = Object.fromEntries(
      readFileSync(statePath, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [kind, pid] = line.split(":");
          return [kind, Number(pid)];
        }),
    );

    assert.ok(entries.root > 0);
    assert.ok(entries.child > 0);
    assert.ok(entries.grandchild > 0);
    assert.equal(run.pid(), entries.root);
    assert.equal(run.isInJob(), true);
    assert.equal(run.testIsPidInJob(entries.child), true);
    assert.equal(run.testIsPidInJob(entries.grandchild), true);

    run.testCloseJob();
    const waited = run.wait(5000);
    assert.equal(waited.status, "exited");

    await waitFor(
      () => !processAlive(entries.root) && !processAlive(entries.child) && !processAlive(entries.grandchild),
      10000,
    );
  } finally {
    try { run.terminate(); } catch {}
    run.close();
  }
});

test("NB-PROC-1 repeated launch/wait/cleanup cycles show no material native handle leak", () => {
  const cmd = join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const before = native.getCurrentProcessHandleCount();

  for (let i = 0; i < 120; i += 1) {
    const run = native.spawnContained(cmd, ["/d", "/s", "/c", "exit 0"]);
    const result = run.wait(5000);
    assert.deepEqual(result, { status: "exited", exitCode: 0 });
    run.close();
  }

  const after = native.getCurrentProcessHandleCount();
  assert.ok(
    after <= before + 4,
    `handle count grew materially: before=${before}, after=${after}`,
  );
});
