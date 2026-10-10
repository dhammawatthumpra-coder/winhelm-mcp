import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../src/config/config-manager.js";
import { searchCodebase } from "../src/engine/ripgrep.js";

interface BenchResult {
  scenario: string;
  runs: number[];
  meanMs: number;
  minMs: number;
  maxMs: number;
  matches: number;
}

async function runBenchmark() {
  console.log("=== WinHelm v1.4 Core Security R3 Performance Benchmarks (Section 18) ===");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r3-bench-"));
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

  // Create 1 protected file inside corpus for scenario 2
  const inCorpusProtected = path.join(searchRoot, "module_0", "internal-secret.cfg");
  await fs.writeFile(inCorpusProtected, "INTERNAL_PROTECTED_DATA=456\n", "utf8");
  totalBytes += Buffer.byteLength("INTERNAL_PROTECTED_DATA=456\n");
  totalFiles++;

  // Create hardlink alias inside corpus pointing to outsideProtected for scenario 4
  const aliasFile = path.join(searchRoot, "module_1", "alias-secret.env");
  fsSync.linkSync(protectedSecretFile, aliasFile);
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
    },
    protectedPaths: [
      { path: protectedSecretFile, kind: "file", description: "Outside secret file" },
      { path: inCorpusProtected, kind: "file", description: "In-corpus secret file" },
      { path: protectedTreeDir, kind: "tree", description: "In-corpus protected tree" },
    ],
  };
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

  const manager = ConfigManager.resetInstance(configFile);
  await manager.init(configFile);

  const results: BenchResult[] = [];

  // Helper to run benchmark iterations
  async function benchScenario(
    name: string,
    fn: () => Promise<{ totalMatches: number }>,
    iterations = 5
  ) {
    // Warmup
    await fn();

    const runs: number[] = [];
    let lastMatches = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await fn();
      const t1 = performance.now();
      runs.push(t1 - t0);
      lastMatches = res.totalMatches;
    }
    const meanMs = runs.reduce((a, b) => a + b, 0) / runs.length;
    const minMs = Math.min(...runs);
    const maxMs = Math.max(...runs);
    results.push({
      scenario: name,
      runs,
      meanMs,
      minMs,
      maxMs,
      matches: lastMatches,
    });
    console.log(`[BENCHMARK] ${name}: mean = ${meanMs.toFixed(2)} ms (min: ${minMs.toFixed(2)} ms, max: ${maxMs.toFixed(2)} ms, matches: ${lastMatches})`);
  }

  // 1. clean search tree without intersecting protected rules
  const cleanSubdir = path.join(searchRoot, "module_2");
  await benchScenario("1. Clean search tree (no intersecting protected rules)", async () => {
    return await searchCodebase({
      searchPath: cleanSubdir,
      query: "benchmark_needle_search",
    });
  });

  // 2. search tree with one protected file rule
  const dirWithProtFile = path.join(searchRoot, "module_0");
  await benchScenario("2. Search tree with 1 protected file rule (carving active)", async () => {
    return await searchCodebase({
      searchPath: dirWithProtFile,
      query: "benchmark_needle_search",
    });
  });

  // 3. search tree with one protected tree rule
  await benchScenario("3. Search tree with 1 protected tree rule", async () => {
    return await searchCodebase({
      searchPath: searchRoot,
      query: "INNER_SECRET",
    });
  });

  // 4. tree containing hardlink alias to protected file
  const dirWithAlias = path.join(searchRoot, "module_1");
  await benchScenario("4. Tree containing hardlink alias to protected file", async () => {
    return await searchCodebase({
      searchPath: dirWithAlias,
      query: "benchmark_needle_search",
    });
  });

  // 5. filePattern active
  await benchScenario("5. filePattern active (*.ts)", async () => {
    return await searchCodebase({
      searchPath: searchRoot,
      query: "benchmark_needle_search",
      filePattern: "*.ts",
      maxResults: 50,
    });
  });

  // 6. contextLines active
  await benchScenario("6. contextLines active (contextLines = 2)", async () => {
    return await searchCodebase({
      searchPath: searchRoot,
      query: "targetWord",
      contextLines: 2,
      maxResults: 50,
    });
  });

  console.log("\n=== Summary Table ===");
  console.log("| Scenario | Mean (ms) | Min (ms) | Max (ms) | Matches |");
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.scenario} | ${r.meanMs.toFixed(2)} | ${r.minMs.toFixed(2)} | ${r.maxMs.toFixed(2)} | ${r.matches} |`);
  }

  // Cleanup
  ConfigManager.resetInstance();
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  console.log("\nBenchmark complete.");
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
