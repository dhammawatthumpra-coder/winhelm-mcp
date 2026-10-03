import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteUtf8 } from "../../src/config/atomic-write.js";
import { ConfigManager } from "../../src/config/config-manager.js";

async function tempFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) =>
    name.includes(".winhelm-") && name.endsWith(".tmp")
  );
}

describe("Atomic config persistence", () => {
  it("creates a new file and leaves no temporary artifact", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-atomic-create-")
    );
    const target = path.join(dir, "config.json");

    try {
      const content = JSON.stringify({ value: 1 }, null, 2);
      const result = await atomicWriteUtf8(target, content);

      assert.strictEqual(result.path, path.resolve(target));
      assert.strictEqual(
        result.bytesWritten,
        Buffer.byteLength(content, "utf8")
      );
      assert.strictEqual(
        await fs.readFile(target, "utf8"),
        content
      );
      assert.deepStrictEqual(await tempFiles(dir), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("atomically replaces an existing file on Windows and leaves no temp file", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-atomic-replace-")
    );
    const target = path.join(dir, "config.json");
    await fs.writeFile(target, '{"old":true}', "utf8");

    try {
      const content = JSON.stringify(
        {
          schemaVersion: 2,
          payload: "x".repeat(256 * 1024),
        },
        null,
        2
      );

      await atomicWriteUtf8(target, content);

      const parsed = JSON.parse(
        await fs.readFile(target, "utf8")
      );
      assert.strictEqual(parsed.schemaVersion, 2);
      assert.strictEqual(parsed.payload.length, 256 * 1024);
      assert.deepStrictEqual(await tempFiles(dir), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps persisted and in-memory config unchanged when serialization fails", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-atomic-config-")
    );
    const target = path.join(dir, "config.json");
    const initial = {
      profile: "core",
      allowedDirectories: [dir],
    };
    await fs.writeFile(
      target,
      JSON.stringify(initial, null, 2),
      "utf8"
    );

    try {
      const manager = ConfigManager.resetInstance(target);
      await manager.init(target);
      const beforeFile = await fs.readFile(target, "utf8");
      const beforeProfile = manager.getConfig().profile;

      const circular: any = {};
      circular.self = circular;

      await assert.rejects(
        () =>
          manager.updateConfig(
            { customTools: circular } as any,
            true
          ),
        /circular|cyclic/i
      );

      assert.strictEqual(
        await fs.readFile(target, "utf8"),
        beforeFile
      );
      assert.strictEqual(
        manager.getConfig().profile,
        beforeProfile
      );
      assert.deepStrictEqual(await tempFiles(dir), []);
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
