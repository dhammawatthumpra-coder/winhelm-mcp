import os from "node:os";
import path from "node:path";
import type { ProtectedPathRule } from "./folder-access.js";

export interface ProtectedPathBuildOptions {
  configFilePath?: string;
  dataDir?: string;
  logDir?: string;
  installRoot?: string;
}

function keyFor(rule: ProtectedPathRule): string {
  const normalized = path.resolve(rule.path);
  const comparable = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return `${rule.kind}:${comparable}`;
}

/**
 * Construct protected-path rules without guessing an installation root.
 * Callers should pass installRoot from a trustworthy application/package
 * identity rather than using the user's current working directory implicitly.
 */
export function buildProtectedPathRules(
  options: ProtectedPathBuildOptions = {}
): ProtectedPathRule[] {
  const rules: ProtectedPathRule[] = [];

  if (options.configFilePath) {
    rules.push({
      path: path.resolve(options.configFilePath),
      kind: "file",
      label: "WinHelm configuration file",
    });
  }

  rules.push({
    path: path.resolve(options.dataDir ?? path.join(os.homedir(), ".winhelm")),
    kind: "tree",
    label: "WinHelm data directory",
  });

  if (options.logDir) {
    rules.push({
      path: path.resolve(options.logDir),
      kind: "tree",
      label: "WinHelm log directory",
    });
  }

  if (options.installRoot) {
    rules.push({
      path: path.resolve(options.installRoot),
      kind: "tree",
      label: "WinHelm installation directory",
    });
  }

  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = keyFor(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
