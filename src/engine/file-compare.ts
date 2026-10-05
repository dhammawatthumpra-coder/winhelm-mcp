/**
 * Spec 3.4 A5 — deterministic file comparison.
 *
 * `file_compare` reports byte/text equality with the first-difference
 * offset, prefix/append-only semantics and an optional bounded unified diff.
 * Both paths must be read-authorized; no reparse/boundary escape is
 * possible because both canonical paths must sit inside allowed folders.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ConfigManager } from "../config/config-manager.js";
import { StructuredToolError } from "../errors/tool-error.js";

export type CompareMode = "bytes" | "text";
export type CompareNewlineNormalization = "none" | "ignore_cr" | "strict";

export interface FileCompareInput {
  path_a: string;
  path_b: string;
  mode: CompareMode;
  newline_normalization?: CompareNewlineNormalization;
  unified_diff?: boolean;
  max_diff_lines?: number;
}

export interface UnifiedDiffHunk {
  header: string;
  lines: string[];
}

export interface FileCompareResult {
  equal: boolean;
  mode: CompareMode;
  bytes_a: number;
  bytes_b: number;
  sha256_a: string;
  sha256_b: string;
  first_difference_offset: number | null;
  is_prefix_match: boolean;
  is_append_only: boolean;
  appended_bytes: number | null;
  lines_a?: number;
  lines_b?: number;
  first_difference_line?: number | null;
  unified_diff?: string[];
  diff_truncated?: boolean;
}

const MAX_TEXT_COMPARE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DIFF_LINES = 200;
const MAX_DIFF_LCS_CELLS = 1_000_000;

function fail(
  code: string,
  message: string,
  userAction?: string,
  details?: Record<string, unknown>
): never {
  throw new StructuredToolError(code, message, userAction, details);
}

function authorizeComparePath(rawPath: string, label: string): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    fail("PATH_INVALID", `${label} must be a non-empty filesystem path.`);
  }
  const resolved = path.resolve(rawPath.normalize("NFKC").trim());
  const manager = ConfigManager.getInstance();
  const check = manager.checkPathAccess(resolved, "read");
  if (!check.allowed) {
    fail(
      check.code ?? "FOLDER_ACCESS_DENIED",
      check.reason ?? `Path is not authorized for read: ${label}`,
      "Compare only paths inside allowed WinHelm folders."
    );
  }
  if (!existsSync(resolved)) {
    fail("PATH_NOT_FOUND", `Path not found: ${rawPath}`);
  }
  const stats = statSync(resolved);
  if (stats.isDirectory()) {
    fail("PATH_INVALID", `${label} is a directory, not a file: ${rawPath}`);
  }
  return resolved;
}

async function hashFileStream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hasher = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hasher.update(chunk));
    stream.on("end", () => resolve(hasher.digest("hex")));
    stream.on("error", (err) => {
      stream.close();
      reject(err);
    });
  });
}

interface ByteScanOutcome {
  firstDifference: number | null; // byte offset of the first differing byte
  compared: number; // bytes compared before one stream ended
}

/**
 * Stream both files once, tracking the first differing offset. As soon as
 * one side is exhausted with no difference found, the outcome is already
 * determined (prefix relation) and the scan finishes without draining the
 * longer stream.
 */
function scanBytes(
  pathA: string,
  pathB: string
): Promise<ByteScanOutcome> {
  return new Promise((resolve, reject) => {
    const streamA = createReadStream(pathA);
    const streamB = createReadStream(pathB);
    let offset = 0;
    let bufferA: Buffer = Buffer.alloc(0);
    let bufferB: Buffer = Buffer.alloc(0);
    let done = false;

    const finish = (outcome: ByteScanOutcome) => {
      if (done) return;
      done = true;
      streamA.destroy();
      streamB.destroy();
      resolve(outcome);
    };
    const failScan = (err: Error) => {
      if (done) return;
      done = true;
      streamA.destroy();
      streamB.destroy();
      reject(err);
    };

    const step = () => {
      if (done) return;
      const length = Math.min(bufferA.length, bufferB.length);
      if (length > 0) {
        for (let i = 0; i < length; i++) {
          if (bufferA[i] !== bufferB[i]) {
            finish({ firstDifference: offset + i, compared: offset + i });
            return;
          }
        }
        offset += length;
        bufferA = bufferA.subarray(length);
        bufferB = bufferB.subarray(length);
      }
      const aExhausted = streamA.readableEnded && bufferA.length === 0;
      const bExhausted = streamB.readableEnded && bufferB.length === 0;
      if (aExhausted || bExhausted) {
        finish({ firstDifference: null, compared: offset });
      }
    };

    streamA.on("data", (chunk: Buffer) => {
      bufferA = Buffer.concat([bufferA, chunk]);
      step();
    });
    streamB.on("data", (chunk: Buffer) => {
      bufferB = Buffer.concat([bufferB, chunk]);
      step();
    });
    streamA.on("error", failScan);
    streamB.on("error", failScan);
    streamA.on("end", () => step());
    streamB.on("end", () => step());
  });
}

function normalizeText(text: string, normalization: CompareNewlineNormalization): string {
  if (normalization === "ignore_cr") {
    return text.replace(/\r/g, "");
  }
  if (normalization === "strict") {
    return text.replace(/\r\n/g, "\n");
  }
  return text;
}

interface SimpleLineDiff {
  hunks: string[];
  truncated: boolean;
}

/**
 * Bounded unified diff: common prefix/suffix trim plus an LCS diff over the
 * bounded middle. Deterministic for any input.
 */
function buildUnifiedDiff(
  linesA: string[],
  linesB: string[],
  maxDiffLines: number
): SimpleLineDiff {
  let start = 0;
  while (
    start < linesA.length &&
    start < linesB.length &&
    linesA[start] === linesB[start]
  ) {
    start += 1;
  }
  let endA = linesA.length;
  let endB = linesB.length;
  while (
    endA > start &&
    endB > start &&
    linesA[endA - 1] === linesB[endB - 1]
  ) {
    endA -= 1;
    endB -= 1;
  }

  const middleA = linesA.slice(start, endA);
  const middleB = linesB.slice(start, endB);

  const outputLines: string[] = [];
  let truncated = false;

  if (middleA.length * middleB.length > MAX_DIFF_LCS_CELLS) {
    // Beyond the LCS bound the middle is reported wholesale (deterministic).
    truncated = true;
    outputLines.push(`@@ -${start + 1},${middleA.length} +${start + 1},${middleB.length} @@`);
    for (const line of middleA.slice(0, maxDiffLines)) outputLines.push(`-${line}`);
    for (const line of middleB.slice(0, Math.max(0, maxDiffLines - Math.min(middleA.length, maxDiffLines)))) {
      outputLines.push(`+${line}`);
    }
    return { hunks: outputLines.slice(0, maxDiffLines), truncated: true };
  }

  // LCS dynamic programming table over the bounded middle.
  const rows = middleA.length;
  const cols = middleB.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= rows; i++) {
    table.push(new Uint32Array(cols + 1));
  }
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] =
        middleA[i] === middleB[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: Array<{ sign: "-" | "+" | " "; text: string; aLine: number; bLine: number }> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (middleA[i] === middleB[j]) {
      ops.push({ sign: " ", text: middleA[i], aLine: start + i + 1, bLine: start + j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ sign: "-", text: middleA[i], aLine: start + i + 1, bLine: start + j + 1 });
      i += 1;
    } else {
      ops.push({ sign: "+", text: middleB[j], aLine: start + i + 1, bLine: start + j + 1 });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ sign: "-", text: middleA[i], aLine: start + i + 1, bLine: start + j + 1 });
    i += 1;
  }
  while (j < cols) {
    ops.push({ sign: "+", text: middleB[j], aLine: start + i + 1, bLine: start + j + 1 });
    j += 1;
  }

  // Group ops into hunks with up to 3 context lines, bounded by maxDiffLines.
  const context = 3;
  let index = 0;
  while (index < ops.length && outputLines.length < maxDiffLines) {
    if (ops[index].sign === " ") {
      index += 1;
      continue;
    }
    let hunkStart = index;
    while (hunkStart > 0 && index - hunkStart < context && ops[hunkStart - 1].sign === " ") {
      hunkStart -= 1;
    }
    let hunkEnd = index;
    let lastChange = index;
    while (hunkEnd < ops.length && hunkEnd - lastChange <= context) {
      if (ops[hunkEnd].sign !== " ") lastChange = hunkEnd;
      hunkEnd += 1;
    }
    const hunkOps = ops.slice(hunkStart, hunkEnd);
    const aStart = hunkOps[0].aLine;
    const bStart = hunkOps[0].bLine;
    const aCount = hunkOps.filter((op) => op.sign !== "+").length;
    const bCount = hunkOps.filter((op) => op.sign !== "-").length;
    outputLines.push(
      `@@ -${aStart},${aCount} +${bStart},${bCount} @@`
    );
    for (const op of hunkOps) {
      if (outputLines.length >= maxDiffLines) {
        truncated = true;
        break;
      }
      outputLines.push(`${op.sign}${op.text}`);
    }
    index = hunkEnd;
  }
  if (index < ops.length) truncated = true;

  return { hunks: outputLines.slice(0, maxDiffLines), truncated };
}

export async function compareFiles(input: FileCompareInput): Promise<FileCompareResult> {
  const resolvedA = authorizeComparePath(input.path_a, "path_a");
  const resolvedB = authorizeComparePath(input.path_b, "path_b");

  const statsA = statSync(resolvedA);
  const statsB = statSync(resolvedB);
  const [shaA, shaB] = await Promise.all([
    hashFileStream(resolvedA),
    hashFileStream(resolvedB),
  ]);

  const base = {
    mode: input.mode,
    bytes_a: statsA.size,
    bytes_b: statsB.size,
    sha256_a: shaA,
    sha256_b: shaB,
  };

  if (input.mode === "bytes") {
    const scan = await scanBytes(resolvedA, resolvedB);
    const sameLength = statsA.size === statsB.size;
    const equal = scan.firstDifference === null && sameLength;
    const isPrefixMatch =
      scan.firstDifference === null &&
      (equal || statsA.size !== statsB.size);
    // append-only: A is a strict prefix of B (evidence invariance direction).
    const isAppendOnly =
      scan.firstDifference === null &&
      (equal || statsB.size > statsA.size);
    const appendedBytes =
      scan.firstDifference === null && statsB.size > statsA.size
        ? statsB.size - statsA.size
        : equal
          ? 0
          : null;

    return {
      equal,
      ...base,
      first_difference_offset: scan.firstDifference,
      is_prefix_match: isPrefixMatch,
      is_append_only: isAppendOnly,
      appended_bytes: appendedBytes,
    };
  }

  // Text mode.
  if (statsA.size > MAX_TEXT_COMPARE_BYTES || statsB.size > MAX_TEXT_COMPARE_BYTES) {
    fail(
      "INPUT_TOO_LARGE",
      `text compare is bounded at ${MAX_TEXT_COMPARE_BYTES} bytes per file; use mode=bytes for larger files.`,
      undefined,
      { bytes_a: statsA.size, bytes_b: statsB.size }
    );
  }
  const normalization = input.newline_normalization ?? "none";
  const [rawA, rawB] = await Promise.all([
    fs.readFile(resolvedA, "utf8"),
    fs.readFile(resolvedB, "utf8"),
  ]);
  const textA = normalizeText(rawA, normalization);
  const textB = normalizeText(rawB, normalization);
  const linesA = textA.split("\n");
  const linesB = textB.split("\n");

  let firstDifferenceLine: number | null = null;
  const lineCount = Math.min(linesA.length, linesB.length);
  for (let index = 0; index < lineCount; index++) {
    if (linesA[index] !== linesB[index]) {
      firstDifferenceLine = index + 1;
      break;
    }
  }
  if (firstDifferenceLine === null && linesA.length !== linesB.length) {
    firstDifferenceLine = lineCount + 1;
  }
  const equal =
    firstDifferenceLine === null && linesA.length === linesB.length;

  // Byte-level first difference for the offset contract.
  const scan = await scanBytes(resolvedA, resolvedB);

  const result: FileCompareResult = {
    equal,
    ...base,
    first_difference_offset: equal ? null : scan.firstDifference ?? Math.min(statsA.size, statsB.size),
    is_prefix_match: scan.firstDifference === null,
    is_append_only:
      scan.firstDifference === null &&
      (linesA.length <= linesB.length),
    appended_bytes:
      scan.firstDifference === null && statsB.size >= statsA.size
        ? statsB.size - statsA.size
        : null,
    lines_a: linesA.length,
    lines_b: linesB.length,
    first_difference_line: equal ? null : firstDifferenceLine,
  };

  if (input.unified_diff && !equal) {
    const maxDiffLines = Math.max(
      1,
      Math.min(input.max_diff_lines ?? DEFAULT_MAX_DIFF_LINES, 2_000)
    );
    const diff = buildUnifiedDiff(linesA, linesB, maxDiffLines);
    result.unified_diff = diff.hunks;
    result.diff_truncated = diff.truncated;
  }

  return result;
}
