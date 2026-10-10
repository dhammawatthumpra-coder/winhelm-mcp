import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  findRipgrepPath,
  searchCodebase,
} from "../../src/engine/ripgrep.js";
import {
  canonicalizeExistingAwarePath,
  isInsideOrEqualPrecomputed,
  normalizePathForCompare,
} from "../../src/permissions/folder-access.js";

const SENTINEL = "R2_PREEXCLUSION_SENTINEL_20261009";

interface Harness {
  tempRoot: string;
  allowedRoot: string;
  configFile: string;
  ordinaryFile: string;
}

async function withSearchFixture(
  fn: (h: Harness) => Promise<void>
): Promise<void> {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "winhelm-r2-preexcl-")
  );
  try {
    const allowedRoot = path.join(tempRoot, "allowed-root");
    await fs.mkdir(allowedRoot, { recursive: true });
    const configFile = path.join(allowedRoot, "winhelm.config.json");
    const ordinaryFile = path.join(allowedRoot, "app.ts");
    await fs.writeFile(
      ordinaryFile,
      `// app\nexport const token = "${SENTINEL}";\n`,
      "utf8"
    );
    const configPayload = {
      schemaVersion: 2,
      folders: [
        { path: allowedRoot, alias: "allowed-root", permission: "readwrite" },
      ],
      terminal: { mode: "off" },
      toolPolicy: {
        file_search: "auto",
        file_search_ripgrep: "auto",
        winhelm_status: "auto",
      },
      secretSentinel: `PROTECTED_CONFIG_LEAK: ${SENTINEL}`,
    };
    await fs.writeFile(configFile, JSON.stringify(configPayload, null, 2), "utf8");
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    assert.strictEqual(
      manager.checkPathAccess(configFile, "read").allowed,
      false,
      "fixture precondition: config file must be protected"
    );
    await fn({ tempRoot, allowedRoot, configFile, ordinaryFile });
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** Split recorded rg argv into the query and the searched path arguments. */
function splitArgv(args: string[]): { query: string; searchPaths: string[] } {
  const sep = args.indexOf("--");
  assert.ok(sep >= 0, "rg argv must contain the -- separator");
  return { query: args[sep + 1], searchPaths: args.slice(sep + 2) };
}

describe("S1 protected ripgrep pre-exclusion (R2)", () => {
  it("rg child process is never offered a search domain containing protected content", async () => {
    if (!findRipgrepPath()) {
      console.warn("SKIP: rg.exe not installed; argv proof requires ripgrep");
      return;
    }
    await withSearchFixture(
      async ({ allowedRoot, ordinaryFile, configFile }) => {
        const manager = ConfigManager.getInstance();
        const recordedArgv: string[][] = [];
        // Canned stdout simulates an UNFILTERED rg scan emitting both the
        // ordinary match and the protected config match.
        const cannedStdout =
          `${ordinaryFile}:2:10:export const token = "${SENTINEL}";\n` +
          `${configFile}:9:20:  "secretSentinel": "PROTECTED_CONFIG_LEAK: ${SENTINEL}",\n`;
        const result = await searchCodebase(
          { query: SENTINEL, searchPath: allowedRoot },
          {
            execRg: async (_rgPath, args) => {
              recordedArgv.push(args);
              return { stdout: cannedStdout };
            },
          }
        );

        assert.strictEqual(recordedArgv.length, 1);
        const { query, searchPaths } = splitArgv(recordedArgv[0]);
        assert.strictEqual(query, SENTINEL);
        assert.ok(
          searchPaths.length >= 1,
          "rg must receive at least one search path"
        );

        const protectedCmp = normalizePathForCompare(
          canonicalizeExistingAwarePath(configFile)
        );
        for (const p of searchPaths) {
          // (B-proof) No search path handed to rg may contain-or-equal
          // protected content. R1 fails here: it hands rg the whole root.
          const pCmp = normalizePathForCompare(
            canonicalizeExistingAwarePath(p)
          );
          assert.strictEqual(
            isInsideOrEqualPrecomputed(pCmp, protectedCmp),
            false,
            `rg was offered a search domain containing protected content: ${p}`
          );
          // Every offered path is itself authorized for read.
          assert.strictEqual(
            manager.checkPathAccess(p, "read").allowed,
            true,
            `rg was offered an unauthorized path: ${p}`
          );
        }

        // Defense-in-depth: post-filter still drops the protected match.
        const matchedFiles = result.matches.map((m) => path.resolve(m.file));
        assert.ok(
          matchedFiles.includes(path.resolve(ordinaryFile)),
          "ordinary match must be returned"
        );
        assert.ok(
          !matchedFiles.includes(path.resolve(configFile)),
          "protected match must not be returned"
        );
        assert.strictEqual(result.totalMatches, result.matches.length);
        for (const m of result.matches) {
          assert.ok(
            !m.text.includes("PROTECTED_CONFIG_LEAK"),
            "match text must not leak protected content"
          );
        }
      }
    );
  });

  it("real rg end-to-end: protected config content never returned, ordinary matches work", async () => {
    if (!findRipgrepPath()) {
      console.warn("SKIP: rg.exe not installed");
      return;
    }
    await withSearchFixture(async ({ allowedRoot, ordinaryFile, configFile }) => {
      const result = await searchCodebase({
        query: SENTINEL,
        searchPath: allowedRoot,
        contextLines: 1,
      });
      assert.strictEqual(result.engine, "ripgrep");
      const matchedFiles = result.matches.map((m) => path.resolve(m.file));
      assert.ok(
        matchedFiles.includes(path.resolve(ordinaryFile)),
        "ordinary file must be found by real rg"
      );
      assert.ok(
        !matchedFiles.includes(path.resolve(configFile)),
        "protected config file must be absent with real rg"
      );
      for (const m of result.matches) {
        assert.ok(!m.text.includes("PROTECTED_CONFIG_LEAK"));
        for (const c of [...(m.contextBefore ?? []), ...(m.contextAfter ?? [])]) {
          assert.ok(!c.text.includes("PROTECTED_CONFIG_LEAK"));
        }
      }
    });
  });
});
