import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  computeAuthorizedSearchRoots,
  findRipgrepPath,
  searchCodebase,
} from "../../src/engine/ripgrep.js";
import {
  canonicalizeExistingAwarePath,
  isInsideOrEqualPrecomputed,
  normalizePathForCompare,
  type ProtectedPathRule,
} from "../../src/permissions/folder-access.js";

const SENTINEL = "R2_CARVING_SENTINEL_20261009";

function cmp(p: string): string {
  return normalizePathForCompare(canonicalizeExistingAwarePath(p));
}

/** No carved root may contain-or-equal any protected path. */
function assertNoProtectedLeak(roots: string[], protectedPaths: string[]): void {
  for (const root of roots) {
    const rootCmp = cmp(root);
    for (const p of protectedPaths) {
      assert.strictEqual(
        isInsideOrEqualPrecomputed(rootCmp, cmp(p)),
        false,
        `carved root ${root} contains protected path ${p}`
      );
    }
  }
}

function treeRule(p: string): ProtectedPathRule {
  return { path: p, kind: "tree", label: "synthetic-tree" };
}
function fileRule(p: string): ProtectedPathRule {
  return { path: p, kind: "file", label: "synthetic-file" };
}

describe("computeAuthorizedSearchRoots unit carving", () => {
  it("fast path: no intersecting rule returns the target unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-fast-"));
    try {
      const target = path.join(root, "target");
      await fs.mkdir(target, { recursive: true });
      const roots = computeAuthorizedSearchRoots(target, [
        treeRule(path.join(root, "elsewhere")),
      ]);
      assert.deepStrictEqual(roots, [target]);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("protected file under target root is carved; siblings kept", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-file-"));
    try {
      const target = path.join(root, "target");
      const sub = path.join(target, "sub");
      await fs.mkdir(sub, { recursive: true });
      const protectedFile = path.join(target, "secret.txt");
      const sibling = path.join(target, "ok.txt");
      const nested = path.join(sub, "n.txt");
      await fs.writeFile(protectedFile, "x", "utf8");
      await fs.writeFile(sibling, "x", "utf8");
      await fs.writeFile(nested, "x", "utf8");

      const roots = computeAuthorizedSearchRoots(target, [fileRule(protectedFile)]);
      assertNoProtectedLeak(roots, [protectedFile]);
      const resolved = roots.map((r) => path.resolve(r));
      assert.ok(resolved.includes(path.resolve(sibling)), "sibling file kept");
      assert.ok(!resolved.includes(path.resolve(protectedFile)), "protected file excluded");
      // Clean subdir offered whole.
      assert.ok(resolved.includes(path.resolve(sub)), "clean subdir offered whole");
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("protected tree descendant excluded; secret content never offered", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-tree-"));
    try {
      const target = path.join(root, "target");
      const tree = path.join(target, "protected-tree");
      const deep = path.join(tree, "deep", "deeper");
      await fs.mkdir(deep, { recursive: true });
      const secret = path.join(deep, "confidential.txt");
      await fs.writeFile(secret, `TOP SECRET ${SENTINEL}`, "utf8");
      const pub = path.join(target, "public.txt");
      await fs.writeFile(pub, "x", "utf8");

      const roots = computeAuthorizedSearchRoots(target, [treeRule(tree)]);
      assertNoProtectedLeak(roots, [tree, secret]);
      assert.ok(roots.map((r) => path.resolve(r)).includes(path.resolve(pub)));
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("nested denied directory carved along the chain only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-nest-"));
    try {
      const target = path.join(root, "target");
      const a = path.join(target, "a");
      const denied = path.join(a, "denied");
      const b = path.join(a, "b");
      await fs.mkdir(denied, { recursive: true });
      await fs.mkdir(b, { recursive: true });
      await fs.writeFile(path.join(a, "top.txt"), "x", "utf8");
      await fs.writeFile(path.join(denied, "s.txt"), "x", "utf8");
      await fs.writeFile(path.join(b, "ok.txt"), "x", "utf8");

      const roots = computeAuthorizedSearchRoots(target, [treeRule(denied)]);
      assertNoProtectedLeak(roots, [denied]);
      const resolved = roots.map((r) => path.resolve(r));
      // a/ was carved (it contains the denied dir): its clean children offered.
      assert.ok(!resolved.includes(path.resolve(a)), "tainted dir not offered whole");
      assert.ok(resolved.includes(path.resolve(b)), "clean sibling dir offered");
      assert.ok(resolved.includes(path.resolve(path.join(a, "top.txt"))), "clean sibling file offered");
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("symlink alias into protected tree is never offered", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-link-"));
    try {
      const target = path.join(root, "target");
      await fs.mkdir(target, { recursive: true });
      // Protected tree INSIDE the target so the rule intersects the domain;
      // the alias points back into it (the canonical-alias bypass scenario).
      const secretTree = path.join(target, "secret-tree");
      await fs.mkdir(secretTree, { recursive: true });
      await fs.writeFile(path.join(secretTree, "s.txt"), `TOP SECRET ${SENTINEL}`, "utf8");
      const alias = path.join(target, "alias");
      try {
        await fs.symlink(secretTree, alias, "junction");
      } catch {
        console.warn("SKIP: cannot create junction on this platform");
        return;
      }
      const real = path.join(target, "real.txt");
      await fs.writeFile(real, "x", "utf8");

      const roots = computeAuthorizedSearchRoots(target, [treeRule(secretTree)]);
      assertNoProtectedLeak(roots, [secretTree]);
      const resolved = roots.map((r) => path.resolve(r));
      assert.ok(!resolved.includes(path.resolve(alias)), "alias never offered");
      assert.ok(
        !resolved.includes(path.resolve(path.join(secretTree, "s.txt"))),
        "protected content never offered"
      );
      assert.ok(resolved.includes(path.resolve(real)), "ordinary file kept");
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("allowed symlink is skipped but its target file is still searched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-oklink-"));
    try {
      const target = path.join(root, "target");
      await fs.mkdir(target, { recursive: true });
      const real = path.join(target, "real.txt");
      await fs.writeFile(real, "x", "utf8");
      const link = path.join(target, "link.txt");
      try {
        await fs.symlink(real, link, "file");
      } catch {
        console.warn("SKIP: cannot create file symlink on this platform");
        return;
      }
      const roots = computeAuthorizedSearchRoots(target, []);
      const resolved = roots.map((r) => path.resolve(r));
      assert.ok(resolved.includes(path.resolve(real)), "target file offered");
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("nonexistent denied path is ignored safely", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-noent-"));
    try {
      const target = path.join(root, "target");
      await fs.mkdir(target, { recursive: true });
      const ghost = path.join(target, "ghost-dir");
      const keep = path.join(target, "keep.txt");
      await fs.writeFile(keep, "x", "utf8");
      const roots = computeAuthorizedSearchRoots(target, [treeRule(ghost)]);
      assertNoProtectedLeak(roots, [ghost]);
      assert.ok(roots.map((r) => path.resolve(r)).includes(path.resolve(keep)));
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("malformed rule kind fails closed during carving", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-badkind-"));
    try {
      const target = path.join(root, "target");
      await fs.mkdir(target, { recursive: true });
      assert.throws(
        () =>
          computeAuthorizedSearchRoots(target, [
            { path: target, kind: "bogus" } as unknown as ProtectedPathRule,
          ]),
        /kind/i
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("target itself protected throws fail-closed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-self-"));
    try {
      const target = path.join(root, "target");
      await fs.mkdir(target, { recursive: true });
      assert.throws(
        () => computeAuthorizedSearchRoots(target, [treeRule(target)]),
        /failing closed/i
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("filePattern filters carved file roots target-relative", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-carve-pat-"));
    try {
      const target = path.join(root, "target");
      const sub = path.join(target, "sub");
      await fs.mkdir(sub, { recursive: true });
      const secret = path.join(target, "secret.txt");
      await fs.writeFile(secret, "x", "utf8");
      const a = path.join(target, "a.txt");
      const b = path.join(target, "b.md");
      const c = path.join(sub, "c.txt");
      await fs.writeFile(a, "x", "utf8");
      await fs.writeFile(b, "x", "utf8");
      await fs.writeFile(c, "x", "utf8");

      const roots = computeAuthorizedSearchRoots(target, [fileRule(secret)], {
        filePattern: "*.txt",
      });
      const resolved = roots.map((r) => path.resolve(r));
      assert.ok(resolved.includes(path.resolve(a)), "*.txt keeps a.txt");
      assert.ok(resolved.includes(path.resolve(c)), "*.txt keeps sub/c.txt");
      assert.ok(!resolved.includes(path.resolve(b)), "*.txt drops b.md");
      assert.ok(!resolved.includes(path.resolve(secret)), "protected file excluded");
      // With a pattern active, clean dirs explode to file roots (uniform semantics).
      assert.ok(!resolved.includes(path.resolve(sub)), "subdir exploded under filePattern");
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("searchCodebase S1 integration (real rg)", () => {
  async function withProtectedFixture(
    fn: (h: { allowedRoot: string; configFile: string }) => Promise<void>
  ): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r2-int-"));
    try {
      const allowedRoot = path.join(tempRoot, "allowed-root");
      await fs.mkdir(allowedRoot, { recursive: true });
      const configFile = path.join(allowedRoot, "winhelm.config.json");
      const payload = {
        schemaVersion: 2,
        folders: [{ path: allowedRoot, alias: "allowed-root", permission: "readwrite" }],
        terminal: { mode: "off" },
        toolPolicy: { file_search_ripgrep: "auto" },
        secretSentinel: `PROTECTED_LEAK: ${SENTINEL}`,
      };
      await fs.writeFile(configFile, JSON.stringify(payload, null, 2), "utf8");
      const manager = ConfigManager.resetInstance(configFile);
      await manager.init(configFile);
      assert.strictEqual(manager.checkPathAccess(configFile, "read").allowed, false);
      await fn({ allowedRoot, configFile });
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  it("filePattern still filters with protected content carved (real rg)", async () => {
    if (!findRipgrepPath()) return;
    await withProtectedFixture(async ({ allowedRoot, configFile }) => {
      const a = path.join(allowedRoot, "a.txt");
      const b = path.join(allowedRoot, "b.md");
      await fs.writeFile(a, `one ${SENTINEL}\n`, "utf8");
      await fs.writeFile(b, `two ${SENTINEL}\n`, "utf8");
      const res = await searchCodebase({ query: SENTINEL, searchPath: allowedRoot, filePattern: "*.txt" });
      assert.strictEqual(res.engine, "ripgrep");
      const files = res.matches.map((m) => path.resolve(m.file));
      assert.ok(files.includes(path.resolve(a)), "a.txt found");
      assert.ok(!files.includes(path.resolve(b)), "b.md excluded by pattern");
      assert.ok(!files.includes(path.resolve(configFile)), "protected file excluded");
    });
  });

  it("regex vs fixed-string semantics preserved (real rg)", async () => {
    if (!findRipgrepPath()) return;
    await withProtectedFixture(async ({ allowedRoot }) => {
      await fs.writeFile(path.join(allowedRoot, "r.txt"), "abc\n", "utf8");
      await fs.writeFile(path.join(allowedRoot, "f.txt"), "a.c\n", "utf8");
      const re = await searchCodebase({ query: "a.c", searchPath: allowedRoot, isRegex: true });
      assert.ok(re.matches.length >= 2, "regex a.c matches abc and a.c");
      const fixed = await searchCodebase({ query: "a.c", searchPath: allowedRoot, isRegex: false });
      const fixedFiles = fixed.matches.map((m) => path.basename(m.file));
      assert.ok(fixedFiles.includes("f.txt"), "fixed-string finds literal a.c");
      assert.ok(!fixedFiles.includes("r.txt"), "fixed-string does not treat . as wildcard");
    });
  });

  it("pagination/count deterministic and excludes protected content (real rg)", async () => {
    if (!findRipgrepPath()) return;
    await withProtectedFixture(async ({ allowedRoot, configFile }) => {
      const N = 60;
      for (let i = 0; i < N; i++) {
        await fs.writeFile(path.join(allowedRoot, `f${String(i).padStart(3, "0")}.txt`), `line ${SENTINEL} ${i}\n`, "utf8");
      }
      const p1 = await searchCodebase({ query: SENTINEL, searchPath: allowedRoot, page: 1, pageSize: 50 });
      assert.strictEqual(p1.totalMatches, N);
      assert.strictEqual(p1.matches.length, 50);
      assert.strictEqual(p1.hasMore, true);
      const p2 = await searchCodebase({ query: SENTINEL, searchPath: allowedRoot, page: 2, pageSize: 50 });
      assert.strictEqual(p2.matches.length, 10);
      assert.strictEqual(p2.hasMore, false);
      // Deterministic (file, line, column) ordering across pages.
      const names1 = p1.matches.map((m) => m.file.toLowerCase());
      const names2 = p2.matches.map((m) => m.file.toLowerCase());
      const all = [...names1, ...names2];
      const sorted = [...all].sort();
      assert.deepStrictEqual(all, sorted, "matches must be in deterministic file order");
      for (const m of [...p1.matches, ...p2.matches]) {
        assert.ok(!m.text.includes("PROTECTED_LEAK"));
      }
      assert.ok(!all.some((f) => path.resolve(f) === path.resolve(configFile)));
    });
  });

  it("error path does not reveal protected filename or content", async () => {
    if (!findRipgrepPath()) return;
    await withProtectedFixture(async ({ allowedRoot, configFile }) => {
      // Ensure at least one authorized root so the rg batch actually runs.
      await fs.writeFile(path.join(allowedRoot, "trigger.txt"), `x ${SENTINEL}\n`, "utf8");
      const secretName = path.basename(configFile);
      try {
        await searchCodebase(
          { query: SENTINEL, searchPath: allowedRoot },
          {
            execRg: async () => {
              const err = new Error("simulated rg failure: exit code 2") as Error & { code: number };
              err.code = 2;
              throw err;
            },
          }
        );
        assert.fail("expected searchCodebase to throw");
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        assert.ok(msg.includes("Ripgrep search failed"), "error surfaced as search failure");
        assert.ok(!msg.includes(secretName), "error must not reveal protected filename");
        assert.ok(!msg.includes("PROTECTED_LEAK"), "error must not reveal protected content");
      }
    });
  });

  it("batches bounded argv and merges deterministically", async () => {
    if (!findRipgrepPath()) return;
    await withProtectedFixture(async ({ allowedRoot, configFile }) => {
      const N = 250;
      for (let i = 0; i < N; i++) {
        await fs.writeFile(
          path.join(allowedRoot, `batch-${String(i).padStart(3, "0")}.txt`),
          `m ${SENTINEL}\n`,
          "utf8"
        );
      }
      const invocations: string[][] = [];
      const res = await searchCodebase(
        { query: SENTINEL, searchPath: allowedRoot, pageSize: 200 },
        {
          execRg: async (_rgPath, args) => {
            invocations.push(args);
            const roots = args.slice(args.indexOf("--") + 2);
            // No batch may offer the protected config file.
            for (const r of roots) {
              assert.ok(
                path.resolve(r) !== path.resolve(configFile),
                "batch must not contain the protected file"
              );
            }
            const lines = roots.map((r) => `${r}:1:1:m ${SENTINEL}\n`).join("");
            return { stdout: lines };
          },
        }
      );
      assert.ok(invocations.length >= 2, `expected multiple batches, got ${invocations.length}`);
      for (const argv of invocations) {
        assert.ok(
          argv.join(" ").length <= 24000,
          "each batch argv stays within the conservative bound"
        );
      }
      assert.strictEqual(res.totalMatches, N);
      assert.strictEqual(res.matches.length, 200);
      assert.strictEqual(res.hasMore, true);
      const names = res.matches.map((m) => m.file.toLowerCase());
      assert.deepStrictEqual(names, [...names].sort(), "merged matches deterministically ordered");
    });
  });

  it("contextLines hydration never re-opens protected files", async () => {
    if (!findRipgrepPath()) return;
    await withProtectedFixture(async ({ allowedRoot, configFile }) => {
      const ok = path.join(allowedRoot, "ok.txt");
      await fs.writeFile(ok, `l1\nl2 ${SENTINEL}\nl3\nl4\nl5\n`, "utf8");
      const res = await searchCodebase({ query: SENTINEL, searchPath: allowedRoot, contextLines: 2 });
      const files = res.matches.map((m) => path.resolve(m.file));
      assert.ok(files.includes(path.resolve(ok)));
      assert.ok(!files.includes(path.resolve(configFile)));
      const m = res.matches.find((x) => path.resolve(x.file) === path.resolve(ok));
      assert.ok(m?.contextBefore?.length === 1 && m?.contextAfter?.length === 2, "context hydrated for allowed file");
      for (const x of res.matches) {
        for (const c of [...(x.contextBefore ?? []), ...(x.contextAfter ?? [])]) {
          assert.ok(!c.text.includes("PROTECTED_LEAK"));
        }
      }
    });
  });
});
