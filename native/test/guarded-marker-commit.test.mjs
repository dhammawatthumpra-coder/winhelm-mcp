import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
const root = mkdtempSync(join(tmpdir(), "winhelm-guarded-marker-"));

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fixture(name, content = "old-marker\n") {
  const parent = join(root, name);
  mkdirSync(parent, { recursive: true });
  const target = join(parent, "winhelm.active-backend.json");
  writeFileSync(target, content, "utf8");
  return { parent, target, old: Buffer.from(content, "utf8") };
}

function snapshot(addon, path) {
  const handle = addon.stableReadOpen(path);
  try {
    return handle.snapshot();
  } finally {
    handle.close();
  }
}

function begin(addon, target, replacement, authority) {
  return addon.guardedMarkerCommitBegin(
    target,
    replacement,
    authority.sha256,
    authority.volumeSerialNumber,
    authority.fileIndexHigh,
    authority.fileIndexLow,
  );
}

function assertGuardError(call, code) {
  assert.throws(call, (error) => {
    assert.equal(error.code, code, error?.stack);
    assert.equal(typeof error.nativeCode, "number");
    assert.equal(typeof error.phase, "string");
    return true;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting for condition");
}

function spawnCommitChild(
  target,
  replacementPath,
  authority,
  barrierPhase = "-",
  crashPhase = "-",
) {
  const child = spawn(
    process.execPath,
    [
      join(helpers, "guarded-marker-child.mjs"),
      target,
      replacementPath,
      authority.sha256,
      String(authority.volumeSerialNumber),
      String(authority.fileIndexHigh),
      String(authority.fileIndexLow),
      barrierPhase,
      crashPhase,
    ],
    {
      env: { ...process.env, WINHELM_NATIVE_TEST_ADDON: testPath },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      stdout = stdout.slice(newline + 1);
      if (waiters.length > 0) waiters.shift()(line);
      else lines.push(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const nextLine = (timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
      if (lines.length > 0) {
        resolve(lines.shift());
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for child output; stderr=${stderr}`)),
        timeoutMs,
      );
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  return { child, nextLine, stderr: () => stderr };
}

async function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for child exit")),
      timeoutMs,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function assertWriteBlocked(path) {
  const attempted = spawnSync(
    process.execPath,
    [join(helpers, "writer-attempt.mjs"), path],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(attempted.status, 42, attempted.stderr || attempted.stdout);
}

function guardArtifacts(parent) {
  return readdirSync(parent).filter((name) => name.includes(".winhelm-guard-"));
}

test("guarded active-backend marker native contract", async (t) => {
  await t.test("normal success proves identity and acknowledge releases", () => {
    const f = fixture("success");
    const authority = snapshot(prod, f.target);
    const replacement = Buffer.from("replacement-marker\n", "utf8");
    const result = begin(prod, f.target, replacement, authority);

    assert.equal(result.outcome, "SUCCESS");
    assert.equal(result.sha256, sha256(replacement));
    assert.equal(result.bytesWritten, replacement.length);
    assert.match(result.transactionId, /^[0-9a-f]{64}$/);
    assert.deepEqual(readFileSync(f.target), replacement);
    assertWriteBlocked(f.target);

    assert.deepEqual(prod.guardedMarkerCommitAcknowledge(result.transactionId), {
      acknowledged: true,
    });
    const published = snapshot(prod, f.target);
    assert.equal(published.sha256, result.sha256);
    assert.equal(published.volumeSerialNumber, result.volumeSerialNumber);
    assert.equal(published.fileIndexHigh, result.fileIndexHigh);
    assert.equal(published.fileIndexLow, result.fileIndexLow);
    writeFileSync(f.target, "released\n", "utf8");
  });

  await t.test("wrong expected SHA fails closed and cleans the held stage", () => {
    const f = fixture("wrong-sha");
    const authority = snapshot(prod, f.target);
    const replacement = Buffer.from("new\n");
    assertGuardError(
      () => begin(prod, f.target, replacement, { ...authority, sha256: "0".repeat(64) }),
      "TARGET_CHANGED",
    );
    assert.deepEqual(readFileSync(f.target), f.old);
    assert.deepEqual(guardArtifacts(f.parent), []);
  });

  await t.test("wrong expected identity fails with identical current bytes", () => {
    const f = fixture("wrong-identity");
    const authority = snapshot(prod, f.target);
    const wrong = { ...authority, fileIndexLow: authority.fileIndexLow ^ 1 };
    assertGuardError(
      () => begin(prod, f.target, Buffer.from("new\n"), wrong),
      "TARGET_CHANGED",
    );
    assert.deepEqual(readFileSync(f.target), f.old);
  });

  await t.test("absent target is distinguished", () => {
    const parent = join(root, "absent");
    mkdirSync(parent);
    const target = join(parent, "winhelm.active-backend.json");
    assertGuardError(
      () => begin(prod, target, Buffer.from("new\n"), {
        sha256: "0".repeat(64),
        volumeSerialNumber: 0,
        fileIndexHigh: 0,
        fileIndexLow: 0,
      }),
      "TARGET_ABSENT",
    );
    assert.deepEqual(guardArtifacts(parent), []);
  });

  await t.test("target and immediate-parent reparse points are rejected", () => {
    const targetParent = join(root, "target-reparse");
    mkdirSync(targetParent);
    const realTarget = join(targetParent, "real-marker-directory");
    const linkedTarget = join(targetParent, "winhelm.active-backend.json");
    mkdirSync(realTarget);
    writeFileSync(join(realTarget, "sentinel.txt"), "old\n");
    symlinkSync(realTarget, linkedTarget, "junction");
    assert.throws(
      () => begin(prod, linkedTarget, Buffer.from("new\n"), {
          sha256: sha256(Buffer.from("old\n")),
          volumeSerialNumber: 0,
          fileIndexHigh: 0,
          fileIndexLow: 0,
        }),
      (error) => {
        assert.equal(error.code, "TARGET_CHANGED");
        assert.ok(
          error.nativeCode === 4390 || error.nativeCode === 4394,
          `expected a native reparse rejection, observed ${error.nativeCode}`,
        );
        return true;
      },
    );
    assert.equal(readFileSync(join(realTarget, "sentinel.txt"), "utf8"), "old\n");

    const realParent = join(root, "real-parent");
    const aliasParent = join(root, "parent-junction");
    mkdirSync(realParent);
    const realMarker = join(realParent, "winhelm.active-backend.json");
    writeFileSync(realMarker, "old\n");
    symlinkSync(realParent, aliasParent, "junction");
    const authority = snapshot(prod, realMarker);
    assert.throws(
      () => begin(prod, join(aliasParent, "winhelm.active-backend.json"), Buffer.from("new\n"), authority),
      (error) => {
        assert.equal(error.code, "COMMIT_FAILED");
        assert.ok(
          error.nativeCode === 4390 || error.nativeCode === 4394,
          `expected a native reparse rejection, observed ${error.nativeCode}`,
        );
        return true;
      },
    );
    assert.equal(readFileSync(realMarker, "utf8"), "old\n");
  });

  await t.test("pre-existing writer sharing conflict fails closed", async () => {
    const f = fixture("writer-conflict");
    const authority = snapshot(prod, f.target);
    const ready = join(f.parent, "writer.ready");
    const holder = spawn(
      process.execPath,
      [join(helpers, "hold-writer.mjs"), f.target, ready],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      await waitFor(() => existsSync(ready));
      assertGuardError(
        () => begin(prod, f.target, Buffer.from("new\n"), authority),
        "TARGET_CHANGED",
      );
      assert.deepEqual(readFileSync(f.target), f.old);
    } finally {
      holder.kill();
      await waitForExit(holder).catch(() => {});
    }
  });

  await t.test(
    "deterministic guard barrier blocks target, stage, and parent attacks through return",
    async () => {
      const f = fixture("guard-barrier");
      const authority = snapshot(prod, f.target);
      const replacementPath = join(f.parent, "replacement.json");
      const replacement = Buffer.from("replacement\n");
      writeFileSync(replacementPath, replacement);
      const run = spawnCommitChild(f.target, replacementPath, authority, "guard", "-");
      try {
        assert.equal(await run.nextLine(), "BARRIER=guard");
        const stageLine = await run.nextLine();
        assert.match(stageLine, /^STAGE_PATH=/);
        const stagePath = stageLine.slice("STAGE_PATH=".length);
        assert.match(await run.nextLine(), /^BACKUP_PATH=/);
        assert.equal(await run.nextLine(), "READY=1");

        assertWriteBlocked(f.target);
        assert.throws(() => renameSync(f.target, f.target + ".renamed"));
        assert.throws(() => unlinkSync(f.target));
        assertWriteBlocked(stagePath);
        assert.throws(() => renameSync(stagePath, stagePath + ".renamed"));
        assert.throws(() => unlinkSync(stagePath));
        assert.throws(() => renameSync(f.parent, f.parent + ".renamed"));
        const parentDelete = native.guardedMarkerAttemptDeleteDirectoryTest(f.parent);
        assert.equal(parentDelete.succeeded, false);
        assert.equal(parentDelete.nativeCode, 32);

        run.child.stdin.write("continue\n");
        const resultLine = await run.nextLine();
        assert.match(resultLine, /^RESULT=/);
        const result = JSON.parse(resultLine.slice("RESULT=".length));
        assert.deepEqual(readFileSync(f.target), replacement);

        assertWriteBlocked(f.target);
        assert.throws(() => renameSync(f.target, f.target + ".after-return"));
        assert.throws(() => unlinkSync(f.target));
        assert.throws(() => renameSync(f.parent, f.parent + ".after-return"));
        const heldParentDelete = native.guardedMarkerAttemptDeleteDirectoryTest(f.parent);
        assert.equal(heldParentDelete.succeeded, false);
        assert.equal(heldParentDelete.nativeCode, 32);

        run.child.stdin.write("ack\n");
        assert.equal(await run.nextLine(), 'ACK={"acknowledged":true}');
        assert.equal(await waitForExit(run.child), 0);
        const published = snapshot(prod, f.target);
        assert.equal(published.sha256, result.sha256);
        assert.equal(published.volumeSerialNumber, result.volumeSerialNumber);
        assert.equal(published.fileIndexHigh, result.fileIndexHigh);
        assert.equal(published.fileIndexLow, result.fileIndexLow);
        writeFileSync(f.target, "released\n");
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill();
          await waitForExit(run.child).catch(() => {});
        }
      }
    },
  );

  await t.test("competitor creation at retire/publish boundary is preserved", async () => {
    const f = fixture("competitor");
    const authority = snapshot(prod, f.target);
    const replacementPath = join(f.parent, "replacement.json");
    writeFileSync(replacementPath, "replacement\n");
    const run = spawnCommitChild(f.target, replacementPath, authority, "retire", "-");
    try {
      assert.equal(await run.nextLine(), "BARRIER=retire");
      const stagePath = (await run.nextLine()).slice("STAGE_PATH=".length);
      const backupPath = (await run.nextLine()).slice("BACKUP_PATH=".length);
      assert.equal(await run.nextLine(), "READY=1");
      assert.equal(existsSync(f.target), false);
      writeFileSync(f.target, "competitor\n");
      run.child.stdin.write("continue\n");
      const errorLine = await run.nextLine();
      assert.match(errorLine, /^ERROR=/);
      const error = JSON.parse(errorLine.slice("ERROR=".length));
      assert.equal(error.code, "TARGET_CHANGED");
      assert.equal(await waitForExit(run.child), 2);
      assert.equal(readFileSync(f.target, "utf8"), "competitor\n");
      assert.deepEqual(readFileSync(backupPath), f.old);
      assert.equal(readFileSync(stagePath, "utf8"), "replacement\n");
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        run.child.kill();
        await waitForExit(run.child).catch(() => {});
      }
    }
  });

  await t.test("duplicate and unknown acknowledge fail closed", () => {
    const f = fixture("ack-errors");
    const authority = snapshot(prod, f.target);
    const result = begin(prod, f.target, Buffer.from("replacement\n"), authority);
    assert.deepEqual(prod.guardedMarkerCommitAcknowledge(result.transactionId), {
      acknowledged: true,
    });
    assertGuardError(
      () => prod.guardedMarkerCommitAcknowledge(result.transactionId),
      "INVALID_ARGUMENT",
    );
    assertGuardError(
      () => prod.guardedMarkerCommitAcknowledge("0".repeat(64)),
      "INVALID_ARGUMENT",
    );
  });

  await t.test("abandoned transaction remains protected for process lifetime", async () => {
    const f = fixture("abandoned");
    const authority = snapshot(prod, f.target);
    const replacementPath = join(f.parent, "replacement.json");
    writeFileSync(replacementPath, "replacement\n");
    const run = spawnCommitChild(f.target, replacementPath, authority);
    try {
      assert.match(await run.nextLine(), /^RESULT=/);
      assertWriteBlocked(f.target);
      assert.throws(() => renameSync(f.parent, f.parent + ".held"));
      assert.equal(run.child.exitCode, null);
      run.child.kill();
      await waitForExit(run.child);
      writeFileSync(f.target, "released-after-process-exit\n");
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        run.child.kill();
        await waitForExit(run.child).catch(() => {});
      }
    }
  });

  await t.test("crash after retire leaves explicit recoverable artifacts", async () => {
    const f = fixture("crash-retire");
    const authority = snapshot(prod, f.target);
    const replacementPath = join(f.parent, "replacement.json");
    writeFileSync(replacementPath, "replacement\n");
    const run = spawnCommitChild(f.target, replacementPath, authority, "-", "after-retire");
    const exitCode = await waitForExit(run.child);
    assert.equal(exitCode, 92, run.stderr());
    assert.equal(existsSync(f.target), false);
    const artifacts = guardArtifacts(f.parent);
    assert.equal(artifacts.filter((name) => name.includes("guard-backup")).length, 1);
    assert.equal(artifacts.filter((name) => name.includes("guard-stage")).length, 1);
    const backup = artifacts.find((name) => name.includes("guard-backup"));
    const stage = artifacts.find((name) => name.includes("guard-stage"));
    assert.deepEqual(readFileSync(join(f.parent, backup)), f.old);
    assert.equal(readFileSync(join(f.parent, stage), "utf8"), "replacement\n");
  });

  await t.test("rollback requires accepted forward identity and rejects change", () => {
    const f = fixture("rollback-authority");
    const authority = snapshot(prod, f.target);
    const replacement = Buffer.from("forward\n");
    const forward = begin(prod, f.target, replacement, authority);
    prod.guardedMarkerCommitAcknowledge(forward.transactionId);
    writeFileSync(f.target, "changed-after-forward\n");
    assertGuardError(
      () => begin(prod, f.target, f.old, {
        sha256: forward.sha256,
        volumeSerialNumber: forward.volumeSerialNumber,
        fileIndexHigh: forward.fileIndexHigh,
        fileIndexLow: forward.fileIndexLow,
      }),
      "TARGET_CHANGED",
    );
    assert.equal(readFileSync(f.target, "utf8"), "changed-after-forward\n");
  });
});
