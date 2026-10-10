/**
 * WinHelm v1.4 Controlled Integration R3 Canonical Qualification Orchestrator
 *
 * Implements the deterministic two-phase canonical qualification harness:
 * - Phase 1: Functional Canonical Suite (all functional/security/integration tests)
 * - Phase 2: Performance Qualification (isolated/serial execution of AC-3.4.1 benchmarks)
 *
 * Overall status is PASS (exit 0) ONLY when both phases PASS.
 * Any phase failure results in fail-closed non-zero exit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface TestTotals {
  suites: number;
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
  durationMs: number;
}

export interface TestInventory {
  discoveredFiles: string[];
  functionalFiles: string[];
  performanceFiles: string[];
  mandatoryPerformanceFiles: string[];
}

export interface PhaseResult {
  phaseName: string;
  command: string;
  args: string[];
  status: "PASS" | "FAIL";
  exitCode: number;
  rawOutput: string;
  totals: TestTotals;
  fileCount: number;
  durationMs: number;
}

export interface QualificationSummary {
  timestamp: string;
  status: "PASS" | "FAIL";
  exitCode: number;
  inventory: TestInventory;
  phase1Functional: PhaseResult;
  phase2Performance?: PhaseResult;
  combinedTotals?: TestTotals;
}

export interface QualificationOptions {
  rootDir?: string;
  evidenceDir?: string;
  phase?: "all" | "functional" | "performance";
  inventoryOnly?: boolean;
  jsonInventory?: boolean;
  silentRealtime?: boolean;
  functionalConcurrency?: number;
  commandExecutor?: (
    cmd: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; cwd?: string }
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  customInventory?: TestInventory;
}

const MANDATORY_PERFORMANCE_FILES = [
  "test/perf/file-inspect-batch.perf.test.ts",
];

export function getRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

export function discoverAllTestFiles(rootDir: string): string[] {
  const testDir = path.join(rootDir, "test");
  if (!fs.existsSync(testDir)) {
    throw new Error(`Test directory does not exist: ${testDir}`);
  }

  const results: string[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
        results.push(relPath);
      }
    }
  }

  walk(testDir);
  results.sort();
  return results;
}

export function buildTestInventory(rootDir: string): TestInventory {
  const discoveredFiles = discoverAllTestFiles(rootDir);
  const performanceFiles: string[] = [];
  const functionalFiles: string[] = [];

  for (const file of discoveredFiles) {
    if (file.endsWith(".perf.test.ts") || file.includes("/perf/")) {
      performanceFiles.push(file);
    } else {
      functionalFiles.push(file);
    }
  }

  performanceFiles.sort();
  functionalFiles.sort();

  const inventory: TestInventory = {
    discoveredFiles,
    functionalFiles,
    performanceFiles,
    mandatoryPerformanceFiles: [...MANDATORY_PERFORMANCE_FILES],
  };

  validateTestInventory(inventory);
  return inventory;
}

export function validateTestInventory(inventory: TestInventory): void {
  // Check 1: Mandatory performance benchmark files must exist
  for (const req of inventory.mandatoryPerformanceFiles) {
    if (!inventory.performanceFiles.includes(req)) {
      throw new Error(
        `INVENTORY_ERROR: Mandatory performance benchmark file is missing from performance inventory: ${req}`
      );
    }
  }

  // Check 2: Performance and Functional sets must be strictly disjoint
  const funcSet = new Set(inventory.functionalFiles);
  const duplicates: string[] = [];
  for (const perfFile of inventory.performanceFiles) {
    if (funcSet.has(perfFile)) {
      duplicates.push(perfFile);
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `INVENTORY_ERROR: Duplicate test file assignment detected between functional and performance phases: ${duplicates.join(", ")}`
    );
  }

  // Check 3: Completeness - functional + performance must equal discovered
  const unionCount = inventory.functionalFiles.length + inventory.performanceFiles.length;
  if (unionCount !== inventory.discoveredFiles.length) {
    throw new Error(
      `INVENTORY_ERROR: Test inventory count mismatch. Discovered ${inventory.discoveredFiles.length}, but functional (${inventory.functionalFiles.length}) + performance (${inventory.performanceFiles.length}) = ${unionCount}`
    );
  }
}

export function parseNodeTestOutput(rawOutput: string): TestTotals {
  const totals: TestTotals = {
    suites: 0,
    tests: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    durationMs: 0,
  };

  const lines = rawOutput.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    // Spec / TAP reporter lines
    const mTests = trimmed.match(/^(?:ℹ|#)\s+tests\s+(\d+)/);
    if (mTests) totals.tests = parseInt(mTests[1], 10);

    const mSuites = trimmed.match(/^(?:ℹ|#)\s+suites\s+(\d+)/);
    if (mSuites) totals.suites = parseInt(mSuites[1], 10);

    const mPass = trimmed.match(/^(?:ℹ|#)\s+pass\s+(\d+)/);
    if (mPass) totals.pass = parseInt(mPass[1], 10);

    const mFail = trimmed.match(/^(?:ℹ|#)\s+fail\s+(\d+)/);
    if (mFail) totals.fail = parseInt(mFail[1], 10);

    const mCancelled = trimmed.match(/^(?:ℹ|#)\s+cancelled\s+(\d+)/);
    if (mCancelled) totals.cancelled = parseInt(mCancelled[1], 10);

    const mSkipped = trimmed.match(/^(?:ℹ|#)\s+skipped\s+(\d+)/);
    if (mSkipped) totals.skipped = parseInt(mSkipped[1], 10);

    const mTodo = trimmed.match(/^(?:ℹ|#)\s+todo\s+(\d+)/);
    if (mTodo) totals.todo = parseInt(mTodo[1], 10);

    const mDuration = trimmed.match(/^(?:ℹ|#)\s+duration_ms\s+([0-9.]+)/);
    if (mDuration) totals.durationMs = parseFloat(mDuration[1]);
  }

  return totals;
}

export async function defaultCommandExecutor(
  cmd: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; silentRealtime?: boolean }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const child = spawn(cmd, args, {
      cwd: options?.cwd || process.cwd(),
      env: { ...process.env, ...options?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      if (!options?.silentRealtime) {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer += text;
      if (!options?.silentRealtime) {
        process.stderr.write(text);
      }
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
      });
    });
  });
}

function resolveTsxCli(): string {
  try {
    const importMetaUrl = import.meta.url;
    const req = (awaitImportModule() as any);
    // fallback if needed
  } catch {}
  return path.resolve(getRepoRoot(), "node_modules/tsx/dist/cli.mjs");
}

function awaitImportModule(): any {
  return {};
}

export async function runCanonicalQualification(
  options?: QualificationOptions
): Promise<QualificationSummary> {
  const rootDir = options?.rootDir || getRepoRoot();
  const inventory = options?.customInventory || buildTestInventory(rootDir);
  validateTestInventory(inventory);

  if (options?.inventoryOnly) {
    if (options?.jsonInventory) {
      process.stdout.write(JSON.stringify(inventory, null, 2) + "\n");
    } else {
      console.log(`Discovered tests: ${inventory.discoveredFiles.length}`);
      console.log(`Functional tests: ${inventory.functionalFiles.length}`);
      console.log(`Performance tests: ${inventory.performanceFiles.length}`);
    }
    return {
      timestamp: new Date().toISOString(),
      status: "PASS",
      exitCode: 0,
      inventory,
      phase1Functional: {
        phaseName: "Inventory Check",
        command: "inventory-check",
        args: [],
        status: "PASS",
        exitCode: 0,
        rawOutput: "",
        totals: { suites: 0, tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, durationMs: 0 },
        fileCount: inventory.discoveredFiles.length,
        durationMs: 0,
      },
    };
  }

  const executor = options?.commandExecutor || defaultCommandExecutor;
  const tsxCli = resolveTsxCli();
  const startTime = Date.now();

  const log = (...msg: any[]) => {
    if (!options?.silentRealtime) console.log(...msg);
  };
  const errLog = (...msg: any[]) => {
    if (!options?.silentRealtime) console.error(...msg);
  };

  const selectedPhase = options?.phase || "all";

  let phase1Result: PhaseResult;

  if (selectedPhase === "all" || selectedPhase === "functional") {
    const funcConcurrency = options?.functionalConcurrency ?? Math.min(4, typeof os.availableParallelism === "function" ? os.availableParallelism() : 4);
    log("================================================================================");
    log("WINHELM CANONICAL QUALIFICATION — PHASE 1: FUNCTIONAL CANONICAL SUITE");
    log(`Files: ${inventory.functionalFiles.length} files (Concurrency: ${funcConcurrency})`);
    log(`Command: node tsx/cli.mjs --test --test-concurrency=${funcConcurrency} <functionalFiles...>`);
    log("================================================================================");

    const phase1Args = [tsxCli, "--test", `--test-concurrency=${funcConcurrency}`, ...inventory.functionalFiles];
    const p1Exec = await executor(process.execPath, phase1Args, {
      cwd: rootDir,
      silentRealtime: options?.silentRealtime,
    });

    const combinedP1Output = p1Exec.stdout + "\n" + p1Exec.stderr;
    const p1Totals = parseNodeTestOutput(combinedP1Output);
    const p1Status: "PASS" | "FAIL" = (p1Exec.exitCode === 0 && p1Totals.fail === 0) ? "PASS" : "FAIL";

    phase1Result = {
      phaseName: "Phase 1: Functional Canonical Suite",
      command: `node tsx/cli.mjs --test [${inventory.functionalFiles.length} files]`,
      args: phase1Args,
      status: p1Status,
      exitCode: p1Exec.exitCode,
      rawOutput: combinedP1Output,
      totals: p1Totals,
      fileCount: inventory.functionalFiles.length,
      durationMs: p1Totals.durationMs,
    };

    log("\n--------------------------------------------------------------------------------");
    log(`Phase 1 Status: ${p1Status} (Exit code: ${p1Exec.exitCode})`);
    log(
      `Totals: ${p1Totals.suites} suites, ${p1Totals.tests} tests, ${p1Totals.pass} pass, ` +
      `${p1Totals.fail} fail, ${p1Totals.skipped} skipped, duration: ${p1Totals.durationMs} ms`
    );
    log("--------------------------------------------------------------------------------\n");

    // If only functional phase requested, return immediately
    if (selectedPhase === "functional") {
      return {
        timestamp: new Date().toISOString(),
        status: p1Status,
        exitCode: p1Status === "PASS" ? 0 : (p1Exec.exitCode || 1),
        inventory,
        phase1Functional: phase1Result,
      };
    }

    // Fail-closed contract: If Phase 1 failed, DO NOT proceed to Phase 2, return FAIL immediately!
    if (p1Status === "FAIL") {
      errLog("FATAL: Phase 1 (Functional Suite) failed. Performance Phase will not be executed.");
      return {
        timestamp: new Date().toISOString(),
        status: "FAIL",
        exitCode: p1Exec.exitCode || 1,
        inventory,
        phase1Functional: phase1Result,
      };
    }
  } else {
    // Dummy skipped functional when phase=performance selected
    phase1Result = {
      phaseName: "Phase 1: Functional Canonical Suite (Bypassed by operator --phase=performance)",
      command: "bypassed",
      args: [],
      status: "PASS",
      exitCode: 0,
      rawOutput: "",
      totals: { suites: 0, tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, durationMs: 0 },
      fileCount: 0,
      durationMs: 0,
    };
  }

  // Phase 2: Performance Qualification
  log("================================================================================");
  log("WINHELM CANONICAL QUALIFICATION — PHASE 2: PERFORMANCE QUALIFICATION");
  log(`Files: ${inventory.performanceFiles.length} files (ISOLATED/SERIAL)`);
  log("Command: node tsx/cli.mjs --test --test-concurrency=1 <performanceFiles...>");
  log("Thresholds: AC-3.4.1 metadata <= 50 ms | SHA-256 >= 100 MB/s");
  log("================================================================================");

  const phase2Args = [tsxCli, "--test", "--test-concurrency=1", ...inventory.performanceFiles];
  const p2Exec = await executor(process.execPath, phase2Args, {
    cwd: rootDir,
    silentRealtime: options?.silentRealtime,
  });

  const combinedP2Output = p2Exec.stdout + "\n" + p2Exec.stderr;
  const p2Totals = parseNodeTestOutput(combinedP2Output);
  const p2Status: "PASS" | "FAIL" = (p2Exec.exitCode === 0 && p2Totals.fail === 0) ? "PASS" : "FAIL";

  const phase2Result: PhaseResult = {
    phaseName: "Phase 2: Performance Qualification",
    command: `node tsx/cli.mjs --test --test-concurrency=1 [${inventory.performanceFiles.length} files]`,
    args: phase2Args,
    status: p2Status,
    exitCode: p2Exec.exitCode,
    rawOutput: combinedP2Output,
    totals: p2Totals,
    fileCount: inventory.performanceFiles.length,
    durationMs: p2Totals.durationMs,
  };

  log("\n--------------------------------------------------------------------------------");
  log(`Phase 2 Status: ${p2Status} (Exit code: ${p2Exec.exitCode})`);
  log(
    `Totals: ${p2Totals.suites} suites, ${p2Totals.tests} tests, ${p2Totals.pass} pass, ` +
    `${p2Totals.fail} fail, ${p2Totals.skipped} skipped, duration: ${p2Totals.durationMs} ms`
  );
  log("--------------------------------------------------------------------------------\n");

  const overallStatus: "PASS" | "FAIL" = (phase1Result.status === "PASS" && phase2Result.status === "PASS") ? "PASS" : "FAIL";
  const overallExitCode = overallStatus === "PASS" ? 0 : (phase1Result.exitCode !== 0 ? phase1Result.exitCode : (phase2Result.exitCode !== 0 ? phase2Result.exitCode : 1));

  const combinedTotals: TestTotals = {
    suites: phase1Result.totals.suites + phase2Result.totals.suites,
    tests: phase1Result.totals.tests + phase2Result.totals.tests,
    pass: phase1Result.totals.pass + phase2Result.totals.pass,
    fail: phase1Result.totals.fail + phase2Result.totals.fail,
    cancelled: phase1Result.totals.cancelled + phase2Result.totals.cancelled,
    skipped: phase1Result.totals.skipped + phase2Result.totals.skipped,
    todo: phase1Result.totals.todo + phase2Result.totals.todo,
    durationMs: phase1Result.totals.durationMs + phase2Result.totals.durationMs,
  };

  log("================================================================================");
  log("WINHELM CANONICAL QUALIFICATION — COMBINED RESULT");
  log("================================================================================");
  log(`Phase 1 (Functional):  ${phase1Result.status} (${phase1Result.totals.pass}/${phase1Result.totals.tests} pass)`);
  log(`Phase 2 (Performance): ${phase2Result.status} (${phase2Result.totals.pass}/${phase2Result.totals.tests} pass)`);
  log(`Overall Qualification: ${overallStatus}`);
  log(`Exit Code:             ${overallExitCode}`);
  log("================================================================================\n");

  const summary: QualificationSummary = {
    timestamp: new Date().toISOString(),
    status: overallStatus,
    exitCode: overallExitCode,
    inventory,
    phase1Functional: phase1Result,
    phase2Performance: phase2Result,
    combinedTotals,
  };

  if (options?.evidenceDir) {
    try {
      if (!fs.existsSync(options.evidenceDir)) {
        fs.mkdirSync(options.evidenceDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(options.evidenceDir, "qualification-summary.json"),
        JSON.stringify(summary, null, 2),
        "utf8"
      );
      if (phase1Result.rawOutput) {
        fs.writeFileSync(
          path.join(options.evidenceDir, "functional-canonical-suite.log"),
          phase1Result.rawOutput,
          "utf8"
        );
      }
      if (phase2Result.rawOutput) {
        fs.writeFileSync(
          path.join(options.evidenceDir, "performance-qualification.log"),
          phase2Result.rawOutput,
          "utf8"
        );
      }
      console.log(`Persisted qualification evidence to: ${options.evidenceDir}`);
    } catch (err) {
      console.error(`Failed to write evidence to ${options.evidenceDir}:`, err);
    }
  }

  return summary;
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let phase: "all" | "functional" | "performance" = "all";
  let inventoryOnly = false;
  let jsonInventory = false;
  let evidenceDir: string | undefined;
  let functionalConcurrency: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--inventory-only") inventoryOnly = true;
    else if (arg === "--json-inventory") { inventoryOnly = true; jsonInventory = true; }
    else if (arg.startsWith("--phase=")) phase = arg.split("=")[1] as any;
    else if (arg.startsWith("--functional-concurrency=")) functionalConcurrency = parseInt(arg.split("=")[1], 10);
    else if (arg === "--evidence-dir" && i + 1 < args.length) { evidenceDir = args[++i]; }
  }

  runCanonicalQualification({
    phase,
    inventoryOnly,
    jsonInventory,
    evidenceDir,
    functionalConcurrency,
  }).then((summary) => {
    process.exit(summary.exitCode);
  }).catch((err) => {
    console.error("Canonical qualification runner failed:", err);
    process.exit(1);
  });
}
