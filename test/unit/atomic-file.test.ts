import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, symlinkSync } from "node:fs";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import {
  createFileExclusive,
  writeFileAtomic,
} from "../../src/engine/atomic-file.js";
import {
  appendFileProvenanceRecord,
  lookupFileProvenance,
  resetFileProvenanceStore,
  setFileProvenanceStoreForTesting,
} from "../../src/approval/file-provenance.js";
import { StructuredToolError } from "../../src/errors/tool-error.js";
import { trustedNativeAddonPath } from "../../src/native/boundary.js";

let fixtureRoot: string | null = null;
let provenanceStore: string | null = null;

async function makeFixture(): Promise<string> {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a2-atomic-"));
  provenanceStore = path.join(fixtureRoot, "provenance.jsonl");
  setFileProvenanceStoreForTesting(provenanceStore);
  resetFileProvenanceStore();
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
  resetFileProvenanceStore();
  setFileProvenanceStoreForTesting(undefined);
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    fixtureRoot = null;
    provenanceStore = null;
  }
});

const SESSION = "test-session-a2";

function sha256Of(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("A2 file_create_exclusive", () => {
  it("creates a new file with exact CREATE_NEW semantics", async () => {
    const root = await makeFixture();
    const target = path.join(root, "evidence.json");
    const content = '{"gate":"01"}\n';

    const result = await createFileExclusive(
      { path: target, content },
      SESSION
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.created, true);
    assert.strictEqual(result.overwritten, false);
    assert.strictEqual(result.flushed, true);
    assert.strictEqual(result.sha256, sha256Of(content));
    assert.strictEqual(await fs.readFile(target, "utf8"), content);
  });

  it("never overwrites an existing target (FILE_ALREADY_EXISTS)", async () => {
    const root = await makeFixture();
    const target = path.join(root, "existing.txt");
    const original = "do-not-lose-me";
    await fs.writeFile(target, original, "utf8");

    await assert.rejects(
      createFileExclusive({ path: target, content: "replacement" }, SESSION),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "FILE_ALREADY_EXISTS");
        return true;
      }
    );
    assert.strictEqual(await fs.readFile(target, "utf8"), original);
  });
});

describe("A2 file_write_atomic", () => {
  it("creates and then atomically overwrites with full content", async function () {
    if (!existsSync(trustedNativeAddonPath())) {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const target = path.join(root, "atomic.txt");

    const first = await writeFileAtomic(
      { path: target, content: "first\n" },
      SESSION
    );
    assert.strictEqual(first.created, true);
    assert.strictEqual(first.overwritten, false);
    assert.strictEqual(first.ends_with_newline, true);

    const second = await writeFileAtomic(
      { path: target, content: "second-version\n", expected_current_sha256: first.sha256 },
      SESSION
    );
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.overwritten, true);
    assert.strictEqual(await fs.readFile(target, "utf8"), "second-version\n");
  });

  it("cancels with PRECONDITION_FAILED/TARGET_CHANGED and leaves the target untouched", async () => {
    const root = await makeFixture();
    const target = path.join(root, "guarded.txt");
    const original = "original-content";
    await fs.writeFile(target, original, "utf8");

    await assert.rejects(
      writeFileAtomic(
        {
          path: target,
          content: "should-not-land",
          expected_current_sha256: sha256Of("stale-expectation"),
        },
        SESSION
      ),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "PRECONDITION_FAILED");
        assert.strictEqual((err.details as any)?.reason, "TARGET_CHANGED");
        assert.strictEqual(
          (err.details as any)?.expected_sha256,
          sha256Of("stale-expectation")
        );
        assert.strictEqual((err.details as any)?.actual_sha256, sha256Of(original));
        return true;
      }
    );
    assert.strictEqual(await fs.readFile(target, "utf8"), original);
  });

  it("fails expected_absent on an existing target with TARGET_EXISTS", async () => {
    const root = await makeFixture();
    const target = path.join(root, "present.txt");
    await fs.writeFile(target, "already-here", "utf8");

    await assert.rejects(
      writeFileAtomic(
        { path: target, content: "x", expected_absent: true },
        SESSION
      ),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "PRECONDITION_FAILED");
        assert.strictEqual((err.details as any)?.reason, "TARGET_EXISTS");
        return true;
      }
    );
    assert.strictEqual(await fs.readFile(target, "utf8"), "already-here");
  });

  it("routes expected_absent creation through exact CREATE_NEW", async function () {
    if (!existsSync(trustedNativeAddonPath())) {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const target = path.join(root, "absent.txt");

    const result = await writeFileAtomic(
      { path: target, content: "fresh\n", expected_absent: true },
      SESSION
    );
    assert.strictEqual(result.created, true);
    assert.strictEqual(await fs.readFile(target, "utf8"), "fresh\n");

    await assert.rejects(
      writeFileAtomic(
        { path: target, content: "other\n", expected_absent: true },
        SESSION
      ),
      (err: unknown) =>
        err instanceof StructuredToolError &&
        (err.code === "PRECONDITION_FAILED" || err.code === "FILE_ALREADY_EXISTS")
    );
  });

  it("denies mutation through a junction with REPARSE_TRAVERSAL_DENIED", async () => {
    const root = await makeFixture();
    const realDir = path.join(root, "real");
    await fs.mkdir(realDir);
    const junction = path.join(root, "junction");
    symlinkSync(realDir, junction, "junction");
    const target = path.join(junction, "through-link.txt");

    for (const invoke of [
      () => writeFileAtomic({ path: target, content: "x" }, SESSION),
      () => createFileExclusive({ path: target, content: "x" }, SESSION),
    ]) {
      await assert.rejects(invoke, (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "REPARSE_TRAVERSAL_DENIED");
        return true;
      });
    }
    assert.strictEqual(existsSync(target), false);
  });

  it("applies newline normalization, final newline, and BOM handling", async () => {
    const root = await makeFixture();
    const target = path.join(root, "newlines.txt");

    const lf = await writeFileAtomic(
      { path: target, content: "a\r\nb\rc\n" },
      SESSION
    );
    assert.strictEqual(await fs.readFile(target, "utf8"), "a\nb\nc\n");
    assert.strictEqual(lf.cr_count, 0);

    const crlf = await writeFileAtomic(
      { path: target, content: "a\nb\nc\n", newline: "crlf" },
      SESSION
    );
    assert.strictEqual(await fs.readFile(target, "utf8"), "a\r\nb\r\nc\r\n");
    assert.strictEqual(crlf.cr_count, 3);
    assert.strictEqual(crlf.ends_with_newline, true);

    const withBom = await writeFileAtomic(
      { path: target, content: "bom-body\n", bom: true },
      SESSION
    );
    const bomRaw = await fs.readFile(target, "utf8");
    assert.ok(bomRaw.startsWith("\uFEFF"));
    assert.strictEqual(withBom.bytes_written, Buffer.byteLength("\uFEFFbom-body\n", "utf8"));

    await writeFileAtomic({ path: target, content: "\uFEFFstrip-me\n" }, SESSION);
    assert.strictEqual(await fs.readFile(target, "utf8"), "strip-me\n");
  });

  it("writes base64 content verbatim without text transforms", async () => {
    const root = await makeFixture();
    const target = path.join(root, "payload.bin");
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x0d, 0x0a]);

    const result = await writeFileAtomic(
      {
        path: target,
        content: payload.toString("base64"),
        encoding: "base64",
        newline: "crlf",
      },
      SESSION
    );
    assert.deepStrictEqual(await fs.readFile(target), payload);
    assert.strictEqual(result.bytes_written, payload.length);
  });

  it("serializes concurrent same-path mutations and lands one complete content", async function () {
    if (!existsSync(trustedNativeAddonPath())) {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const target = path.join(root, "raced.txt");

    const runs = await Promise.all([
      writeFileAtomic({ path: target, content: "AAA\n" }, "session-race-1"),
      writeFileAtomic({ path: target, content: "BBB\n" }, "session-race-2"),
      writeFileAtomic({ path: target, content: "CCC\n" }, "session-race-3"),
    ]);

    const finalContent = await fs.readFile(target, "utf8");
    assert.ok(["AAA\n", "BBB\n", "CCC\n"].includes(finalContent));
    const winner = runs.find((run) => run.sha256 === sha256Of(finalContent));
    assert.ok(winner, "final on-disk content must match one recorded mutation result");
  });

  it("records provenance only after the governed outcome", async function () {
    if (!existsSync(trustedNativeAddonPath())) {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const target = path.join(root, "journaled.txt");

    await writeFileAtomic({ path: target, content: "v1\n" }, SESSION);
    await writeFileAtomic({ path: target, content: "v2\n" }, SESSION);
    await createFileExclusive({ path: path.join(root, "evidence.txt"), content: "e" }, SESSION);

    const history = await lookupFileProvenance(target);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].action, "create");
    assert.strictEqual(history[0].before_sha256, null);
    assert.strictEqual(history[0].after_sha256, sha256Of("v1\n"));
    assert.strictEqual(history[1].action, "modify");
    assert.strictEqual(history[1].before_sha256, sha256Of("v1\n"));
    assert.strictEqual(history[1].after_sha256, sha256Of("v2\n"));
    assert.strictEqual(history[1].session_id, SESSION);
    assert.strictEqual(history[1].operator, "AI_AGENT");

    await assert.rejects(
      writeFileAtomic(
        { path: target, content: "v3\n", expected_current_sha256: "bogus" },
        SESSION
      )
    );
    const afterFailure = await lookupFileProvenance(target);
    assert.strictEqual(afterFailure.length, 2, "failed mutations are never journaled");
  });

  it("denies writes outside allowed folders and to protected paths", async () => {
    const root = await makeFixture();
    const outside = path.join(path.dirname(root), "outside-atomic.txt");

    await assert.rejects(
      writeFileAtomic({ path: outside, content: "x" }, SESSION),
      (err: unknown) => err instanceof StructuredToolError
    );

    const configFilePath = ConfigManager.getInstance().getConfigFilePath();
    await assert.rejects(
      writeFileAtomic({ path: configFilePath, content: "x" }, SESSION),
      (err: unknown) => {
        if (!(err instanceof StructuredToolError)) return false;
        assert.strictEqual(err.code, "FOLDER_PROTECTED_PATH");
        return true;
      }
    );
  });

  it("keeps per-path history isolated in the path-scoped projection", async () => {
    const root = await makeFixture();
    const other = path.join(root, "other.txt");
    await appendFileProvenanceRecord({
      session_id: "other-session",
      tool: "file_write_atomic",
      action: "modify",
      path: other,
      before_sha256: null,
      after_sha256: "a".repeat(64),
      operator: "AI_AGENT",
    });

    const unrelated = await lookupFileProvenance(path.join(root, "unrelated.txt"));
    assert.deepStrictEqual(unrelated, []);

    const capped = await lookupFileProvenance(other, undefined, 0);
    assert.deepStrictEqual(capped, []);
  });
});
