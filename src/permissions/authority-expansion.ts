import path from "node:path";
import type { SchemaV2PermissionConfig } from "../config/schema-v2.js";

export interface AuthorityExpansionAssessment {
  expandsAuthority: boolean;
  reasons: string[];
}

function comparablePath(value: string): string {
  const resolved = path.normalize(path.resolve(value.normalize("NFKC")));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function terminalCapabilityRank(
  mode: SchemaV2PermissionConfig["terminal"]["mode"]
): number {
  switch (mode) {
    case "off":
      return 0;
    case "safe":
      return 1;
    case "ask":
    case "full":
      return 2;
    case "dangerous":
      // dangerous is currently Absolute Deny; keep it above full so any future
      // attempt to select it is conservatively treated as an expansion too.
      return 3;
  }
}

/**
 * Detect capability-envelope expansion only. Approval Mode is intentionally
 * excluded because it is a separate product axis.
 */
export function assessAuthorityExpansion(
  current: SchemaV2PermissionConfig,
  candidate: SchemaV2PermissionConfig
): AuthorityExpansionAssessment {
  const reasons: string[] = [];
  const currentFolders = new Map(
    current.folders.map((folder) => [comparablePath(folder.path), folder])
  );

  for (const folder of candidate.folders) {
    const previous = currentFolders.get(comparablePath(folder.path));
    if (!previous) {
      reasons.push(`adds folder authority: ${folder.path}`);
      continue;
    }
    if (
      previous.permission === "read" &&
      folder.permission === "readwrite"
    ) {
      reasons.push(`expands folder to readwrite: ${folder.path}`);
    }
  }

  for (const [toolName, nextPolicy] of Object.entries(candidate.toolPolicy)) {
    const previous = current.toolPolicy[toolName];
    if (
      (previous === undefined || previous === "off") &&
      nextPolicy !== "off"
    ) {
      reasons.push(`enables tool capability: ${toolName}`);
    }
  }

  if (
    terminalCapabilityRank(candidate.terminal.mode) >
    terminalCapabilityRank(current.terminal.mode)
  ) {
    reasons.push(
      `expands terminal capability: ${current.terminal.mode} -> ${candidate.terminal.mode}`
    );
  }

  return {
    expandsAuthority: reasons.length > 0,
    reasons,
  };
}
