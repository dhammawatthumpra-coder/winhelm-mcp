import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import { compareFiles } from "../../src/engine/file-compare.js";
import {
  buildDirectoryManifest,
  canonicalRootPath,
} from "../../src/engine/directory-manifest.js";
import { StructuredToolError } from "../../src/errors/tool-error.js";

let fixtureRoot: string | null = null;

async function makeFixture(): Promise<string> {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a5-verify-"));
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

function sha256Of(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("A5 file_compare (bytes)", () => {
  it("reports equality with hashes and no difference offset", async () => {
    const root = await makeFixture();
    const a = path.join(root, "a.bin");
    const b = path.join(root, "b.bin");
    await fs.writeFile(a, "identical-content");
    await fs.writeFile(b, "identical-content");

    const result = await compareFiles({ path_a: a, path_b: b, mode: "bytes" });
    assert.strictEqual(result.equal, true);
    assert.strictEqual(result.first_difference_offset, null);
    assert.strictEqual(result.sha256_a, sha256Of("identical-content"));
    assert.strictEqual(result.sha256_a, result.sha256_b);
  });

  it("reports the exact first-difference offset", async () => {
    const root = await makeFixture();
    const a = path.join(root, "a.bin");
    const b = path.join(root, "b.bin");
    await fs.writeFile(a, Buffer.from([1, 2, 3, 4, 5, 6]));
    await fs.writeFile(b, Buffer.from([1, 2, 3, 9, 5, 6]));

    const result = await compareFiles({ path_a: a, path_b: b, mode: "bytes" });
    assert.strictEqual(result.equal, false);
    assert.strictEqual(result.first_difference_offset, 3);
  });

  it("detects prefix and append-only relations", async () => {
    const root = await makeFixture();
    const prefix = path.join(root, "prefix.bin");
    const extended = path.join(root, "extended.bin");
    await fs.writeFile(prefix, "base");
    await fs.writeFile(extended, "base-plus-more");

    const forward = await compareFiles({ path_a: prefix, path_b: extended, mode: "bytes" });
    assert.strictEqual(forward.equal, false);
    assert.strictEqual(forward.is_prefix_match, true);
    assert.strictEqual(forward.is_append_only, true);
    assert.strictEqual(forward.appended_bytes, "base-plus-more".length - "base".length);
    assert.strictEqual(forward.first_difference_offset, null);

    // The reverse direction is a prefix match but not append-only.
    const reverse = await compareFiles({ path_a: extended, path_b: prefix, mode: "bytes" });
    assert.strictEqual(reverse.is_prefix_match, true);
    assert.strictEqual(reverse.is_append_only, false);
    assert.strictEqual(reverse.appended_bytes, null);
  });

  it("denies comparison when a path is outside allowed folders", async () => {
    const root = await makeFixture();
    const inside = path.join(root, "inside.txt");
    await fs.writeFile(inside, "x");
    const outside = path.join(path.dirname(root), "outside-compare.txt");
    await fs.writeFile(outside, "y").catch(() => {});

    await assert.rejects(
      compareFiles({ path_a: inside, path_b: outside, mode: "bytes" }),
      (err: unknown) => err instanceof StructuredToolError
    );
    await fs.rm(outside, { force: true }).catch(() => {});
  });
});

describe("A5 file_compare (text)", () => {
  it("compares text with newline normalization modes", async () => {
    const root = await makeFixture();
    const lf = path.join(root, "lf.txt");
    const crlf = path.join(root, "crlf.txt");
    await fs.writeFile(lf, "line1\nline2\n", "utf8");
    await fs.writeFile(crlf, "line1\r\nline2\r\n", "utf8");

    const strictEqual = await compareFiles({
      path_a: lf,
      path_b: crlf,
      mode: "text",
      newline_normalization: "strict",
    });
    assert.strictEqual(strictEqual.equal, true);

    const none = await compareFiles({ path_a: lf, path_b: crlf, mode: "text" });
    assert.strictEqual(none.equal, false);
    assert.strictEqual(none.first_difference_line, 1);
  });

  it("produces a bounded deterministic unified diff", async () => {
    const root = await makeFixture();
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "one\ntwo\nthree\nfour\nfive\n", "utf8");
    await fs.writeFile(b, "one\ntwo\nTHREE\nfour\nfive\n", "utf8");

    const result = await compareFiles({
      path_a: a,
      path_b: b,
      mode: "text",
      unified_diff: true,
    });
    assert.strictEqual(result.equal, false);
    assert.ok(Array.isArray(result.unified_diff) && result.unified_diff.length > 0);
    const joined = result.unified_diff.join("\n");
    assert.ok(joined.includes("-three"));
    assert.ok(joined.includes("+THREE"));
    assert.strictEqual(result.diff_truncated, false);

    const bounded = await compareFiles({
      path_a: a,
      path_b: b,
      mode: "text",
      unified_diff: true,
      max_diff_lines: 2,
    });
    assert.ok((bounded.unified_diff?.length ?? 0) <= 2);
  });
});

describe("A5 directory_manifest", () => {
  it("is deterministic across repeated runs with UTF-8 byte ordering", async () => {
    const root = await makeFixture();
    await fs.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.writeFile(path.join(root, "b.txt"), "bb\n", "utf8");
    await fs.writeFile(path.join(root, "a.txt"), "aa\n", "utf8");
    await fs.writeFile(path.join(root, "sub", "c.txt"), "cc\n", "utf8");

    const first = await buildDirectoryManifest({ root_path: root });
    const second = await buildDirectoryManifest({ root_path: root });

    assert.strictEqual(first.manifest_sha256, second.manifest_sha256);
    assert.deepStrictEqual(first.entries, second.entries);
    assert.strictEqual(first.total_files, 3);
    assert.strictEqual(first.total_directories, 1);
    assert.strictEqual(first.scope.follow_reparse, false);

    const paths = first.entries.map((entry) => entry.relative_path);
    const expectedOrder = [...paths].sort((x, y) =>
      Buffer.compare(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"))
    );
    assert.deepStrictEqual(paths, expectedOrder);
    assert.ok(paths.includes("sub/c.txt"), "relative paths use forward slashes");
    assert.strictEqual(first.entries.find((e) => e.relative_path === "a.txt")?.sha256, sha256Of("aa\n"));
  });

  it("normalizes the canonical root with uppercase drive and forward slashes", async () => {
    const root = await makeFixture();
    const manifest = await buildDirectoryManifest({ root_path: root });
    assert.match(manifest.root_path, /^[A-Z]:\//);
    assert.ok(!manifest.root_path.endsWith("/"));
    assert.strictEqual(manifest.root_path, canonicalRootPath(root));
    assert.strictEqual(manifest.root_path.includes("\\"), false);
  });

  it("applies lexicographically sorted exclude patterns", async () => {
    const root = await makeFixture();
    await fs.writeFile(path.join(root, "keep.txt"), "k", "utf8");
    await fs.writeFile(path.join(root, "drop.tmp"), "d", "utf8");

    const manifest = await buildDirectoryManifest({
      root_path: root,
      exclude_patterns: ["*.tmp", "*.log"],
    });
    assert.deepStrictEqual(manifest.scope.exclude_patterns, ["*.log", "*.tmp"]);
    assert.deepStrictEqual(
      manifest.entries.map((entry) => entry.relative_path),
      ["keep.txt"]
    );
  });

  it("records reparse points without traversing them", async () => {
    const root = await makeFixture();
    const realDir = path.join(root, "real");
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, "inner.txt"), "inner", "utf8");
    const junction = path.join(root, "link");
    symlinkSync(realDir, junction, "junction");

    const manifest = await buildDirectoryManifest({ root_path: root });
    const reparseEntry = manifest.entries.find((entry) => entry.relative_path === "link");
    assert.ok(reparseEntry);
    assert.strictEqual(reparseEntry?.type, "reparse_point");
    assert.strictEqual(reparseEntry?.reparse, true);
    // The traversal never enters the link, so inner.txt appears only once
    // (through the real directory), never twice through the junction.
    const innerEntries = manifest.entries.filter((entry) =>
      entry.relative_path.endsWith("inner.txt")
    );
    assert.strictEqual(innerEntries.length, 1);
    assert.strictEqual(innerEntries[0].relative_path, "real/inner.txt");
  });

  it("fails closed on an inaccessible entry", async function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const root = await makeFixture();
    const locked = path.join(root, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, "secret.txt"), "s", "utf8");

    // On Windows an unreadable directory is an ACL condition, not a POSIX
    // mode; deny the current user's read/list right explicitly so the walk
    // must fail closed instead of silently skipping the entry.
    const user = process.env.USERNAME;
    if (!user) {
      this.skip();
      return;
    }
    try {
      execFileSync("icacls.exe", [locked, "/deny", `${user}:(RX)`], {
        stdio: "pipe",
      });
    } catch {
      this.skip();
      return;
    }

    try {
      await assert.rejects(
        buildDirectoryManifest({ root_path: root }),
        (err: unknown) =>
          err instanceof StructuredToolError && err.code === "DIRECTORY_READ_FAILED"
      );
    } finally {
      try {
        execFileSync("icacls.exe", [locked, "/remove:d", user], { stdio: "pipe" });
      } catch {
        // Best-effort cleanup; the temp fixture is removed by afterEach.
      }
    }
  });

  it("rejects a non-false follow_reparse and a manifest outside allowed folders", async () => {
    const root = await makeFixture();
    await assert.rejects(
      buildDirectoryManifest({ root_path: root, follow_reparse: true as never }),
      (err: unknown) =>
        err instanceof StructuredToolError && err.code === "PATH_INVALID"
    );

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a5-outside-"));
    try {
      await assert.rejects(
        buildDirectoryManifest({ root_path: outside }),
        (err: unknown) => err instanceof StructuredToolError
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("honors max_depth and hash_files=false", async () => {
    const root = await makeFixture();
    await fs.mkdir(path.join(root, "level1", "level2"), { recursive: true });
    await fs.writeFile(path.join(root, "top.txt"), "t", "utf8");
    await fs.writeFile(path.join(root, "level1", "mid.txt"), "m", "utf8");
    await fs.writeFile(path.join(root, "level1", "level2", "deep.txt"), "d", "utf8");

    const shallow = await buildDirectoryManifest({
      root_path: root,
      max_depth: 1,
      hash_files: false,
    });
    const paths = shallow.entries.map((entry) => entry.relative_path);
    assert.ok(paths.includes("top.txt"));
    assert.ok(paths.includes("level1"));
    assert.ok(paths.includes("level1/mid.txt"));
    assert.ok(!paths.includes("level1/level2/deep.txt"), "max_depth bounds the walk");
    assert.strictEqual(shallow.scope.hash_files, false);
    for (const entry of shallow.entries) {
      if (entry.type === "file") assert.strictEqual(entry.sha256, null);
    }
  });
});