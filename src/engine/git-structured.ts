/**
 * Spec 3.4 Tier B — structured Git primitives.
 *
 * Public contract is structured data, never raw CLI stdout. The already
 * installed local Git executable is used internally under the frozen
 * mechanism boundary only:
 * - direct executable spawn without any shell (execFile, argument vector);
 * - the repository path is authorized by the tool wrapper before execution
 *   and re-verified against the configured allowed roots for the resolved
 *   worktree toplevel (no traversal by repository indirection);
 * - all user-controlled values travel as arguments, never shell text;
 * - output capture is bounded; overflow is a structured error, not a clamp;
 * - every failure is converted into a WinHelm structured error.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { checkFolderAccess } from "../permissions/folder-access.js";
import { ConfigManager } from "../config/config-manager.js";
import { StructuredToolError } from "../errors/tool-error.js";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_EXEC_TIMEOUT_MS = 30_000;

interface GitRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function gitError(
  code: string,
  message: string,
  userAction: string,
  details?: Record<string, unknown>
): never {
  throw new StructuredToolError(code, message, userAction, details);
}

function runGit(
  repoPath: string,
  args: string[],
  expectSuccess = true
): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "-C", repoPath, ...args],
      {
        shell: false,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_EXEC_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "buffer",
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & {
            code?: string | number;
            killed?: boolean;
          };
          if (err.code === "ENOENT") {
            reject(
              new StructuredToolError(
                "GIT_EXEC_UNAVAILABLE",
                "The local Git executable is not available on PATH.",
                "Install Git or make the git executable available on PATH."
              )
            );
            return;
          }
          if (err.killed) {
            reject(
              new StructuredToolError(
                "GIT_OUTPUT_LIMIT_EXCEEDED",
                `Git output exceeded the ${MAX_GIT_OUTPUT_BYTES}-byte capture bound or timed out.`,
                "Narrow the query scope (fewer paths, smaller diff) and retry."
              )
            );
            return;
          }
          if (err.code === "ENOBUFS" || err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(
              new StructuredToolError(
                "GIT_OUTPUT_LIMIT_EXCEEDED",
                `Git output exceeded the ${MAX_GIT_OUTPUT_BYTES}-byte capture bound.`,
                "Narrow the query scope (fewer paths, smaller diff) and retry."
              )
            );
            return;
          }
          // expectSuccess=false callers (probes) receive the exit code.
          if (typeof err.code === "number") {
            resolve({
              code: err.code,
              stdout: stdout as Buffer,
              stderr: (stderr as Buffer).toString("utf8"),
            });
            return;
          }
          reject(
            new StructuredToolError(
              "GIT_EXEC_FAILED",
              `Git execution failed: ${err.message}`,
              "Verify the repository path and Git installation.",
              { args: args.join(" ") }
            )
          );
          return;
        }
        resolve({
          code: 0,
          stdout: stdout as Buffer,
          stderr: (stderr as Buffer).toString("utf8"),
        });
      }
    );
  }).then((result) => {
    if (expectSuccess && result.code !== 0) {
      gitError(
        "GIT_EXEC_FAILED",
        `Git command failed with exit code ${result.code}.`,
        "Verify the repository path and Git state.",
        { args: args.join(" "), stderr: truncateForDetails(result.stderr) }
      );
    }
    return result;
  });
}

function truncateForDetails(text: string, max = 400): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

/* ------------------------------------------------------------------ */
/* Authorized repository resolution                                    */
/* ------------------------------------------------------------------ */

export interface AuthorizedGitRepository {
  requested: string;
  toplevel: string;
}

/**
 * Verify the path is a work tree and that the resolved toplevel remains
 * inside a configured allowed read root, so `git -C <authorized path>`
 * cannot expose repository state outside the boundary by indirection.
 */
export async function resolveAuthorizedGitRepository(
  repoPath: string
): Promise<AuthorizedGitRepository> {
  const probe = await runGit(
    repoPath,
    ["rev-parse", "--show-toplevel"],
    false
  );
  if (probe.code !== 0) {
    gitError(
      "GIT_NOT_A_REPOSITORY",
      `The path is not inside a Git work tree: ${repoPath}`,
      "Provide a repository or work tree path inside an allowed folder.",
      { stderr: truncateForDetails(probe.stderr) }
    );
  }
  const toplevel = path.resolve(probe.stdout.toString("utf8").trim());
  const config = ConfigManager.getInstance().getConfig() as {
    folders?: { path: string; permission: "read" | "readwrite" }[];
  };
  const check = checkFolderAccess(toplevel, "read", config.folders ?? []);
  if (!check.allowed) {
    gitError(
      "GIT_ROOT_NOT_AUTHORIZED",
      `The repository toplevel ${toplevel} resolves outside the allowed folder roots; repository indirection may not escape the authorized boundary.`,
      "Authorize the repository root folder, or use a repository fully inside an allowed folder.",
      { toplevel, requested: repoPath }
    );
  }
  return { requested: repoPath, toplevel };
}

/* ------------------------------------------------------------------ */
/* git_status_structured                                               */
/* ------------------------------------------------------------------ */

export interface GitStatusEntry {
  index_status: string;
  worktree_status: string;
  path: string;
  orig_path?: string;
}

export interface GitStatusStructuredResult {
  repository: string;
  toplevel: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  clean: boolean;
  staged: GitStatusEntry[];
  unstaged_modified: GitStatusEntry[];
  untracked: GitStatusEntry[];
  unmerged: GitStatusEntry[];
}

interface PorcelainRecord {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  origPath?: string;
}

export async function readGitStatusStructured(
  repoPath: string
): Promise<GitStatusStructuredResult> {
  const repo = await resolveAuthorizedGitRepository(repoPath);
  const result = await runGit(repo.toplevel, [
    "status",
    "--porcelain=v1",
    "-z",
    "--branch",
    "--untracked-files=normal",
  ]);
  const text = result.stdout.toString("utf8");
  const fields = text.split("\0");

  let branch: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;

  const records: PorcelainRecord[] = [];
  let i = 0;
  // First field is the branch header (## ...) because --branch precedes all
  // entries in porcelain v1 -z output.
  if (fields[0] !== undefined && fields[0].startsWith("## ")) {
    const header = fields[0].slice(3).trim();
    const arrow = header.indexOf("...");
    if (arrow >= 0) {
      branch = header.slice(0, arrow);
      const tracking = header.slice(arrow + 3);
      const bracket = tracking.indexOf("[");
      const info = bracket >= 0 ? tracking.slice(bracket) : "";
      const aheadMatch = info.match(/ahead (\d+)/);
      const behindMatch = info.match(/behind (\d+)/);
      ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
      behind = behindMatch ? Number.parseInt(behindMatch[1], 10) : 0;
    } else {
      branch = header;
      ahead = null;
      behind = null;
    }
    i = 1;
  }

  while (i < fields.length) {
    const record = fields[i];
    if (record === undefined || record === "") {
      i += 1;
      continue;
    }
    if (record.length < 4) {
      gitError(
        "GIT_STATUS_PARSE_FAILED",
        "Git status output contained a malformed record.",
        "Retry the query; if it persists, report the parser issue.",
        { record: JSON.stringify(record) }
      );
    }
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    let entryPath = record.slice(3);
    let origPath: string | undefined;
    // Rename/copy records are followed by the original path as the next
    // NUL-terminated field in porcelain v1 -z.
    if (indexStatus === "R" || indexStatus === "C" ||
        worktreeStatus === "R" || worktreeStatus === "C") {
      const orig = fields[i + 1];
      if (orig !== undefined && orig !== "") {
        origPath = orig;
        i += 1;
      }
    }
    records.push({
      indexStatus,
      worktreeStatus,
      path: entryPath,
      ...(origPath !== undefined ? { origPath } : {}),
    });
    i += 1;
  }

  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  const unmerged: GitStatusEntry[] = [];
  for (const record of records) {
    const entry: GitStatusEntry = {
      index_status: record.indexStatus,
      worktree_status: record.worktreeStatus,
      path: record.path,
      ...(record.origPath !== undefined ? { orig_path: record.origPath } : {}),
    };
    if (
      record.indexStatus === "U" ||
      record.worktreeStatus === "U" ||
      (record.indexStatus === "A" && record.worktreeStatus === "A") ||
      (record.indexStatus === "D" && record.worktreeStatus === "D")
    ) {
      unmerged.push(entry);
      continue;
    }
    if (record.indexStatus === "?" && record.worktreeStatus === "?") {
      untracked.push(entry);
      continue;
    }
    if (record.indexStatus !== " ") {
      staged.push(entry);
    }
    if (record.worktreeStatus !== " ") {
      unstaged.push(entry);
    }
  }

  return {
    repository: repo.requested,
    toplevel: repo.toplevel,
    branch,
    ahead,
    behind,
    clean:
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0 &&
      unmerged.length === 0,
    staged,
    unstaged_modified: unstaged,
    untracked,
    unmerged,
  };
}

/* ------------------------------------------------------------------ */
/* git_diff_structured                                                 */
/* ------------------------------------------------------------------ */

export interface GitDiffFileStat {
  path: string;
  old_path?: string;
  binary: boolean;
  additions: number | null;
  deletions: number | null;
}

export interface GitDiffChunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: string[];
}

export interface GitDiffFilePatch {
  path: string;
  old_path?: string;
  binary: boolean;
  chunks: GitDiffChunk[];
  truncated: boolean;
}

export interface GitDiffStructuredResult {
  repository: string;
  toplevel: string;
  scope: "unstaged" | "staged";
  files: GitDiffFileStat[];
  total_additions: number;
  total_deletions: number;
  binary_files: number;
  patches: GitDiffFilePatch[] | null;
  patch_truncated: boolean;
}

export interface GitDiffOptions {
  repo_path: string;
  scope?: "unstaged" | "staged";
  include_patch?: boolean;
  max_patch_lines?: number;
}

export async function readGitDiffStructured(
  options: GitDiffOptions
): Promise<GitDiffStructuredResult> {
  const scope = options.scope ?? "unstaged";
  const includePatch = options.include_patch ?? true;
  const maxPatchLines = options.max_patch_lines ?? 200;
  const repo = await resolveAuthorizedGitRepository(options.repo_path);
  const diffArgs =
    scope === "staged"
      ? ["diff", "--cached", "--numstat", "-z"]
      : ["diff", "--numstat", "-z"];
  const numstat = await runGit(repo.toplevel, diffArgs);

  const files = parseNumstat(numstat.stdout.toString("utf8"));
  const totalAdditions = files.reduce(
    (sum, file) => sum + (file.additions ?? 0),
    0
  );
  const totalDeletions = files.reduce(
    (sum, file) => sum + (file.deletions ?? 0),
    0
  );
  const binaryFiles = files.filter((file) => file.binary).length;

  let patches: GitDiffFilePatch[] | null = null;
  let patchTruncated = false;
  if (includePatch) {
    const patchArgs =
      scope === "staged"
        ? ["diff", "--cached", "-U3"]
        : ["diff", "-U3"];
    const patchRun = await runGit(repo.toplevel, patchArgs);
    const parsed = parseUnifiedPatch(
      patchRun.stdout.toString("utf8"),
      maxPatchLines
    );
    patches = parsed.files;
    patchTruncated = parsed.truncated;
  }

  return {
    repository: options.repo_path,
    toplevel: repo.toplevel,
    scope,
    files,
    total_additions: totalAdditions,
    total_deletions: totalDeletions,
    binary_files: binaryFiles,
    patches,
    patch_truncated: patchTruncated,
  };
}

/**
 * Parse `git diff --numstat -z` by its real NUL-field grammar. Each record
 * starts with `"<added>\t<deleted>\t"`; a normal record then carries its path
 * inline up to the terminating NUL, while a rename/copy record has an empty
 * inline path slot followed by `<old-path>\0<new-path>\0` as separate NUL
 * fields (Git never emits an empty path, so the empty slot unambiguously
 * selects the two-path form). Malformed or truncated records fail closed.
 */
export function parseNumstat(text: string): GitDiffFileStat[] {
  if (text === "") return [];
  const fields = text.split("\0");
  const files: GitDiffFileStat[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record === undefined || record === "") continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new StructuredToolError(
        "GIT_DIFF_PARSE_FAILED",
        "Git numstat output contained a malformed record.",
        "Retry the query; if it persists, report the parser issue.",
        { record: JSON.stringify(record) }
      );
    }
    const addedRaw = record.slice(0, firstTab);
    const deletedRaw = record.slice(firstTab + 1, secondTab);
    const inlinePath = record.slice(secondTab + 1);
    const binary = addedRaw === "-" || deletedRaw === "-";
    let entryPath = inlinePath;
    let oldPath: string | undefined;
    if (inlinePath === "") {
      // Rename/copy form: the old and new paths follow as NUL fields; the
      // counts apply to that same file. Refuse truncated sequences.
      const oldField = fields[i + 1];
      const newField = fields[i + 2];
      if (
        oldField === undefined ||
        oldField === "" ||
        newField === undefined ||
        newField === ""
      ) {
        throw new StructuredToolError(
          "GIT_DIFF_PARSE_FAILED",
          "Git numstat rename record was truncated or malformed.",
          "Retry the query; if it persists, report the parser issue.",
          { record: JSON.stringify(record) }
        );
      }
      entryPath = newField;
      oldPath = oldField;
      i += 2;
    }
    const stat: GitDiffFileStat = {
      path: entryPath,
      ...(oldPath !== undefined ? { old_path: oldPath } : {}),
      binary,
      additions: binary ? null : parseNumstatCount(addedRaw, "additions"),
      deletions: binary ? null : parseNumstatCount(deletedRaw, "deletions"),
    };
    files.push(stat);
  }
  return files;
}

/**
 * A non-binary numstat count token must be one or more ASCII decimal digits
 * and represent a safe non-negative integer. Anything else (empty, alphabetic,
 * partially numeric, signed, fractional, whitespace-padded, or overflowing the
 * safe-integer range) fails closed instead of being coerced into NaN, a
 * partial number, or a null-by-serialization value.
 */
function parseNumstatCount(raw: string, field: "additions" | "deletions"): number {
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    gitError(
      "GIT_DIFF_PARSE_FAILED",
      "Git numstat output contained a malformed count token.",
      "Retry the query; if it persists, report the parser issue.",
      { field, token: JSON.stringify(raw) }
    );
  }
  return Number(raw);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse unified diff output into per-file bounded chunks. Binary content is
 * never included: binary files carry `binary: true` and no chunk lines.
 */
export function parseUnifiedPatch(
  text: string,
  maxPatchLines: number
): { files: GitDiffFilePatch[]; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const files: GitDiffFilePatch[] = [];
  let truncated = false;
  let remaining = maxPatchLines;

  let current: GitDiffFilePatch | null = null;
  let chunk: GitDiffChunk | null = null;

  const closeChunk = () => {
    if (current && chunk) {
      current.chunks.push(chunk);
      chunk = null;
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      closeChunk();
      current = {
        path: diffGitFallbackPath(line) ?? "",
        binary: false,
        chunks: [],
        truncated: false,
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("--- ")) {
      const p = parsePatchPath(line.slice(4));
      if (p !== null) {
        current.old_path = p.startsWith("a/") ? p.slice(2) : p;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = parsePatchPath(line.slice(4));
      if (p !== null) {
        current.path = p.startsWith("b/") ? p.slice(2) : p;
      }
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      current.old_path = line.slice(12);
      continue;
    }
    if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      current.path = line.slice(10);
      continue;
    }
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      current.binary = true;
      closeChunk();
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      closeChunk();
      chunk = {
        old_start: Number.parseInt(hunk[1], 10),
        old_lines: hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10),
        new_start: Number.parseInt(hunk[3], 10),
        new_lines: hunk[4] === undefined ? 1 : Number.parseInt(hunk[4], 10),
        lines: [],
      };
      continue;
    }
    if (
      chunk &&
      (line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line === "\\ No newline at end of file")
    ) {
      if (remaining > 0) {
        chunk.lines.push(line);
        remaining -= 1;
      } else {
        current.truncated = true;
        truncated = true;
      }
    }
    // File-header noise ("index", "old mode", "new file mode", ...) is
    // intentionally not part of the public chunk contract.
  }
  closeChunk();

  for (const file of files) {
    if (file.path === "" && file.old_path !== undefined) {
      file.path = file.old_path;
    }
  }
  return { files, truncated };
}

function parsePatchPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "/dev/null") return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Fallback path from the "diff --git a/<path> b/<path>" header. Binary files
 * never carry ---/+++ lines, so this is their only path source.
 */
function diffGitFallbackPath(line: string): string | null {
  const rest = line.slice("diff --git ".length).trim();
  const bIndex = rest.lastIndexOf(" b/");
  if (bIndex < 0) return null;
  return parsePatchPath(rest.slice(bIndex + 3));
}
