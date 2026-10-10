import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import { inspectFileBatch } from "../../src/engine/file-inspect.js";
import { trustedNativeAddonPath } from "../../src/native/boundary.js";

let fixtureRoot: string | null = null;

async function makeFixture(): Promise<string> {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a1-inspect-bench-"));
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
    console.log(`[AC-3.4.1 METADATA] 50 files metadata elapsed_ms: ${result.elapsed_ms.toFixed(2)} ms (threshold: <= 50 ms)`);
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
    console.log(`[AC-3.4.1 SHA256] throughput: ${throughput.toFixed(2)} MB/s (threshold: >= 100 MB/s)`);
    assert.ok(
      throughput >= 100,
      `SHA-256 throughput ${throughput.toFixed(1)} MB/s (AC-3.4.1 target: >= 100 MB/s)`
    );
  });
});
