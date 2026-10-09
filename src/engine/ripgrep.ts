import { execFile, execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { ConfigManager } from "../config/config-manager.js";
import {
  assertValidProtectedRuleKind,
  canonicalizeExistingAwarePath,
  isInsideOrEqualPrecomputed,
  normalizePathForCompare,
  type ProtectedPathRule,
} from "../permissions/folder-access.js";
import { searchInFiles } from "./filesystem.js";
import type { RipgrepMatch, RipgrepSearchResult } from "../types/index.js";

const execFileAsync = promisify(execFile);

/**
 * Test-observability hook for the ripgrep child-process invocation.
 *
 * Production always uses the real execFile-based invoker. Tests may inject a
 * stub to record the exact argv handed to the rg child process, which is how
 * the protected-path pre-exclusion guarantee is observably proven ("rg never
 * receives protected paths"). The hook never changes production search
 * semantics: the default invoker is byte-for-byte the previous call.
 */
export interface RipgrepInvoker {
  (rgPath: string, args: string[]): Promise<{ stdout: string }>;
}

export interface RipgrepDeps {
  execRg?: RipgrepInvoker;
}

const defaultExecRg: RipgrepInvoker = async (rgPath, args) => {
  const { stdout } = await execFileAsync(rgPath, args, {
    maxBuffer: 10 * 1024 * 1024, // 10MB
    encoding: "utf-8",
    windowsHide: true,
  });
  return { stdout };
};

let cachedRgPath: string | null = null;

/**
 * Locate ripgrep executable (rg.exe) with multi-path resolution
 */
export function findRipgrepPath(): string | null {
  if (cachedRgPath && existsSync(cachedRgPath)) {
    return cachedRgPath;
  }

  // Strategy 1: System PATH via where.exe
  try {
    const whereOut = execSync("where.exe rg.exe", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0];
    if (whereOut && existsSync(whereOut)) {
      cachedRgPath = whereOut;
      return whereOut;
    }
  } catch {
    // Not found in PATH
  }

  // Strategy 2: Common Windows installation paths (WinGet, Scoop, Cargo, Program Files)
  const home = os.homedir();
  const commonPaths = [
    path.join(home, "scoop", "apps", "ripgrep", "current", "rg.exe"),
    path.join(home, ".cargo", "bin", "rg.exe"),
    "C:\\Program Files\\Ripgrep\\rg.exe",
    "C:\\Program Files (x86)\\Ripgrep\\rg.exe",
  ];

  for (const candidate of commonPaths) {
    if (existsSync(candidate)) {
      cachedRgPath = candidate;
      return candidate;
    }
  }

  return null;
}

export interface RipgrepOptions {
  query: string;
  searchPath?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  isRegex?: boolean;
  page?: number;
  pageSize?: number;
  contextLines?: number;
}

function splitLogicalLines(content: string): string[] {
  const lines = content.split(/\r?\n/);

  // A terminating line break closes the final logical line; it does not
  // create an additional empty line after EOF. Interior empty lines remain.
  if (content.endsWith("\n") && lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

async function attachContextLines(
  matches: RipgrepMatch[],
  contextLines: number
): Promise<RipgrepMatch[]> {
  if (contextLines <= 0 || matches.length === 0) return matches;

  const cache = new Map<string, Promise<string[]>>();

  return Promise.all(
    matches.map(async (match) => {
      try {
        const access = ConfigManager.getInstance().checkPathAccess(match.file, "read");
        if (!access.allowed) return match;

        let linesPromise = cache.get(match.file);
        if (!linesPromise) {
          linesPromise = readFile(match.file, "utf8").then(splitLogicalLines);
          cache.set(match.file, linesPromise);
        }
        const lines = await linesPromise;

        const matchIndex = Math.max(0, match.line - 1);
        const beforeStart = Math.max(0, matchIndex - contextLines);
        const afterEnd = Math.min(lines.length, matchIndex + contextLines + 1);

        return {
          ...match,
          contextBefore: lines
            .slice(beforeStart, matchIndex)
            .map((text, index) => ({
              line: beforeStart + index + 1,
              text,
            })),
          contextAfter: lines
            .slice(matchIndex + 1, afterEnd)
            .map((text, index) => ({
              line: matchIndex + index + 2,
              text,
            })),
        };
      } catch {
        // Search results remain useful if a file changes or disappears between
        // ripgrep and context hydration. Preserve the match and omit context.
        return match;
      }
    })
  );
}

/**
 * S1 (Security R2): pre-authorized ripgrep search-domain carving.
 *
 * The rg child process must never be offered protected content. Instead of
 * invoking rg over the whole authorized target root and filtering matches
 * afterwards (R1 behavior), WinHelm first partitions the target into disjoint
 * authorized search roots that are proven — via canonical path math against
 * the active closed-world protected rules — to contain no protected file or
 * protected tree descendant, and hands ONLY those roots to rg.
 *
 * Why rule-guided carving is complete: for read access under an already
 * authorized target, a descendant is denied if and only if a protected rule
 * covers it (outside-folder denials are impossible for descendants of an
 * authorized root, and an invalid configuration is fail-closed before we get
 * here). Canonicalization (realpath) resolves symlink/junction aliases, so an
 * alias into a protected tree is recognized as inside the denied region.
 * ripgrep itself never follows symlinks/junctions during traversal, and we
 * never offer them as explicit roots either, so aliases cannot re-enter
 * protected content through the child process.
 */
interface DeniedSearchRegion {
  /** Canonical absolute path of the denied region. */
  canonical: string;
  /** normalizePathForCompare(canonical). */
  cmp: string;
  kind: "file" | "tree";
}

/** Conservative bound for one rg command line on Windows (CreateProcess caps at 32767). */
const MAX_RG_ARGV_CHARS = 20000;

function safeCanonicalize(p: string): string | undefined {
  try {
    return canonicalizeExistingAwarePath(p);
  } catch {
    return undefined;
  }
}

/**
 * Compute the denied regions (canonical) intersecting the search target.
 * Fail-closed: an unresolvable or malformed rule, a target that is itself
 * protected, or a target inside a protected tree throws, denying the search.
 */
function deniedRegionsForTarget(
  targetCmp: string,
  rules: ProtectedPathRule[]
): DeniedSearchRegion[] {
  const regions: DeniedSearchRegion[] = [];
  for (const rule of rules) {
    // Closed-world: a malformed kind cannot silently become file semantics.
    assertValidProtectedRuleKind(rule);
    const canonical = safeCanonicalize(rule.path);
    if (!canonical) {
      throw new Error(
        `Cannot canonicalize protected ${rule.kind} rule "${rule.label || rule.path}" while carving the ripgrep search domain; failing closed.`
      );
    }
    const cmp = normalizePathForCompare(canonical);
    if (cmp === targetCmp) {
      throw new Error(
        `Search target is itself protected by rule "${rule.label || rule.path}"; failing closed.`
      );
    }
    if (isInsideOrEqualPrecomputed(cmp, targetCmp)) {
      throw new Error(
        `Search target is inside protected ${rule.kind} rule "${rule.label || rule.path}"; failing closed.`
      );
    }
    if (isInsideOrEqualPrecomputed(targetCmp, cmp)) {
      regions.push({ canonical, cmp, kind: rule.kind });
    }
  }
  // Drop regions subsumed by another denied TREE region (shallowest first).
  regions.sort((a, b) => a.cmp.length - b.cmp.length);
  const pruned: DeniedSearchRegion[] = [];
  for (const region of regions) {
    const subsumed = pruned.some(
      (kept) =>
        kept.kind === "tree" && isInsideOrEqualPrecomputed(kept.cmp, region.cmp)
    );
    if (!subsumed) pruned.push(region);
  }
  return pruned;
}

/**
 * Match a carved FILE root against the user's filePattern with rg-compatible
 * semantics. rg's -g uses gitignore-style matching and, critically, does NOT
 * filter explicitly passed file arguments — so when carving emits file roots
 * (a protected file was carved out of a directory), WinHelm applies the
 * pattern here. A pattern without a slash matches the basename at any depth
 * (like rg); otherwise it matches against the path relative to the search
 * target. A leading "!" negates. Directory roots are never filtered here:
 * rg applies -g to them natively during traversal.
 */
function fileRootMatchesPattern(
  fileRoot: string,
  targetRoot: string,
  pattern: string
): boolean {
  let negate = false;
  let pat = pattern;
  if (pat.startsWith("!")) {
    negate = true;
    pat = pat.slice(1);
  }
  const rel = path
    .relative(targetRoot, fileRoot)
    .split(path.sep)
    .join("/");
  const base = path.basename(fileRoot);
  const matched =
    path.matchesGlob(rel, pat) ||
    (!pat.includes("/") && path.matchesGlob(base, pat));
  return negate ? !matched : matched;
}

interface CarveContext {
  /** Original search target (display path) that relative patterns resolve against. */
  targetRoot: string;
  /** When set, file roots are pattern-filtered and clean dirs are exploded to files. */
  filePattern?: string;
}

/**
 * Partition one directory (display path + its canonical form) into authorized
 * search roots, carving out denied regions. Only directory entries along
 * denied-region ancestor chains are listed; clean subtrees are handed to rg
 * whole so rg keeps its native traversal (ignore rules, hidden-file policy)
 * — unless a filePattern is set, in which case clean subtrees are exploded
 * to file roots so the pattern is evaluated uniformly target-relative
 * (rg does not apply -g to explicit file arguments).
 *
 * Symlink/junction entries are never descended and never offered to rg.
 * Other non-file, non-directory entries are never offered either.
 * Entries that cannot be canonicalized are excluded (fail closed).
 */
function carveAuthorizedRoots(
  displayDir: string,
  canonicalDir: string,
  regions: DeniedSearchRegion[],
  ctx: CarveContext
): string[] {
  const roots: string[] = [];
  let entries;
  try {
    entries = readdirSync(displayDir, { withFileTypes: true });
  } catch {
    // Cannot list this subtree: offer nothing from it (fail closed).
    return roots;
  }
  for (const entry of entries) {
    // ripgrep does not follow symlinks/junctions during traversal, and we
    // never offer them as explicit roots either: aliases cannot re-enter
    // protected content through the child process.
    if (entry.isSymbolicLink()) continue;
    const displayPath = path.join(displayDir, entry.name);
    const canonical = safeCanonicalize(displayPath);
    if (!canonical) continue; // fail closed for this entry
    const cmp = normalizePathForCompare(canonical);

    // Inside-or-equal a denied region: excluded entirely (no descent, no offer).
    if (regions.some((r) => isInsideOrEqualPrecomputed(r.cmp, cmp))) continue;

    if (entry.isDirectory()) {
      // A denied region nested strictly inside: carve deeper, else offer whole.
      // With a filePattern set, clean subtrees are exploded to file roots as
      // well so the pattern is evaluated uniformly target-relative.
      const needsCarve = regions.some(
        (r) => r.cmp !== cmp && isInsideOrEqualPrecomputed(cmp, r.cmp)
      );
      if (needsCarve || ctx.filePattern) {
        roots.push(
          ...carveAuthorizedRoots(displayPath, canonical, regions, ctx)
        );
      } else {
        roots.push(displayPath);
      }
    } else if (entry.isFile()) {
      if (
        !ctx.filePattern ||
        fileRootMatchesPattern(displayPath, ctx.targetRoot, ctx.filePattern)
      ) {
        roots.push(displayPath);
      }
    }
    // Sockets, FIFOs, devices, etc. are never offered.
  }
  return roots;
}

/**
 * Compute the pre-authorized search roots for a ripgrep invocation.
 *
 * Returns display paths that are safe to hand to the rg child process: every
 * returned root is proven (canonical path math against the active protected
 * rules) to contain no protected file or protected tree descendant. When no
 * protected rule intersects the target, the target itself is returned
 * unchanged (fast path: argv identical to pre-R2).
 *
 * Throws fail-closed when the target is itself protected / inside a
 * protected region, or when a protected rule cannot be resolved or validated.
 */
export function computeAuthorizedSearchRoots(
  targetPath: string,
  rules: ProtectedPathRule[],
  opts?: { filePattern?: string }
): string[] {
  const canonicalTarget = canonicalizeExistingAwarePath(targetPath);
  const targetCmp = normalizePathForCompare(canonicalTarget);
  const regions = deniedRegionsForTarget(targetCmp, rules);
  if (regions.length === 0) {
    return [targetPath];
  }
  // If the display path is a symlink/junction alias of the canonical target,
  // hand rg the canonical path so the search domain never depends on rg's
  // symlink-argument behavior. A pure case difference keeps the display path
  // so reported match paths look exactly as before.
  const displayResolvesSame =
    normalizePathForCompare(path.resolve(targetPath)) === targetCmp;
  const baseDisplay = displayResolvesSame ? targetPath : canonicalTarget;
  return carveAuthorizedRoots(baseDisplay, canonicalTarget, regions, {
    targetRoot: targetPath,
    filePattern: opts?.filePattern,
  });
}

/**
 * Execute paginated high-speed codebase search using ripgrep with fallback
 */
export async function searchCodebase(
  options: RipgrepOptions,
  deps?: RipgrepDeps
): Promise<RipgrepSearchResult> {
  const configManager = ConfigManager.getInstance();
  const targetPath = options.searchPath ? path.resolve(options.searchPath) : process.cwd();

  const pathCheck = configManager.checkPathAccess(targetPath, "read");
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const page = Math.max(1, options.page || 1);
  const pageSize = Math.max(1, Math.min(200, options.pageSize || 50));
  const rgPath = findRipgrepPath();

  if (!rgPath) {
    // Fallback to internal Node.js filesystem search
    const fallbackResults = await searchInFiles(
      options.query,
      targetPath,
      options.filePattern
    );

    const matches: RipgrepMatch[] = fallbackResults.map((m) => ({
      file: m.file,
      line: m.line,
      column: 1,
      text: m.text,
    }));

    const startIndex = (page - 1) * pageSize;
    const paginatedMatches = matches.slice(startIndex, startIndex + pageSize);
    const hydratedMatches = await attachContextLines(
      paginatedMatches,
      Math.max(0, options.contextLines ?? 0)
    );

    return {
      query: options.query,
      engine: "fallback",
      totalMatches: matches.length,
      page,
      pageSize,
      hasMore: startIndex + pageSize < matches.length,
      matches: hydratedMatches,
    };
  }

  // Build ripgrep arguments
  const args: string[] = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color=never",
    "--max-columns=300",
    // Explicit file roots (S1 carving) would otherwise omit the filename
    // prefix; directory searches already print it, so this is a no-op there.
    "--with-filename",
  ];

  if (options.caseSensitive) {
    args.push("-s");
  } else {
    args.push("-i");
  }

  if (!options.isRegex) {
    args.push("-F"); // Fixed string literal mode
  }

  if (options.filePattern) {
    args.push("-g", options.filePattern);
  }

  // Context is hydrated after match pagination. This avoids mixing
  // ripgrep's context-record separator format into match parsing/counting.
  // NOTE: search paths are appended per batch below ("--", query, ...roots).

  const execRg = deps?.execRg ?? defaultExecRg;

  // S1 (Security R2): pre-authorized search domain. The rg child process
  // receives ONLY paths proven (canonical path math against the active
  // protected rules) to contain no protected file or protected tree
  // descendant. Protected content is carved out BEFORE rg runs; the
  // per-result check below remains purely as defense-in-depth.
  const searchRoots = computeAuthorizedSearchRoots(
    targetPath,
    configManager.getProtectedPathRulesSnapshot(),
    { filePattern: options.filePattern }
  );

  // Deterministic bounded batches for the Windows command-line length limit
  // (CreateProcess caps at 32767 chars). Batch results are merged and
  // re-sorted deterministically below.
  const searchBatches: string[][] = [];
  {
    let current: string[] = [];
    let currentLen = 0;
    for (const root of searchRoots) {
      const cost = root.length + 3; // quoting + separator
      if (current.length > 0 && currentLen + cost > MAX_RG_ARGV_CHARS) {
        searchBatches.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(root);
      currentLen += cost;
    }
    if (current.length > 0) searchBatches.push(current);
  }

  const allMatches: RipgrepMatch[] = [];
  const pathAccessCache = new Map<string, boolean>();

  const isPathAllowed = (filePath: string): boolean => {
    let allowed = pathAccessCache.get(filePath);
    if (allowed === undefined) {
      allowed = configManager.checkPathAccess(filePath, "read").allowed;
      pathAccessCache.set(filePath, allowed);
    }
    return allowed;
  };

  const parseStdout = (stdout: string): void => {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      // Format: <filepath>:<line>:<column>:<text>
      // Note: Windows file paths begin with drive letter like D:\path\...
      // Regex matches: Drive:\... or relative path, followed by :line:column:
      let parsedMatch: RipgrepMatch | undefined;
      const match = line.match(/^([a-zA-Z]:[^\:]+|\.?[^:]+):(\d+):(\d+):(.*)$/);
      if (match) {
        parsedMatch = {
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          text: match[4].trim(),
        };
      } else {
        // Fallback split for unconventional paths
        const parts = line.split(":");
        if (parts.length >= 4) {
          const filePart = parts.slice(0, parts.length - 3).join(":");
          const lineNum = parseInt(parts[parts.length - 3], 10);
          const colNum = parseInt(parts[parts.length - 2], 10);
          const textPart = parts[parts.length - 1];
          if (!isNaN(lineNum) && !isNaN(colNum)) {
            parsedMatch = {
              file: filePart,
              line: lineNum,
              column: colNum,
              text: textPart.trim(),
            };
          }
        }
      }

      if (parsedMatch && isPathAllowed(parsedMatch.file)) {
        allMatches.push(parsedMatch);
      }
    }
  };

  try {
    for (const batch of searchBatches) {
      let stdout: string;
      try {
        ({ stdout } = await execRg(rgPath, [
          ...args,
          "--",
          options.query,
          ...batch,
        ]));
      } catch (err: any) {
        // ripgrep exits with code 1 when a batch has no matches.
        if (err?.code === 1) continue;
        throw err;
      }
      parseStdout(stdout);
    }
  } catch (err: any) {
    throw new Error(`Ripgrep search failed: ${err.message || err}`);
  }

  // Deterministic ordering contract (R2): matches are ordered by
  // (file, line, column) across batches and roots, so pagination and
  // totalMatches are stable regardless of how the domain was carved.
  allMatches.sort((a, b) => {
    const fa = a.file.toLowerCase();
    const fb = b.file.toLowerCase();
    if (fa !== fb) return fa < fb ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  {
    const startIndex = (page - 1) * pageSize;
    const paginatedMatches = allMatches.slice(startIndex, startIndex + pageSize);
    const hydratedMatches = await attachContextLines(
      paginatedMatches,
      Math.max(0, options.contextLines ?? 0)
    );

    return {
      query: options.query,
      engine: "ripgrep",
      totalMatches: allMatches.length,
      page,
      pageSize,
      hasMore: startIndex + pageSize < allMatches.length,
      matches: hydratedMatches,
    };
  }
}
