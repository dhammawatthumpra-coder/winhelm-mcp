import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import { inspectFileBatch } from "../../src/engine/file-inspect.js";
import { StructuredToolError } from "../../src/errors/tool-error.js";
import { trustedNativeAddonPath } from "../../src/native/boundary.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const holdWriterHelper = path.resolve(here, "../../native/test/helpers/hold-writer.mjs");

let fixtureRoot: string | null = null;

async function makeFixture(): Promise<string> {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a1-inspect-"));
  const config = buildPresetConfig("balanced", {
    folders: [fixtureRoot],
    approvalMode: "smart",
  });
  const manager = ConfigManager.resetInstance();
  await manager.updateConfig(config as any, false);
  return fixtureRoot;
}

afterEach(async () => {
  ConfigManager.resetInstance();
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    fixtureRoot = null;
  }
});

function requireProductionAddon(): boolean {
  return existsSync(trustedNativeAddonPath());
}

describe("A1 file_inspect_batch", () => {
  it("inspects files in exact input order with metadata and sha256", async () => {
    const root = await makeFixture();
    const alpha = path.join(root, "alpha.txt");
    const beta = path.join(root, "beta.bin");
    const alphaContent = "alpha-content-ภาษาไทย\n";
    const betaContent = Buffer.from([0, 1, 2, 3, 255]);
    await fs.writeFile(alpha, alphaContent, "utf8");
    await fs.writeFile(beta, betaContent);

    const result = await inspectFileBatch({
      paths: [beta, alpha, path.join(root, "missing.txt")],
    });

    assert.strictEqual(result.total_inspected, 3);
    assert.strictEqual(result.items.length, 3);
    assert.strictEqual(result.items[0].path, path.resolve(beta));
    assert.strictEqual(result.items[1].path, path.resolve(alpha));
    assert.strictEqual(result.items[2].path, path.resolve(path.join(root, "missing.txt")));

    assert.strictEqual(result.items[0].exists, true);
    assert.strictEqual(result.items[0].type, "file");
    assert.strictEqual(result.items[0].bytes, betaContent.length);
    assert.strictEqual(
      result.items[0].sha256,
      createHash("sha256").update(betaContent).digest("hex")
    );
    assert.strictEqual(result.items[0].reparse_point, false);

    assert.strictEqual(result.items[1].sha256, createHash("sha256").update(alphaContent, "utf8").digest("hex"));

    assert.strictEqual(result.items[2].exists, false);
    assert.strictEqual(result.items[2].type, "none");
    assert.strictEqual(result.items[2].sha256, null);
    assert.strictEqual(result.items[2].consistency_applied, "none");
  });

  it("supports include-field filtering while keeping stable identity fields", async () => {
    const root = await makeFixture();
    const target = path.join(root, "filter-me.txt");
    await fs.writeFile(target, "filter", "utf8");

    const result = await inspectFileBatch({
      paths: [target],
      include: ["bytes", "sha256"],
    });

    const item = result.items[0];
    assert.strictEqual(item.path, path.resolve(target));
    assert.strictEqual(item.exists, true);
    assert.strictEqual(item.bytes, 6);
    assert.ok(typeof item.sha256 === "string" && item.sha256.length === 64);
    assert.strictEqual(item.type, undefined);
    assert.strictEqual(item.mtime_utc, undefined);
    assert.strictEqual(item.readonly, undefined);
  });

  it("detects changed files under best_effort via stat delta", async () => {
    const root = await makeFixture();
    const target = path.join(root, "changing.txt");
    // A file large enough that the streaming hash is still in flight when
    // the concurrent append lands inside the stat/read/re-stat window.
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const handle = await fs.open(target, "w");
    for (let i = 0; i < 256; i++) {
      await handle.write(chunk);
    }
    await handle.close();

    // Mutate the file concurrently with the inspection by appending while the
    // streaming hash is running.
    const rewrite = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.appendFile(target, "-appended-mid-inspection", "utf8");
    })();

    const result = await inspectFileBatch({ paths: [target], consistency: "best_effort" });
    await rewrite;

    const item = result.items[0];
    assert.strictEqual(item.exists, true);
    assert.strictEqual(item.consistency_applied, "best_effort");
    assert.strictEqual(
      item.changed_during_inspection,
      true,
      "best_effort must flag a file that changed during inspection"
    );
  });

  it("reports directories without hashing them", async () => {
    const root = await makeFixture();
    const dir = path.join(root, "subdir");
    await fs.mkdir(dir);

    const result = await inspectFileBatch({ paths: [dir] });
    const item = result.items[0];
    assert.strictEqual(item.exists, true);
    assert.strictEqual(item.type, "directory");
    assert.strictEqual(item.sha256, null);
    assert.strictEqual(item.consistency_applied, "none");
  });

  it("rejects batches above the 100-path maximum", async () => {
    await makeFixture();
    const tooMany = Array.from({ length: 101 }, (_, i) => `p${i}.txt`);
    await assert.rejects(
      inspectFileBatch({ paths: tooMany }),
      (err: unknown) =>
        err instanceof StructuredToolError &&
        err.code === "INPUT_TOO_LARGE"
    );
  });

  it("fail_fast errors on missing paths instead of returning exists=false", async () => {
    const root = await makeFixture();
    await assert.rejects(
      inspectFileBatch({
        paths: [path.join(root, "nope.txt")],
        fail_fast: true,
      }),
      (err: unknown) =>
        err instanceof StructuredToolError && err.code === "PATH_NOT_FOUND"
    );
  });

  it("denies reads outside configured allowed folders", async () => {
    const root = await makeFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a1-outside-"));
    try {
      await assert.rejects(
        inspectFileBatch({ paths: [path.join(outside, "secret.txt")] }),
        (err: unknown) => err instanceof StructuredToolError
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("reports junction reparse metadata inside allowed folders without traversal", async () => {
    const root = await makeFixture();
    const targetDir = path.join(root, "real-dir");
    await fs.mkdir(targetDir);
    await fs.writeFile(path.join(targetDir, "inner.txt"), "inner", "utf8");
    const junction = path.join(root, "link-dir");
    await fs.symlink(targetDir, junction, "junction");

    const result = await inspectFileBatch({ paths: [junction] });
    const item = result.items[0];
    assert.strictEqual(item.exists, true);
    assert.strictEqual(item.reparse_point, true);
    assert.strictEqual(item.type, "reparse_point");
    assert.strictEqual(item.sha256, null, "reparse points are reported, never traversed for hashing");
  });

  it("refuses a junction that resolves outside the allowed folder", async () => {
    const root = await makeFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a1-outside-"));
    try {
      const escape = path.join(root, "escape-link");
      await fs.symlink(outside, escape, "junction");
      await assert.rejects(
        inspectFileBatch({ paths: [escape] }),
        (err: unknown) => err instanceof StructuredToolError
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("A1 file_inspect_batch deny_writers (native stable read)", () => {
  const nativeReady = requireProductionAddon();

  it("hashes an uncontended file through the native stable-read boundary", async function () {
    if (!nativeReady) {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const target = path.join(root, "stable.txt");
    const content = "stable-content";
    await fs.writeFile(target, content, "utf8");

    const result = await inspectFileBatch({
      paths: [target],
      consistency: "deny_writers",
    });
    const item = result.items[0];
    assert.strictEqual(item.exists, true);
    assert.strictEqual(item.consistency_applied, "deny_writers");
    assert.strictEqual(item.changed_during_inspection, false);
    assert.strictEqual(
      item.sha256,
      createHash("sha256").update(content, "utf8").digest("hex")
    );
  });

  it("maps a concurrent writer to the exact STABLE_READ_UNAVAILABLE error", async function () {
    if (!nativeReady) {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const target = path.join(root, "contended.txt");
    const ready = path.join(root, "writer-ready.flag");
    await fs.writeFile(target, "writer-held\n", "utf8");

    const child = spawn(process.execPath, [holdWriterHelper, target, ready], {
      stdio: "ignore",
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(existsSync(ready), "writer fixture did not become ready");

      await assert.rejects(
        inspectFileBatch({ paths: [target], consistency: "deny_writers" }),
        (err: unknown) => {
          if (!(err instanceof StructuredToolError)) return false;
          assert.strictEqual(err.code, "STABLE_READ_UNAVAILABLE");
          return true;
        }
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});

describe("A1 benchmarks (AC-3.4.1)", () => {
  it("inspects 50 files within the 50 ms metadata benchmark", async function () {
    if (!requireProductionAddon()) {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const files: string[] = [];
    for (let i = 0; i < 50; i++) {
      const target = path.join(root, `bench-${i}.txt`);
      await fs.writeFile(target, `bench-content-${i}\n`, "utf8");
      files.push(target);
    }

    const result = await inspectFileBatch({ paths: files, sha256: false });
    assert.strictEqual(result.total_inspected, 50);
    assert.ok(
      result.elapsed_ms <= 50,
      `50-file metadata benchmark took ${result.elapsed_ms} ms (AC-3.4.1 target: <= 50 ms)`
    );
  });

  it("streams SHA-256 at 100 MB/s or better (AC-3.4.1 hashing benchmark)", async function () {
    if (!requireProductionAddon()) {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const big = path.join(root, "throughput.bin");
    const handle = await fs.open(big, "w");
    for (let i = 0; i < 64; i++) {
      await handle.write(chunk);
    }
    await handle.close();

    const result = await inspectFileBatch({ paths: [big], consistency: "best_effort" });
    const elapsedSeconds = result.elapsed_ms / 1000;
    const throughput = 64 / elapsedSeconds;
    assert.ok(
      throughput >= 100,
      `SHA-256 throughput ${throughput.toFixed(1)} MB/s (AC-3.4.1 target: >= 100 MB/s)`
    );
  });
});

