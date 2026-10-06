/**
 * Spec 3.4 Tier B targeted tests — structured Git contract.
 *
 * Covers Work Order §11 items 24–37: clean/staged/unstaged/untracked status,
 * spaces and Unicode paths, rename status, diff statistics and bounded
 * chunks, binary safety, repository authorization, non-repository structured
 * errors, shell-injection resistance, and structured (never raw stdout)
 * public results.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  readGitStatusStructured,
  readGitDiffStructured,
  resolveAuthorizedGitRepository,
  parseNumstat,
} from "../../src/engine/git-structured.js";
import { evaluateSchemaV2ToolAccess } from "../../src/permissions/tool-access.js";
import type { SchemaV2PermissionConfig } from "../../src/config/schema-v2.js";

async function git(cwd: string, args: string[]): Promise<string> {
  return execFileSync("git", ["-c", "core.quotepath=false", "-C", cwd, ...args], {
    encoding: "utf8",
  });
}

async function createTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-git-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "tier-b@example.invalid"]);
  await git(dir, ["config", "user.name", "Tier B Tests"]);
  await fs.writeFile(path.join(dir, "a.txt"), "line1\nline2\n", "utf8");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}

async function withRepoConfig(
  repo: string,
  fn: () => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-cfg-"));
  const configFile = path.join(dir, "config.json");
  await fs.writeFile(
    configFile,
    JSON.stringify({
      schemaVersion: 2,
      folders: [{ path: repo, permission: "read" }],
      terminal: { mode: "off" },
      toolPolicy: {},
    }),
    "utf8"
  );
  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    await fn();
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function v2ConfigWithFolders(folders: string[]): SchemaV2PermissionConfig {
  return {
    schemaVersion: 2,
    folders: folders.map((folder) => ({ path: folder, permission: "read" as const })),
    terminal: { mode: "off" },
    toolPolicy: {},
  };
}

test("Tier B structured Git contract", async (t) => {
  await t.test("clean repository status is structured and empty", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        const status = await readGitStatusStructured(repo);
        assert.equal(status.branch, "main");
        assert.equal(status.clean, true);
        assert.deepEqual(status.staged, []);
        assert.deepEqual(status.unstaged_modified, []);
        assert.deepEqual(status.untracked, []);
        assert.deepEqual(status.unmerged, []);
        assert.ok(!("stdout" in status));
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("staged, unstaged, and untracked states are classified", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        await fs.writeFile(path.join(repo, "a.txt"), "line1\nchanged\n", "utf8");
        await fs.writeFile(path.join(repo, "new.txt"), "untracked\n", "utf8");
        await fs.writeFile(path.join(repo, "staged.txt"), "staged\n", "utf8");
        await git(repo, ["add", "staged.txt"]);

        const status = await readGitStatusStructured(repo);
        assert.equal(status.clean, false);
        assert.equal(status.unstaged_modified.length, 1);
        assert.equal(status.unstaged_modified[0].path, "a.txt");
        assert.equal(status.unstaged_modified[0].worktree_status, "M");
        assert.equal(status.untracked.length, 1);
        assert.equal(status.untracked[0].path, "new.txt");
        assert.equal(status.staged.length, 1);
        assert.equal(status.staged[0].path, "staged.txt");
        assert.equal(status.staged[0].index_status, "A");
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("paths containing spaces and Unicode filenames parse exactly", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        await fs.writeFile(
          path.join(repo, "with space.txt"),
          "space file\n",
          "utf8"
        );
        await fs.writeFile(
          path.join(repo, "ไฟล์ภาษาไทย.txt"),
          "thai file\n",
          "utf8"
        );
        await git(repo, ["add", "."]);
        const status = await readGitStatusStructured(repo);
        const stagedPaths = status.staged.map((entry) => entry.path).sort();
        assert.deepEqual(stagedPaths, ["with space.txt", "ไฟล์ภาษาไทย.txt"]);
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("rename status carries the original path", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        await fs.writeFile(path.join(repo, "original.txt"), "content\n", "utf8");
        await git(repo, ["add", "original.txt"]);
        await git(repo, ["commit", "-m", "add original"]);
        await git(repo, ["mv", "original.txt", "renamed.txt"]);

        const status = await readGitStatusStructured(repo);
        assert.equal(status.staged.length, 1);
        assert.equal(status.staged[0].index_status, "R");
        assert.equal(status.staged[0].path, "renamed.txt");
        assert.equal(status.staged[0].orig_path, "original.txt");
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("diff file statistics and bounded chunks are deterministic", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        await fs.writeFile(
          path.join(repo, "a.txt"),
          "line1\nline2-mod\nline3\nline4\n",
          "utf8"
        );
        const first = await readGitDiffStructured({ repo_path: repo });
        const second = await readGitDiffStructured({ repo_path: repo });
        assert.deepEqual(first, second, "repeated reads must be identical");
        assert.equal(first.scope, "unstaged");
        const stat = first.files.find((file) => file.path === "a.txt");
        assert.ok(stat);
        assert.equal(stat.binary, false);
        assert.equal(stat.additions, 3);
        assert.equal(stat.deletions, 1);
        assert.equal(first.total_additions, 3);
        assert.equal(first.total_deletions, 1);
        assert.ok(first.patches);
        const patch = first.patches.find((p) => p.path === "a.txt");
        assert.ok(patch);
        assert.ok(patch.chunks.length > 0);
        for (const chunk of patch.chunks) {
          assert.ok(chunk.old_start >= 0);
          assert.ok(chunk.new_start >= 0);
          assert.ok(chunk.lines.length > 0);
          for (const line of chunk.lines) {
            assert.match(line, /^[ +-\\]/);
          }
        }
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("staged diff scope and max_patch_lines truncation work", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        await fs.writeFile(
          path.join(repo, "a.txt"),
          "one\ntwo\nthree\nfour\nfive\n",
          "utf8"
        );
        await git(repo, ["add", "a.txt"]);

        const staged = await readGitDiffStructured({ repo_path: repo });
        assert.equal(staged.scope, "unstaged");
        assert.equal(staged.files.length, 0, "work tree matches index");

        const stagedDiff = await readGitDiffStructured({ repo_path: repo,
          scope: "staged",
        });
        assert.equal(stagedDiff.files.length, 1);

        const bounded = await readGitDiffStructured({ repo_path: repo,
          scope: "staged",
          max_patch_lines: 2,
        });
        assert.equal(bounded.patch_truncated, true);
        const boundedLines = (bounded.patches ?? [])
          .flatMap((patch) => patch.chunks)
          .reduce((sum, chunk) => sum + chunk.lines.length, 0);
        assert.ok(boundedLines <= 2);
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("binary diffs are reported safely without binary content", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        await fs.writeFile(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]));
        await git(repo, ["add", "blob.bin"]);
        await git(repo, ["commit", "-m", "binary"]);
        await fs.writeFile(
          path.join(repo, "blob.bin"),
          Buffer.from([0, 1, 2, 4, 255, 254])
        );

        const diff = await readGitDiffStructured({ repo_path: repo });
        const stat = diff.files.find((file) => file.path === "blob.bin");
        assert.ok(stat);
        assert.equal(stat.binary, true);
        assert.equal(stat.additions, null);
        assert.equal(stat.deletions, null);
        const patch = (diff.patches ?? []).find((p) => p.path === "blob.bin");
        assert.ok(patch);
        assert.equal(patch.binary, true);
        assert.deepEqual(patch.chunks, []);
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("non-repository paths return a structured error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-nonrepo-"));
    try {
      await withRepoConfig(dir, async () => {
        await assert.rejects(
          () => readGitStatusStructured(dir),
          (err: unknown) =>
            (err as { code?: string }).code === "GIT_NOT_A_REPOSITORY"
        );
        await assert.rejects(
          () => readGitDiffStructured({ repo_path: dir }),
          (err: unknown) =>
            (err as { code?: string }).code === "GIT_NOT_A_REPOSITORY"
        );
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("repository toplevel outside allowed roots is denied", async () => {
    const repo = await createTempRepo();
    const unrelated = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-tier-b-unrelated-")
    );
    try {
      await withRepoConfig(unrelated, async () => {
        await assert.rejects(
          () => readGitStatusStructured(repo),
          (err: unknown) =>
            (err as { code?: string }).code === "GIT_ROOT_NOT_AUTHORIZED"
        );
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(unrelated, { recursive: true, force: true });
    }
  });

  await t.test("wrapper path gate denies unauthorized repo paths before execution", () => {
    const config = v2ConfigWithFolders(["D:\\definitely-not-this-repo"]);
    const result = evaluateSchemaV2ToolAccess(
      "git_status_structured",
      { repo_path: "C:\\Windows" },
      config
    );
    assert.equal(result.decision, "deny");
  });

  await t.test("no shell is used and arguments never become shell text", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        // Paths with shell metacharacters must arrive inert as arguments.
        const tricky = "weird &;\$(calc) %.txt";
        await fs.writeFile(path.join(repo, tricky), "harmless\n", "utf8");
        await git(repo, ["add", "."]);
        const status = await readGitStatusStructured(repo);
        assert.ok(status.staged.some((entry) => entry.path === tricky));

        const enginePath = new URL("../../src/engine/git-structured.ts", import.meta.url);
        const source = await fs.readFile(enginePath, "utf8");
        // Only execFile is used from child_process, and no shell is enabled.
        assert.ok(source.includes('from "node:child_process"'));
        assert.ok(!/[^a-zA-Z.]spawn\s*\(/.test(source), "no spawn shell APIs");
        assert.ok(!/shell:\s*true/.test(source), "shell must never be enabled");
        assert.ok(source.includes("shell: false"));
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("public results are structured data, never raw CLI stdout", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        const status = await readGitStatusStructured(repo);
        const serialized = JSON.stringify(status);
        assert.ok(!serialized.includes("\n# On branch"));
        assert.ok(!("stdout" in status));
        const diff = await readGitDiffStructured({ repo_path: repo, include_patch: false });
        assert.equal(diff.patches, null);
        assert.ok(Array.isArray(diff.files));
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("authorized repository resolution returns the work-tree toplevel", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        const resolved = await resolveAuthorizedGitRepository(repo);
        assert.equal(
          path.resolve(resolved.toplevel).toLowerCase(),
          path.resolve(repo).toLowerCase()
        );
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("staged pure rename (git mv) parses with correct path, old_path, and stats", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        await git(repo, ["mv", "a.txt", "renamed file ไทย.txt"]);
        const first = await readGitDiffStructured({ repo_path: repo, scope: "staged" });
        const second = await readGitDiffStructured({ repo_path: repo, scope: "staged" });
        assert.deepEqual(first, second, "repeated reads must be identical");
        assert.equal(first.files.length, 1, "no phantom empty-path entry");
        const stat = first.files[0];
        assert.equal(stat.path, "renamed file ไทย.txt");
        assert.equal(stat.old_path, "a.txt");
        assert.equal(stat.binary, false);
        assert.equal(stat.additions, 0);
        assert.equal(stat.deletions, 0);
        assert.equal(first.total_additions, 0);
        assert.equal(first.total_deletions, 0);
        const serialized = JSON.stringify(first);
        assert.ok(!serialized.includes("\0"), "no raw numstat -z bytes");
        assert.ok(!("stdout" in first));
        const patch = (first.patches ?? []).find((p) => p.path === "renamed file ไทย.txt");
        assert.ok(patch);
        assert.equal(patch.old_path, "a.txt");
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  await t.test("staged rename with content modification parses correctly", async () => {
    const repo = await createTempRepo();
    try {
      await withRepoConfig(repo, async () => {
        // High similarity so Git still reports a rename (not delete+add).
        await fs.writeFile(
          path.join(repo, "a.txt"),
          "l1\nl2\nl3\nl4\nl5\nl6\n",
          "utf8"
        );
        await git(repo, ["add", "a.txt"]);
        await git(repo, ["commit", "-m", "six lines"]);
        await git(repo, ["mv", "a.txt", "b.txt"]);
        await fs.writeFile(
          path.join(repo, "b.txt"),
          "l1\nl2\nl3\nl4\nl5 changed\nl6\n",
          "utf8"
        );
        await git(repo, ["add", "b.txt"]);

        const diff = await readGitDiffStructured({ repo_path: repo, scope: "staged" });
        assert.equal(diff.files.length, 1);
        const stat = diff.files[0];
        assert.equal(stat.path, "b.txt");
        assert.equal(stat.old_path, "a.txt");
        assert.equal(stat.additions, 1);
        assert.equal(stat.deletions, 1);
        assert.equal(diff.total_additions, 1);
        assert.equal(diff.total_deletions, 1);
        assert.ok(diff.patches);
      });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

test("Tier B git numstat -z rename grammar", async (t) => {
  const parseError = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    assert.fail("expected GIT_DIFF_PARSE_FAILED");
  };

  await t.test("normal non-rename record parses counts and inline path", () => {
    assert.deepEqual(parseNumstat("3\t1\ta.txt\0"), [
      { path: "a.txt", binary: false, additions: 3, deletions: 1 },
    ]);
    assert.deepEqual(parseNumstat("0\t0\tempty.txt\0"), [
      { path: "empty.txt", binary: false, additions: 0, deletions: 0 },
    ]);
  });

  await t.test("normal filename containing tabs is preserved exactly", () => {
    assert.deepEqual(parseNumstat("1\t0\tprefix\tinfix.txt\0"), [
      { path: "prefix\tinfix.txt", binary: false, additions: 1, deletions: 0 },
    ]);
  });

  await t.test("binary record maps '-' counts to null", () => {
    assert.deepEqual(parseNumstat("-\t-\tblob.bin\0"), [
      { path: "blob.bin", binary: true, additions: null, deletions: null },
    ]);
  });

  await t.test("pure rename real grammar: empty inline slot then old/new fields", () => {
    // Exact Git 2.54 staged pure-rename record shape (verified via od -c):
    // 0\t0\t\0base.txt\0renamed file.txt\0
    const files = parseNumstat("0\t0\t\0base.txt\0renamed file.txt\0");
    assert.equal(files.length, 1, "no phantom empty-path entry");
    assert.deepEqual(files, [
      {
        path: "renamed file.txt",
        old_path: "base.txt",
        binary: false,
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  await t.test("rename with content change carries the changed counts", () => {
    const files = parseNumstat("2\t1\t\0old.txt\0new.txt\0");
    assert.deepEqual(files, [
      {
        path: "new.txt",
        old_path: "old.txt",
        binary: false,
        additions: 2,
        deletions: 1,
      },
    ]);
  });

  await t.test("Unicode and spaces in rename paths are preserved", () => {
    const files = parseNumstat("0\t0\t\0base.txt\0renamed ไฟล์ file.txt\0");
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "renamed ไฟล์ file.txt");
    assert.equal(files[0].old_path, "base.txt");
  });

  await t.test("malformed or truncated rename records fail closed", () => {
    const cases = [
      "0\t0\t\0base.txt\0", // missing new-path field
      "0\t0\t\0", // missing both path fields
      "0\t0\t", // empty inline slot with nothing following
      "nonsense-record", // no tab structure at all
    ];
    for (const text of cases) {
      const err = parseError(() => parseNumstat(text)) as { code?: string };
      assert.equal(err.code, "GIT_DIFF_PARSE_FAILED", `input: ${JSON.stringify(text)}`);
    }
  });

  await t.test("mixed records: rename followed by a normal file stays aligned", () => {
    const files = parseNumstat(
      "0\t0\t\0base.txt\0renamed file.txt\0" + "3\t1\tafter.txt\0"
    );
    assert.equal(files.length, 2);
    assert.deepEqual(files[0], {
      path: "renamed file.txt",
      old_path: "base.txt",
      binary: false,
      additions: 0,
      deletions: 0,
    });
    assert.deepEqual(files[1], {
      path: "after.txt",
      binary: false,
      additions: 3,
      deletions: 1,
    });
  });

  await t.test("empty output yields no entries", () => {
    assert.deepEqual(parseNumstat(""), []);
  });
});
