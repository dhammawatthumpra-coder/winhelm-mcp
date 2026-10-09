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
  /**
   * Pre-canonicalized authorization context for repeated batch checks.
   */
  preparedContext?: PreparedFolderAccessContext;
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
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error(`A non-empty filesystem path is required for canonicalization: ${String(inputPath)}`);
  }
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

export function normalizePathForCompare(value: string): string {
  return normalizeForCompare(value);
}

export function isInsideOrEqualPrecomputed(rootCmp: string, targetCmp: string): boolean {
  const relative = path.relative(rootCmp, targetCmp);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface PreparedFolderAccessCandidate {
  configured: FolderPermission;
  canonicalRoot: string;
  normalizedRootForCompare: string;
}

export interface PreparedProtectedRule {
  rule: ProtectedPathRule;
  canonicalPath: string;
  normalizedForCompare: string;
  failed?: boolean;
  error?: string;
}

export interface PreparedFolderAccessContext {
  preparedRules: PreparedProtectedRule[];
  candidates: PreparedFolderAccessCandidate[];
  hasFailedProtectedRule?: boolean;
  failedProtectedRuleReason?: string;
}

export function prepareFolderAccessContext(
  folders: FolderPermission[],
  protectedPaths: ProtectedPathRule[] = []
): PreparedFolderAccessContext {
  const candidates: PreparedFolderAccessCandidate[] = [];
  for (const configured of folders) {
    try {
      const canonicalRoot = canonicalizeExistingAware(configured.path);
      candidates.push({
        configured,
        canonicalRoot,
        normalizedRootForCompare: normalizeForCompare(canonicalRoot),
      });
    } catch {
      // Invalid/inaccessible configured roots cannot grant permission.
    }
  }

  // Most-specific folder wins when roots overlap.
  candidates.sort((a, b) => b.canonicalRoot.length - a.canonicalRoot.length);

  const preparedRules: PreparedProtectedRule[] = [];
  let hasFailedProtectedRule = false;
  let failedProtectedRuleReason: string | undefined;

  for (const rule of protectedPaths) {
    try {
      if (!rule || typeof rule.path !== "string" || rule.path.trim() === "") {
        throw new Error(`Invalid protected path rule: ${JSON.stringify(rule)}`);
      }
      const canonicalPath = canonicalizeExistingAware(rule.path);
      preparedRules.push({
        rule,
        canonicalPath,
        normalizedForCompare: normalizeForCompare(canonicalPath),
      });
    } catch (err: any) {
      // Malformed/inaccessible protected rule must fail closed across prepared evaluations.
      hasFailedProtectedRule = true;
      if (!failedProtectedRuleReason) {
        failedProtectedRuleReason = `Protected path rule preparation failed: ${rule?.label || rule?.path || "malformed rule"}`;
      }
      preparedRules.push({
        rule,
        canonicalPath: "",
        normalizedForCompare: "",
        failed: true,
        error: String(err?.message || err),
      });
    }
  }

  return {
    preparedRules,
    candidates,
    hasFailedProtectedRule,
    failedProtectedRuleReason,
  };
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
  if (!rule || typeof rule.path !== "string" || rule.path.trim() === "") {
    throw new Error(`Invalid protected path rule: ${JSON.stringify(rule)}`);
  }
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

  if (options.preparedContext) {
    if (options.preparedContext.hasFailedProtectedRule) {
      return {
        allowed: false,
        code: "FOLDER_PROTECTED_PATH",
        reason:
          options.preparedContext.failedProtectedRuleReason ||
          "Protected path policy evaluation failed closed due to malformed or inaccessible rule.",
        canonicalPath,
      };
    }

    const targetCmp = normalizeForCompare(canonicalPath);
    for (const prep of options.preparedContext.preparedRules) {
      if (prep.failed) {
        return {
          allowed: false,
          code: "FOLDER_PROTECTED_PATH",
          reason: `Protected path rule preparation failed: ${prep.rule.label || prep.rule.path}`,
          canonicalPath,
        };
      }

      const blocked =
        prep.rule.kind === "tree"
          ? isInsideOrEqualPrecomputed(prep.normalizedForCompare, targetCmp)
          : prep.normalizedForCompare === targetCmp;

      if (blocked) {
        return {
          allowed: false,
          code: "FOLDER_PROTECTED_PATH",
          reason: `Path is protected by WinHelm security policy: ${prep.rule.label || prep.rule.path}`,
          canonicalPath,
        };
      }
    }

    const matched = options.preparedContext.candidates.find((c) =>
      isInsideOrEqualPrecomputed(c.normalizedRootForCompare, targetCmp)
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
      matched.normalizedRootForCompare === targetCmp
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
    } catch (err: any) {
      // A malformed or inaccessible protected rule must fail closed.
      return {
        allowed: false,
        code: "FOLDER_PROTECTED_PATH",
        reason: `Failed to evaluate protected path rule: ${protectedRule.label || protectedRule.path}`,
        canonicalPath,
      };
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
