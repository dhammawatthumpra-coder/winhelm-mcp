import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildTestInventory,
  validateTestInventory,
  runCanonicalQualification,
  getRepoRoot,
  type TestInventory,
} from "../../scripts/run-canonical-qualification.js";

describe("WinHelm Canonical Qualification Harness Contracts (WO Section 23)", () => {
  const rootDir = getRepoRoot();

  it("1. functional-phase failure causes overall failure and halts before performance phase", async () => {
    let perfPhaseCalled = false;

    const mockExecutor = async (cmd: string, args: string[]) => {
      if (args.some((a) => a.includes(".perf.test.ts"))) {
        perfPhaseCalled = true;
        return { exitCode: 0, stdout: "ℹ tests 2\nℹ pass 2\nℹ fail 0\n", stderr: "" };
      }
      // Simulate functional phase failure
      return {
        exitCode: 1,
        stdout: "✖ failing test\nℹ tests 10\nℹ suites 2\nℹ pass 9\nℹ fail 1\nℹ duration_ms 500\n",
        stderr: "Test failed",
      };
    };

    const dummyInventory: TestInventory = {
      discoveredFiles: ["test/unit/sample.test.ts", "test/perf/file-inspect-batch.perf.test.ts"],
      functionalFiles: ["test/unit/sample.test.ts"],
      performanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
      mandatoryPerformanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
    };

    const summary = await runCanonicalQualification({
      rootDir,
      customInventory: dummyInventory,
      commandExecutor: mockExecutor,
      silentRealtime: true,
    });

    assert.strictEqual(summary.status, "FAIL", "Overall status must be FAIL when Phase 1 fails");
    assert.notStrictEqual(summary.exitCode, 0, "Overall exitCode must be non-zero when Phase 1 fails");
    assert.strictEqual(summary.phase1Functional.status, "FAIL");
    assert.strictEqual(perfPhaseCalled, false, "Performance phase must NOT be called when functional phase fails");
    assert.strictEqual(summary.phase2Performance, undefined, "Phase 2 result must be undefined when halted");
  });

  it("2. performance-phase failure causes overall failure", async () => {
    let p1Called = false;
    let p2Called = false;

    const mockExecutor = async (cmd: string, args: string[]) => {
      if (args.some((a) => a.includes(".perf.test.ts"))) {
        p2Called = true;
        // Simulate performance phase failure (e.g. threshold breached)
        return {
          exitCode: 1,
          stdout: "✖ threshold breached\nℹ tests 2\nℹ suites 1\nℹ pass 1\nℹ fail 1\nℹ duration_ms 600\n",
          stderr: "AssertionError: benchmark exceeded threshold",
        };
      }
      p1Called = true;
      return {
        exitCode: 0,
        stdout: "ℹ tests 50\nℹ suites 5\nℹ pass 50\nℹ fail 0\nℹ duration_ms 1200\n",
        stderr: "",
      };
    };

    const dummyInventory: TestInventory = {
      discoveredFiles: ["test/unit/sample.test.ts", "test/perf/file-inspect-batch.perf.test.ts"],
      functionalFiles: ["test/unit/sample.test.ts"],
      performanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
      mandatoryPerformanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
    };

    const summary = await runCanonicalQualification({
      rootDir,
      customInventory: dummyInventory,
      commandExecutor: mockExecutor,
      silentRealtime: true,
    });

    assert.strictEqual(p1Called, true, "Phase 1 must have executed");
    assert.strictEqual(p2Called, true, "Phase 2 must have executed");
    assert.strictEqual(summary.phase1Functional.status, "PASS");
    assert.strictEqual(summary.phase2Performance?.status, "FAIL");
    assert.strictEqual(summary.status, "FAIL", "Overall qualification must be FAIL if performance phase fails");
    assert.notStrictEqual(summary.exitCode, 0, "Overall exitCode must be non-zero");
  });

  it("3. performance phase is executed when functional phase passes", async () => {
    const executionOrder: string[] = [];

    const mockExecutor = async (cmd: string, args: string[]) => {
      if (args.some((a) => a.includes(".perf.test.ts"))) {
        executionOrder.push("performance");
        return {
          exitCode: 0,
          stdout: "ℹ tests 2\nℹ suites 1\nℹ pass 2\nℹ fail 0\nℹ duration_ms 400\n",
          stderr: "",
        };
      }
      executionOrder.push("functional");
      return {
        exitCode: 0,
        stdout: "ℹ tests 100\nℹ suites 10\nℹ pass 100\nℹ fail 0\nℹ duration_ms 5000\n",
        stderr: "",
      };
    };

    const dummyInventory: TestInventory = {
      discoveredFiles: ["test/unit/sample.test.ts", "test/perf/file-inspect-batch.perf.test.ts"],
      functionalFiles: ["test/unit/sample.test.ts"],
      performanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
      mandatoryPerformanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
    };

    const summary = await runCanonicalQualification({
      rootDir,
      customInventory: dummyInventory,
      commandExecutor: mockExecutor,
      silentRealtime: true,
    });

    assert.deepStrictEqual(
      executionOrder,
      ["functional", "performance"],
      "Execution must run functional phase first, followed by performance phase"
    );
    assert.strictEqual(summary.status, "PASS");
    assert.strictEqual(summary.exitCode, 0);
    assert.strictEqual(summary.phase1Functional.status, "PASS");
    assert.strictEqual(summary.phase2Performance?.status, "PASS");
    assert.strictEqual(summary.combinedTotals?.tests, 102);
    assert.strictEqual(summary.combinedTotals?.pass, 102);
  });

  it("4. benchmark thresholds are not overridden or weakened in test source", async () => {
    const perfFilePath = path.join(rootDir, "test/perf/file-inspect-batch.perf.test.ts");
    const content = await fs.readFile(perfFilePath, "utf8");

    // Must check <= 50 ms
    assert.ok(
      content.includes("result.elapsed_ms <= 50"),
      "Metadata threshold must be <= 50 ms"
    );
    assert.ok(
      content.includes("AC-3.4.1 target: <= 50 ms"),
      "AC-3.4.1 target label must specify <= 50 ms"
    );

    // Must check >= 100 MB/s
    assert.ok(
      content.includes("throughput >= 100"),
      "Throughput threshold must be >= 100 MB/s"
    );
    assert.ok(
      content.includes("AC-3.4.1 target: >= 100 MB/s"),
      "AC-3.4.1 target label must specify >= 100 MB/s"
    );

    // Must not contain retries or loosened assertions
    assert.ok(!content.includes("<= 60"), "Threshold must not be widened to 60");
    assert.ok(!content.includes("<= 100"), "Metadata threshold must not be widened to 100");
    assert.ok(!content.includes(">= 50"), "Throughput threshold must not be lowered to 50");
  });

  it("5. missing benchmark file causes fail-closed inventory error", () => {
    const invalidInventory: TestInventory = {
      discoveredFiles: ["test/unit/sample.test.ts"],
      functionalFiles: ["test/unit/sample.test.ts"],
      performanceFiles: [], // missing mandatory performance file!
      mandatoryPerformanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
    };

    assert.throws(
      () => validateTestInventory(invalidInventory),
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("INVENTORY_ERROR: Mandatory performance benchmark file is missing"));
        return true;
      }
    );
  });

  it("6. duplicate assignment of benchmark file is detected and prevented", () => {
    const duplicateInventory: TestInventory = {
      discoveredFiles: ["test/unit/sample.test.ts", "test/perf/file-inspect-batch.perf.test.ts"],
      functionalFiles: [
        "test/unit/sample.test.ts",
        "test/perf/file-inspect-batch.perf.test.ts", // duplicate!
      ],
      performanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
      mandatoryPerformanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
    };

    assert.throws(
      () => validateTestInventory(duplicateInventory),
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("INVENTORY_ERROR: Duplicate test file assignment detected")
        );
        return true;
      }
    );
  });

  it("7. inventory count mismatch throws fail-closed error", () => {
    const mismatchInventory: TestInventory = {
      discoveredFiles: [
        "test/unit/sample.test.ts",
        "test/unit/extra.test.ts",
        "test/perf/file-inspect-batch.perf.test.ts",
      ],
      functionalFiles: ["test/unit/sample.test.ts"],
      performanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
      mandatoryPerformanceFiles: ["test/perf/file-inspect-batch.perf.test.ts"],
    };

    assert.throws(
      () => validateTestInventory(mismatchInventory),
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("INVENTORY_ERROR: Test inventory count mismatch"));
        return true;
      }
    );
  });

  it("8. real repository test inventory is complete and valid", () => {
    const inventory = buildTestInventory(rootDir);
    assert.ok(inventory.discoveredFiles.length > 0);
    assert.ok(inventory.functionalFiles.length > 0);
    assert.strictEqual(inventory.performanceFiles.length, 1);
    assert.strictEqual(
      inventory.performanceFiles[0],
      "test/perf/file-inspect-batch.perf.test.ts"
    );
    assert.strictEqual(
      inventory.discoveredFiles.length,
      inventory.functionalFiles.length + inventory.performanceFiles.length
    );
  });
});
