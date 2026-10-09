import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import {
  assertValidProtectedRuleKind,
  canonicalizeExistingAwarePath,
  normalizePathForCompare,
  type ProtectedPathRule,
} from "./folder-access.js";

/**
 * Filesystem object identifier backed by exact BigInt dev and ino.
 * On Windows NTFS:
 * - dev is the volume serial number / device number.
 * - ino is the 64-bit file index / MFT record identifier.
 * Both are preserved as BigInt and formatted losslessly without Number conversion.
 */
export interface FilesystemObjectId {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly key: string;
}

/**
 * Losslessly format dev and ino into a unique object identifier string.
 */
export function formatObjectId(dev: bigint, ino: bigint): string {
  return `${dev.toString()}:${ino.toString()}`;
}

/**
 * Resolve the filesystem object identity of a path using lstatSync with bigint: true.
 * Returns null if the path does not exist or is inaccessible.
 */
export function getFilesystemObjectId(
  targetPath: string
): FilesystemObjectId | null {
  try {
    const stat = lstatSync(targetPath, { bigint: true });
    const isSymbolicLink = stat.isSymbolicLink();
    const isFile = !isSymbolicLink && stat.isFile();
    const isDirectory = !isSymbolicLink && stat.isDirectory();
    const key = formatObjectId(stat.dev, stat.ino);
    return {
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink,
      isFile,
      isDirectory,
      isSymbolicLink,
      key,
    };
  } catch {
    return null;
  }
}

export interface ProtectedObjectMatch {
  readonly matched: boolean;
  readonly rule?: ProtectedPathRule;
  readonly sourcePath?: string;
  readonly reason?: string;
}

interface ProtectedFileEntry {
  readonly key: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly rule: ProtectedPathRule;
  readonly canonicalPath: string;
  nlink: bigint;
}

interface ProtectedTreeEntry {
  readonly rule: ProtectedPathRule;
  readonly canonicalRoot: string;
  readonly dev: bigint;
}

/**
 * Central registry of protected filesystem object identities.
 * Enforces identity equivalence across hardlink aliases for:
 * 1. Protected file rules (kind: "file")
 * 2. Files contained within protected tree rules (kind: "tree")
 */
export class ProtectedObjectRegistry {
  private readonly protectedFiles = new Map<string, ProtectedFileEntry>();
  private readonly protectedTrees: ProtectedTreeEntry[] = [];
  private readonly treeFileObjectKeys = new Map<
    string,
    { rule: ProtectedPathRule; sourcePath: string; dev: bigint }
  >();
  private _hasAnyLinkedProtectedObjects = false;
  private readonly rules: ProtectedPathRule[];

  constructor(rules: ProtectedPathRule[] = []) {
    this.rules = rules;
    this.build();
  }

  /**
   * True if any protected file or file in a protected tree currently has nlink > 1.
   * If false, no hardlink alias can physically exist anywhere on the filesystem,
   * allowing search traversal to take the optimal fast path.
   */
  public get hasAnyLinkedProtectedObjects(): boolean {
    return this._hasAnyLinkedProtectedObjects;
  }

  /**
   * Re-scan protected rules to discover object IDs and link counts.
   */
  public build(): void {
    this.protectedFiles.clear();
    this.protectedTrees.length = 0;
    this.treeFileObjectKeys.clear();
    this._hasAnyLinkedProtectedObjects = false;

    for (const rule of this.rules) {
      assertValidProtectedRuleKind(rule);

      let canonical: string;
      try {
        canonical = canonicalizeExistingAwarePath(rule.path);
      } catch {
        continue;
      }

      if (rule.kind === "file") {
        const id = getFilesystemObjectId(canonical);
        if (id && id.isFile) {
          this.protectedFiles.set(id.key, {
            key: id.key,
            dev: id.dev,
            ino: id.ino,
            rule,
            canonicalPath: canonical,
            nlink: id.nlink,
          });
          if (id.nlink > 1n) {
            this._hasAnyLinkedProtectedObjects = true;
          }
        }
      } else if (rule.kind === "tree") {
        const dirId = getFilesystemObjectId(canonical);
        if (dirId && dirId.isDirectory) {
          this.protectedTrees.push({
            rule,
            canonicalRoot: canonical,
            dev: dirId.dev,
          });
          this.scanTree(canonical, rule);
        }
      }
    }
  }

  private scanTree(treeRoot: string, rule: ProtectedPathRule): void {
    const walk = (currentDir: string): void => {
      let entries;
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const id = getFilesystemObjectId(full);
          if (id && id.isFile) {
            this.treeFileObjectKeys.set(id.key, {
              rule,
              sourcePath: full,
              dev: id.dev,
            });
            if (id.nlink > 1n) {
              this._hasAnyLinkedProtectedObjects = true;
            }
          }
        }
      }
    };
    walk(treeRoot);
  }

  /**
   * Check whether a target path is a filesystem object alias (hardlink) to
   * any protected file or to any file inside a protected tree.
   *
   * Fast-paths:
   * - Target does not exist or is not a regular file -> false
   * - Target nlink <= 1 -> provably has no aliases anywhere -> false
   * - No protected rules or no protected objects -> false
   */
  public checkFileObjectId(
    targetPath: string,
    targetStat?: FilesystemObjectId | null
  ): ProtectedObjectMatch {
    const stat =
      targetStat !== undefined ? targetStat : getFilesystemObjectId(targetPath);
    if (!stat || !stat.isFile) {
      return { matched: false };
    }

    // Fast-path: if nlink <= 1, this file object has exactly 1 directory entry.
    // It is mathematically impossible for it to be an alias of another file.
    if (stat.nlink <= 1n) {
      return { matched: false };
    }

    // 1. Direct match with protected file rules
    const fileMatch = this.protectedFiles.get(stat.key);
    if (fileMatch) {
      return {
        matched: true,
        rule: fileMatch.rule,
        sourcePath: fileMatch.canonicalPath,
        reason: `Path is a filesystem hardlink alias to protected file: ${fileMatch.rule.label || fileMatch.rule.path}`,
      };
    }

    // 2. Match with files in protected tree rules
    const treeMatch = this.treeFileObjectKeys.get(stat.key);
    if (treeMatch) {
      return {
        matched: true,
        rule: treeMatch.rule,
        sourcePath: treeMatch.sourcePath,
        reason: `Path is a filesystem hardlink alias to a file inside protected tree: ${treeMatch.rule.label || treeMatch.rule.path}`,
      };
    }

    // 3. Fallback: if stat.nlink > 1n and we have protected trees on the same volume (dev),
    // check if a newly created file inside the protected tree matches.
    const relevantTrees = this.protectedTrees.filter((t) => t.dev === stat.dev);
    if (relevantTrees.length > 0) {
      for (const tree of relevantTrees) {
        this.scanTree(tree.canonicalRoot, tree.rule);
      }
      const refreshedMatch = this.treeFileObjectKeys.get(stat.key);
      if (refreshedMatch) {
        return {
          matched: true,
          rule: refreshedMatch.rule,
          sourcePath: refreshedMatch.sourcePath,
          reason: `Path is a filesystem hardlink alias to a file inside protected tree: ${refreshedMatch.rule.label || refreshedMatch.rule.path}`,
        };
      }
    }

    return { matched: false };
  }
}

/**
 * Find all files inside a directory that are hardlink aliases to protected objects.
 * When hasAnyLinkedProtectedObjects is false, returns [] immediately without scanning.
 */
export function findHardlinkAliasesInDirectory(
  directory: string,
  registry: ProtectedObjectRegistry
): string[] {
  if (!registry.hasAnyLinkedProtectedObjects) {
    return [];
  }

  const aliases: string[] = [];
  const walk = (currentDir: string): void => {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const id = getFilesystemObjectId(full);
        if (id && id.isFile && id.nlink > 1n) {
          const match = registry.checkFileObjectId(full, id);
          if (match.matched) {
            aliases.push(full);
          }
        }
      }
    }
  };

  walk(directory);
  return aliases;
}

let cachedRegistry: ProtectedObjectRegistry | null = null;
let cachedRulesKey = "";

export function getProtectedObjectRegistry(
  rules: ProtectedPathRule[]
): ProtectedObjectRegistry {
  const key = rules.map((r) => `${r.kind}:${r.path}`).join(";");
  if (cachedRegistry && cachedRulesKey === key) {
    return cachedRegistry;
  }
  const reg = new ProtectedObjectRegistry(rules);
  cachedRegistry = reg;
  cachedRulesKey = key;
  return reg;
}

export function resetProtectedObjectRegistryCache(): void {
  cachedRegistry = null;
  cachedRulesKey = "";
}
