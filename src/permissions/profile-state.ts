import crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type {
  FolderPermission,
  TerminalPermissionConfig,
  ToolPolicy,
} from "../config/schema-v2.js";

export interface GovernedPermissionState {
  folders: FolderPermission[];
  terminal: TerminalPermissionConfig;
  toolPolicy: Record<string, ToolPolicy>;
}

export interface CanonicalGovernedState {
  folders: Array<{
    path: string;
    alias?: string;
    permission: "read" | "readwrite";
  }>;
  terminal: {
    mode: TerminalPermissionConfig["mode"];
  };
  toolPolicy: Record<string, ToolPolicy>;
}

export type GovernedField = "folders" | "terminal.mode" | "toolPolicy";

export interface GovernedStateDiff {
  modified: boolean;
  fields: GovernedField[];
}

function canonicalPath(input: string): string {
  const normalized = input.normalize("NFKC");
  let resolved = path.resolve(normalized);

  try {
    if (existsSync(resolved)) {
      resolved = realpathSync(resolved);
    }
  } catch {
    // A diagnostic/profile comparison must remain deterministic even if a
    // configured folder temporarily disappears. Runtime access enforcement
    // performs the stricter existing-aware canonicalization separately.
  }

  resolved = path.normalize(resolved);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined;
  const trimmed = alias.normalize("NFKC").trim();
  return trimmed || undefined;
}

function canonicalFolders(
  folders: FolderPermission[]
): CanonicalGovernedState["folders"] {
  return folders
    .map((folder) => ({
      path: canonicalPath(folder.path),
      ...(canonicalAlias(folder.alias)
        ? { alias: canonicalAlias(folder.alias) }
        : {}),
      permission: folder.permission,
    }))
    .sort((a, b) => {
      const pathCompare = a.path.localeCompare(b.path);
      if (pathCompare !== 0) return pathCompare;
      const aliasCompare = (a.alias ?? "").localeCompare(b.alias ?? "");
      if (aliasCompare !== 0) return aliasCompare;
      return a.permission.localeCompare(b.permission);
    });
}

function canonicalToolPolicy(
  policy: Record<string, ToolPolicy>
): Record<string, ToolPolicy> {
  const result: Record<string, ToolPolicy> = {};
  for (const key of Object.keys(policy).sort()) {
    result[key] = policy[key];
  }
  return result;
}

/**
 * Canonical representation contains only the fields governed by Profile
 * Modified-state semantics. Approval/server/network/UI/secrets/runtime state
 * is intentionally absent.
 */
export function canonicalizeGovernedState(
  state: GovernedPermissionState
): CanonicalGovernedState {
  return {
    folders: canonicalFolders(state.folders),
    terminal: {
      mode: state.terminal.mode,
    },
    toolPolicy: canonicalToolPolicy(state.toolPolicy),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function diffGovernedState(
  appliedSnapshot: GovernedPermissionState,
  current: GovernedPermissionState
): GovernedStateDiff {
  const expected = canonicalizeGovernedState(appliedSnapshot);
  const actual = canonicalizeGovernedState(current);
  const fields: GovernedField[] = [];

  if (stableJson(expected.folders) !== stableJson(actual.folders)) {
    fields.push("folders");
  }
  if (expected.terminal.mode !== actual.terminal.mode) {
    fields.push("terminal.mode");
  }
  if (stableJson(expected.toolPolicy) !== stableJson(actual.toolPolicy)) {
    fields.push("toolPolicy");
  }

  return {
    modified: fields.length > 0,
    fields,
  };
}

export function isModifiedFromAppliedSnapshot(
  appliedSnapshot: GovernedPermissionState,
  current: GovernedPermissionState
): boolean {
  return diffGovernedState(appliedSnapshot, current).modified;
}

/**
 * Fingerprint is diagnostic/optimization only. The authoritative decision is
 * canonical field-by-field comparison through diffGovernedState().
 */
export function fingerprintGovernedState(
  state: GovernedPermissionState
): string {
  const canonical = canonicalizeGovernedState(state);
  return crypto
    .createHash("sha256")
    .update(stableJson(canonical), "utf8")
    .digest("hex");
}
