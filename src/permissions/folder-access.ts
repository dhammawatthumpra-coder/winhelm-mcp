import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import type { FolderPermission } from "../config/schema-v2.js";

export type FolderAccessKind = "read" | "write";

export interface ProtectedPathRule {
  path: string;
  kind: "file" | "tree";
  label?: string;
}

export interface FolderAccessOptions {
  /**
   * True when the operation can delete/rename/replace the configured folder
   * node itself. Writing children inside the folder does not set this flag.
   */
  denyRootMutation?: boolean;
  /**
   * v1.3 mutation policy rejects traversal through symlink/junction/reparse
   * paths to reduce TOCTOU exposure.
   */
  rejectReparseMutation?: boolean;
  /**
   * Protected config/data/audit/install paths override ordinary folder grants.
   */
  protectedPaths?: ProtectedPathRule[];
}

export type FolderAccessCode =
  | "FOLDER_ALLOWED"
  | "FOLDER_NOT_APPROVED"
  | "FOLDER_READ_ONLY"
  | "FOLDER_ROOT_MUTATION"
  | "FOLDER_REPARSE_MUTATION"
  | "FOLDER_PROTECTED_PATH"
  | "PATH_INVALID";

export interface FolderAccessResult {
  allowed: boolean;
  code: FolderAccessCode;
  reason: string;
  canonicalPath?: string;
  matchedFolder?: FolderPermission;
  reparsePath?: string;
}

function canonicalizeExistingAware(inputPath: string): string {
  const normalized = inputPath.normalize("NFKC");
  const resolved = path.resolve(normalized);

  if (existsSync(resolved)) {
    return realpathSync(resolved);
  }

  let ancestor = path.dirname(resolved);
  while (ancestor && !existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  if (!ancestor || !existsSync(ancestor)) {
    return resolved;
  }

  const realAncestor = realpathSync(ancestor);
  const remainder = path.relative(ancestor, resolved);
  return path.resolve(realAncestor, remainder);
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(root: string, target: string): boolean {
  const rootCmp = normalizeForCompare(root);
  const targetCmp = normalizeForCompare(target);
  const relative = path.relative(rootCmp, targetCmp);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findReparseTraversal(inputPath: string): string | undefined {
  const resolved = path.resolve(inputPath.normalize("NFKC"));
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  const segments = relative.split(path.sep).filter(Boolean);

  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return current;
      }
    } catch {
      // A race or inaccessible component is handled by downstream access
      // checks/operation failure. Do not convert uncertainty into permission.
      return current;
    }
  }

  return undefined;
}

interface CanonicalFolder {
  configured: FolderPermission;
  canonicalRoot: string;
}

function canonicalFolders(folders: FolderPermission[]): CanonicalFolder[] {
  const result: CanonicalFolder[] = [];
  for (const configured of folders) {
    try {
      result.push({
        configured,
        canonicalRoot: canonicalizeExistingAware(configured.path),
      });
    } catch {
      // Invalid/inaccessible configured roots cannot grant permission.
    }
  }

  // Most-specific folder wins when roots overlap.
  result.sort((a, b) => b.canonicalRoot.length - a.canonicalRoot.length);
  return result;
}

/**
 * Whether one protected rule covers an already canonicalized target path.
 * Shared by the schema-v2 folder check and the legacy allowedDirectories check
 * so both modes protect WinHelm's own config/data/log/install paths.
 */
export function protectedRuleBlocksPath(
  rule: ProtectedPathRule,
  canonicalPath: string
): boolean {
  const protectedCanonical = canonicalizeExistingAware(rule.path);
  return rule.kind === "tree"
    ? isInsideOrEqual(protectedCanonical, canonicalPath)
    : normalizeForCompare(protectedCanonical) === normalizeForCompare(canonicalPath);
}

export function canonicalizeExistingAwarePath(inputPath: string): string {
  return canonicalizeExistingAware(inputPath);
}

export function checkFolderAccess(
  targetPath: unknown,
  access: FolderAccessKind,
  folders: FolderPermission[],
  options: FolderAccessOptions = {}
): FolderAccessResult {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    return {
      allowed: false,
      code: "PATH_INVALID",
      reason: "A non-empty filesystem path is required.",
    };
  }

  const rawPath = targetPath.trim();

  if (access === "write" && options.rejectReparseMutation !== false) {
    const reparsePath = findReparseTraversal(rawPath);
    if (reparsePath) {
      return {
        allowed: false,
        code: "FOLDER_REPARSE_MUTATION",
        reason: `Mutation through a symlink/junction/reparse path is not permitted in schema-v2: ${reparsePath}`,
        reparsePath,
      };
    }
  }

  let canonicalPath: string;
  try {
    canonicalPath = canonicalizeExistingAware(rawPath);
  } catch {
    return {
      allowed: false,
      code: "PATH_INVALID",
      reason: `Unable to canonicalize path: ${rawPath}`,
    };
  }

  for (const protectedRule of options.protectedPaths ?? []) {
    try {
      if (protectedRuleBlocksPath(protectedRule, canonicalPath)) {
        return {
          allowed: false,
          code: "FOLDER_PROTECTED_PATH",
          reason: `Path is protected by WinHelm security policy: ${protectedRule.label || protectedRule.path}`,
          canonicalPath,
        };
      }
    } catch {
      // A malformed protected rule never grants access. Continue evaluating
      // ordinary folder permissions; runtime rule construction is separately
      // validated before enforcement is activated.
    }
  }

  const candidates = canonicalFolders(folders);
  const matched = candidates.find(({ canonicalRoot }) =>
    isInsideOrEqual(canonicalRoot, canonicalPath)
  );

  if (!matched) {
    return {
      allowed: false,
      code: "FOLDER_NOT_APPROVED",
      reason: `Path is outside configured schema-v2 folders: ${rawPath}`,
      canonicalPath,
    };
  }

  if (access === "write" && matched.configured.permission !== "readwrite") {
    return {
      allowed: false,
      code: "FOLDER_READ_ONLY",
      reason: `Folder "${matched.configured.alias || matched.configured.path}" is read-only.`,
      canonicalPath,
      matchedFolder: matched.configured,
    };
  }

  if (
    access === "write" &&
    options.denyRootMutation === true &&
    normalizeForCompare(matched.canonicalRoot) === normalizeForCompare(canonicalPath)
  ) {
    return {
      allowed: false,
      code: "FOLDER_ROOT_MUTATION",
      reason: "The configured folder root cannot be deleted, moved, renamed, or replaced.",
      canonicalPath,
      matchedFolder: matched.configured,
    };
  }

  return {
    allowed: true,
    code: "FOLDER_ALLOWED",
    reason: "Folder permission allows this access.",
    canonicalPath,
    matchedFolder: matched.configured,
  };
}
