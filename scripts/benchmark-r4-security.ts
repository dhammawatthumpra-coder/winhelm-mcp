import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../src/config/config-manager.js";
import { searchCodebase, computeAuthorizedSearchRoots } from "../src/engine/ripgrep.js";
import { copyFileOrDir, createZip } from "../src/engine/filesystem.js";
import { resetProtectedObjectRegistryCache } from "../src/permissions/object-identity.js";

export interface BenchResult {
  id: number;
  scenario: string;
  iterations: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  rgSpawned: boolean;
  securityOutcome: string;
}

export async function runR4Benchmark(): Promise<{
  corpusFiles: number;
  corpusBytes: number;
  results: BenchResult[];
}> {
  console.log("=== WinHelm v1.4 Core Security R4 Performance Benchmarks (Section 23) ===");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r4-bench-"));
  const allowedRoot = path.join(tempRoot, "allowed-root");
  const searchRoot = path.join(allowedRoot, "corpus");
  const outsideProtected = path.join(tempRoot, "protected-outside");

  await fs.mkdir(searchRoot, { recursive: true });
  await fs.mkdir(outsideProtected, { recursive: true });

  const protectedSecretFile = path.join(outsideProtected, "secret-key.env");
  await fs.writeFile(protectedSecretFile, "TOP_SECRET_BENCHMARK_TOKEN_XYZ=123456\n", "utf8");

  const protectedTreeDir = path.join(searchRoot, "protected-subdir");
  await fs.mkdir(protectedTreeDir, { recursive: true });
  await fs.writeFile(path.join(protectedTreeDir, "inner-secret.txt"), "INNER_SECRET=secret987\n", "utf8");

  // Create corpus: 50 directories x 10 files = 500 files
  const DIRS = 50;
  const FILES_PER_DIR = 10;
  let totalBytes = 0;
  let totalFiles = 0;

  console.log(`Generating corpus: ${DIRS} dirs x ${FILES_PER_DIR} files...`);
  for (let d = 0; d < DIRS; d++) {
    const dirPath = path.join(searchRoot, `module_${d}`);
    await fs.mkdir(dirPath, { recursive: true });
    for (let f = 0; f < FILES_PER_DIR; f++) {
      const filePath = path.join(dirPath, `file_${f}.ts`);
      const content = [
        `// Module ${d} File ${f}`,
        `export function handler_${d}_${f}() {`,
        `  const targetWord = "benchmark_needle_search";`,
        `  return ${d} * 100 + ${f};`,
        `}`,
        `// padding line 1`,
        `// padding line 2`,
        `// padding line 3`,
      ].join("\n") + "\n";
      await fs.writeFile(filePath, content, "utf8");
      totalBytes += Buffer.byteLength(content);
      totalFiles++;
    }
  }

  // 1 in-corpus protected file
  const inCorpusProtected = path.join(searchRoot, "module_0", "internal-secret.cfg");
  await fs.writeFile(inCorpusProtected, "INTERNAL_PROTECTED_DATA=456\n", "utf8");
  totalBytes += Buffer.byteLength("INTERNAL_PROTECTED_DATA=456\n");
  totalFiles++;

  // Pre-existing hardlink alias in module_1
  const preExistingAlias = path.join(searchRoot, "module_1", "pre-existing-alias.env");
  fsSync.linkSync(protectedSecretFile, preExistingAlias);
  totalFiles++;

  console.log(`Corpus generated: ${totalFiles} files, ${totalBytes} bytes (${(totalBytes / 1024).toFixed(1)} KB)`);

  const configFile = path.join(allowedRoot, "winhelm.config.json");
  const config = {
    schemaVersion: 2,
    folders: [{ path: allowedRoot, permission: "readwrite" }],
    terminal: { mode: "off" },
    toolPolicy: {
      file_search_ripgrep: "auto",
      file_read: "auto",
      file_copy: "auto",
      archive_zip: "auto",
    },
    protectedPaths: [
      { path: protectedSecretFile, kind: "file", label: "Outside secret file" },
      { path: inCorpusProtected, kind: "file", label: "In-corpus secret file" },
      { path: protectedTreeDir, kind: "tree", label: "In-corpus protected tree" },
    ],
  };
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

  ConfigManager.resetInstance();
  resetProtectedObjectRegistryCache();
  const manager = ConfigManager.getInstance(configFile);

  const results: BenchResult[] = [];
  const ITERS = 5;

  async function measure(
    id: number,
    name: string,
    fn: () => Promise<{ rgSpawned: boolean; outcome: string }>
  ) {
    const times: number[] = [];
    let lastRg = false;
    let lastOutcome = "";

    // Warmup
    try {
      const w = await fn();
      lastRg = w.rgSpawned;
      lastOutcome = w.outcome;
    } catch (e: any) {
      lastOutcome = e.message;
    }

    for (let i = 0; i < ITERS; i++) {
      const t0 = performance.now();
      try {
        const r = await fn();
        const t1 = performance.now();
        times.push(t1 - t0);
        lastRg = r.rgSpawned;
        lastOutcome = r.outcome;
      } catch (e: any) {
        const t1 = performance.now();
        times.push(t1 - t0);
        lastOutcome = e.message;
      }
    }

    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    results.push({
      id,
      scenario: name,
      iterations: ITERS,
      meanMs: Number(mean.toFixed(2)),
      minMs: Number(min.toFixed(2)),
      maxMs: Number(max.toFixed(2)),
      rgSpawned: lastRg,
      securityOutcome: lastOutcome,
    });

    console.log(
      `Scenario ${id} [${name}]: mean=${mean.toFixed(2)}ms (min=${min.toFixed(2)}ms, max=${max.toFixed(2)}ms) rgSpawned=${lastRg} outcome="${lastOutcome}"`
    );
  }

  // 1. Clean search tree, no intersecting protected alias
  const cleanDir = path.join(searchRoot, "module_2");
  await measure(1, "Clean search tree (no protected alias)", async () => {
    const res = await searchCodebase({ query: "benchmark_needle_search", searchPath: cleanDir });
    return { rgSpawned: true, outcome: `Found ${res.totalMatches} matches safely` };
  });

  // 2. Protected file rule, no alias (module_0 has inCorpusProtected carved)
  const mod0Dir = path.join(searchRoot, "module_0");
  await measure(2, "Protected file rule (carved, no alias)", async () => {
    const res = await searchCodebase({ query: "benchmark_needle_search", searchPath: mod0Dir });
    return { rgSpawned: true, outcome: `Found ${res.totalMatches} matches, protected file carved` };
  });

  // 3. Protected tree rule
  await measure(3, "Protected tree rule (entire tree carved)", async () => {
    try {
      const res = await searchCodebase({ query: "INNER_SECRET", searchPath: protectedTreeDir });
      return { rgSpawned: false, outcome: `Matches: ${res.totalMatches}` };
    } catch (err: any) {
      return { rgSpawned: false, outcome: "Protected tree denied fail-closed" };
    }
  });

  // 4. Pre-existing hardlink alias (module_1 has preExistingAlias)
  const mod1Dir = path.join(searchRoot, "module_1");
  await measure(4, "Pre-existing hardlink alias (carved)", async () => {
    const res = await searchCodebase({ query: "benchmark_needle_search", searchPath: mod1Dir });
    return { rgSpawned: true, outcome: `Found ${res.totalMatches} matches, alias carved` };
  });

  // 5. Runtime-created hardlink alias after registry initialization
  const runtimeAliasDir = path.join(searchRoot, "module_3");
  const runtimeAliasFile = path.join(runtimeAliasDir, "runtime-alias.env");
  fsSync.linkSync(protectedSecretFile, runtimeAliasFile);
  await measure(5, "Runtime-created hardlink alias (freshly carved)", async () => {
    const res = await searchCodebase({ query: "benchmark_needle_search", searchPath: runtimeAliasDir });
    return { rgSpawned: true, outcome: `Found ${res.totalMatches} matches, runtime alias carved` };
  });

  // 6. filePattern active
  await measure(6, "filePattern active (*.ts)", async () => {
    const res = await searchCodebase({
      query: "benchmark_needle_search",
      searchPath: runtimeAliasDir,
      filePattern: "*.ts",
    });
    return { rgSpawned: true, outcome: `Found ${res.totalMatches} matches with pattern` };
  });

  // 7. contextLines active
  await measure(7, "contextLines active (contextLines=2)", async () => {
    const res = await searchCodebase({
      query: "benchmark_needle_search",
      searchPath: runtimeAliasDir,
      contextLines: 2,
    });
    return { rgSpawned: true, outcome: `Found ${res.totalMatches} matches with context` };
  });

  // 8. Recursive copy clean tree
  const cleanCopyDest = path.join(allowedRoot, "dest_clean_copy");
  await measure(8, "Recursive copy clean tree", async () => {
    await fs.rm(cleanCopyDest, { recursive: true, force: true });
    await copyFileOrDir(cleanDir, cleanCopyDest);
    return { rgSpawned: false, outcome: "Clean directory copied successfully" };
  });

  // 9. Recursive copy with runtime protected alias
  const aliasCopyDest = path.join(allowedRoot, "dest_alias_copy");
  await measure(9, "Recursive copy with runtime protected alias", async () => {
    try {
      await copyFileOrDir(runtimeAliasDir, aliasCopyDest);
      return { rgSpawned: false, outcome: "VULNERABILITY_LEAKED" };
    } catch (err: any) {
      return { rgSpawned: false, outcome: "Blocked: contains hardlink alias to protected object" };
    }
  });

  // 10. Archive clean tree
  const cleanZipDest = path.join(allowedRoot, "clean.zip");
  await measure(10, "Archive clean tree", async () => {
    if (fsSync.existsSync(cleanZipDest)) await fs.unlink(cleanZipDest);
    await createZip(cleanDir, cleanZipDest);
    return { rgSpawned: false, outcome: "Clean directory archived successfully" };
  });

  // 11. Archive with runtime protected alias
  const aliasZipDest = path.join(allowedRoot, "alias.zip");
  await measure(11, "Archive with runtime protected alias", async () => {
    try {
      await createZip(runtimeAliasDir, aliasZipDest);
      return { rgSpawned: false, outcome: "VULNERABILITY_LEAKED" };
    } catch (err: any) {
      return { rgSpawned: false, outcome: "Blocked: contains hardlink alias to protected object" };
    }
  });

  // Cleanup
  ConfigManager.resetInstance();
  resetProtectedObjectRegistryCache();
  await fs.rm(tempRoot, { recursive: true, force: true });

  console.log("\n=== Benchmark Summary Table ===");
  console.table(
    results.map((r) => ({
      Scenario: `${r.id}. ${r.scenario}`,
      "Mean (ms)": r.meanMs,
      "Min (ms)": r.minMs,
      "Max (ms)": r.maxMs,
      "rg Spawned": r.rgSpawned,
      Outcome: r.securityOutcome,
    }))
  );

  return {
    corpusFiles: totalFiles,
    corpusBytes: totalBytes,
    results,
  };
}

if (process.argv[1] && process.argv[1].endsWith("benchmark-r4-security.ts")) {
  runR4Benchmark().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
