/**
 * Spec 3.4 A5 — canonical directory manifest.
 *
 * Deterministic snapshot of one allowed folder: canonical root
 * normalization, forward-slash relative paths, UTF-8 byte lexicographic
 * entry ordering, fixed follow_reparse=false (reparse points are recorded,
 * never traversed), fail-closed on inaccessible entries, and a
 * deterministic manifest_sha256 computed over the RFC 8785 canonical JSON
 * of the full scope structure.
 */
import { createReadStream, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ConfigManager } from "../config/config-manager.js";
import { StructuredToolError } from "../errors/tool-error.js";
import { canonicalJsonStringify, compareUtf8Bytes } from "../utils/canonical-json.js";

export interface DirectoryManifestInput {
  root_path: string;
  recursive?: boolean;
  max_depth?: number;
  hash_files?: boolean;
  exclude_patterns?: string[];
  /** v1.4 fixes this to false; traversal through reparse points is denied. */
  follow_reparse?: false;
}

export interface ManifestEntry {
  relative_path: string;
  type: "file" | "directory" | "reparse_point";
  bytes: number | null;
  sha256: string | null;
  mtime_utc: string | null;
  reparse: boolean;
}

export interface DirectoryManifestResult {
  root_path: string;
  scope: {
    recursive: boolean;
    max_depth: number;
    hash_files: boolean;
    exclude_patterns: string[];
    follow_reparse: false;
  };
  total_files: number;
  total_directories: number;
  total_bytes: number;
  manifest_sha256: string;
  entries: ManifestEntry[];
}

const MAX_MANIFEST_ENTRIES = 50_000;

function fail(
  code: string,
  message: string,
  userAction?: string,
  details?: Record<string, unknown>
): never {
  throw new StructuredToolError(code, message, userAction, details);
}

/**
 * Canonical root normalization (frozen contract): uppercase drive letter,
 * forward-slash separators, no trailing slash.
 */
export function canonicalRootPath(input: string): string {
  const resolved = path.resolve(input.normalize("NFKC").trim());
  const unified = resolved.replace(/\\/g, "/");
  return unified.replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // "**" crosses directory boundaries.
        source += ".*";
        index += 2;
        if (pattern[index] === "/") index += 1;
      } else {
        source += "[^/]*";
        index += 1;
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

function hashFileStream(filePath: string): Promise<string> {
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

export async function buildDirectoryManifest(
  input: DirectoryManifestInput
): Promise<DirectoryManifestResult> {
  if (typeof input.root_path !== "string" || !input.root_path.trim()) {
    fail("PATH_INVALID", "root_path must be a non-empty directory path.");
  }
  if (input.follow_reparse !== undefined && input.follow_reparse !== false) {
    fail(
      "PATH_INVALID",
      "follow_reparse is fixed to false in WinHelm v1.4; traversal through reparse points is denied.",
      "Remove the follow_reparse argument or pass false."
    );
  }

  const manager = ConfigManager.getInstance();
  const resolved = path.resolve(input.root_path.normalize("NFKC").trim());
  const check = manager.checkPathAccess(resolved, "read");
  if (!check.allowed) {
    fail(
      check.code ?? "FOLDER_ACCESS_DENIED",
      check.reason ?? "Root path is not authorized for read.",
      "Build manifests for folders inside allowed WinHelm roots."
    );
  }
  if (!existsSync(resolved)) {
    fail("PATH_NOT_FOUND", `Root path not found: ${input.root_path}`);
  }
  const rootStats = statSync(resolved);
  if (!rootStats.isDirectory()) {
    fail("PATH_INVALID", `root_path is not a directory: ${input.root_path}`);
  }

  const recursive = input.recursive ?? true;
  const maxDepth = Math.max(0, Math.min(input.max_depth ?? 10, 64));
  const hashFiles = input.hash_files ?? true;
  const excludePatterns = [...(input.exclude_patterns ?? [])].sort(compareUtf8Bytes);
  const excludeRegexps = excludePatterns.map(globToRegExp);

  const entries: ManifestEntry[] = [];
  const rootPrefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;

  const walk = (directory: string, depth: number): void => {
    if (entries.length > MAX_MANIFEST_ENTRIES) {
      fail(
        "INPUT_TOO_LARGE",
        `Manifest exceeds the ${MAX_MANIFEST_ENTRIES}-entry cap; narrow the scope with exclude_patterns or max_depth.`
      );
    }
    let dirents;
    try {
      dirents = readdirSync(directory, { withFileTypes: true });
    } catch (err) {
      fail(
        "DIRECTORY_READ_FAILED",
        `Manifest walk failed reading directory (fail-closed): ${directory}: ${(err as Error).message}`
      );
    }
    for (const dirent of dirents) {
      const full = path.join(directory, dirent.name);
      const relative = full.slice(rootPrefix.length).replace(/\\/g, "/");
      if (excludeRegexps.some((regex) => regex.test(relative))) continue;

      let lstat;
      try {
        lstat = lstatSync(full, { throwIfNoEntry: false });
      } catch {
        lstat = undefined;
      }
      if (!lstat) {
        fail(
          "PATH_NOT_FOUND",
          `Manifest entry vanished during the walk (fail-closed): ${relative}`
        );
      }

      const isReparse = lstat.isSymbolicLink();
      if (isReparse) {
        // Reparse points are recorded, never traversed (follow_reparse=false).
        entries.push({
          relative_path: relative,
          type: "reparse_point",
          bytes: null,
          sha256: null,
          mtime_utc: lstat.mtime.toISOString(),
          reparse: true,
        });
        continue;
      }

      if (lstat.isDirectory()) {
        entries.push({
          relative_path: relative,
          type: "directory",
          bytes: null,
          sha256: null,
          mtime_utc: lstat.mtime.toISOString(),
          reparse: false,
        });
        if (recursive && depth < maxDepth) {
          walk(full, depth + 1);
        }
        continue;
      }

      if (!lstat.isFile()) {
        // Character devices, sockets and other non-regular objects fail the
        // manifest closed: they have no deterministic snapshot semantics.
        fail(
          "PATH_INVALID",
          `Manifest entry is not a regular file, directory, or reparse point (fail-closed): ${relative}`
        );
      }

      let sha256: string | null = null;
      if (hashFiles) {
        try {
          sha256 = null; // set below (async)
        } catch {
          sha256 = null;
        }
      }
      entries.push({
        relative_path: relative,
        type: "file",
        bytes: lstat.size,
        sha256,
        mtime_utc: lstat.mtime.toISOString(),
        reparse: false,
      });
    }
  };

  walk(resolved, 0);

  if (hashFiles) {
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      entry.sha256 = await hashFileStream(path.join(resolved, entry.relative_path));
    }
  }

  // Canonical ordering: UTF-8 byte lexicographic over normalized relative
  // paths.
  entries.sort((a, b) => compareUtf8Bytes(a.relative_path, b.relative_path));

  const totalFiles = entries.filter((entry) => entry.type === "file").length;
  const totalDirectories = entries.filter((entry) => entry.type === "directory").length;
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);

  const scopeStructure = {
    root_path: canonicalRootPath(input.root_path),
    recursive,
    max_depth: maxDepth,
    exclude_patterns: excludePatterns,
    hash_files: hashFiles,
    follow_reparse: false as const,
    entries,
  };
  const manifestSha256 = createHash("sha256")
    .update(canonicalJsonStringify(scopeStructure), "utf8")
    .digest("hex");

  return {
    root_path: canonicalRootPath(input.root_path),
    scope: {
      recursive,
      max_depth: maxDepth,
      hash_files: hashFiles,
      exclude_patterns: excludePatterns,
      follow_reparse: false,
    },
    total_files: totalFiles,
    total_directories: totalDirectories,
    total_bytes: totalBytes,
    manifest_sha256: manifestSha256,
    entries,
  };
}
