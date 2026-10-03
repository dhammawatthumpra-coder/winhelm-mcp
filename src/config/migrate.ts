import path from "node:path";
import type { ServerConfig } from "../types/index.js";
import {
  buildPresetConfig,
  R5_TOOLS,
} from "../permissions/presets.js";
import {
  fingerprintGovernedState,
} from "../permissions/profile-state.js";
import {
  getToolMetadata,
} from "../tools/metadata.js";
import {
  ALL_TOOL_NAMES,
} from "../tools/registry.js";
import {
  resolveCustomTools,
  type ToolProfile,
} from "./profiles.js";
import type {
  ProfilePreset,
  SchemaV2PermissionConfig,
  ToolPolicy,
} from "./schema-v2.js";
import { isWildcardAllowAll } from "./config-manager.js";

export type LegacyMigrationStatus =
  | "ready"
  | "folder-selection-required"
  | "not-legacy";

export interface LegacyMigrationProposal {
  status: LegacyMigrationStatus;
  sourceProfile: ToolProfile | null;
  suggestedPreset: ProfilePreset | null;
  candidate: SchemaV2PermissionConfig | null;
  warnings: string[];
  notes: string[];
}

const LEGACY_NAMED_PRESETS = new Set<ProfilePreset>([
  "minimal",
  "core",
  "dev",
  "sysadmin",
  "full",
]);

function autoAlias(folderPath: string): string {
  const base = path.basename(path.resolve(folderPath));
  return base || path.resolve(folderPath);
}

function isNamedLegacyPreset(value: string): value is ProfilePreset {
  return LEGACY_NAMED_PRESETS.has(value as ProfilePreset);
}

function selectedLegacyTools(config: ServerConfig): Set<string> | null {
  if (!config.customTools || config.customTools.length === 0) {
    return null;
  }

  const baseProfile: ToolProfile = config.profile ?? "full";
  const resolved =
    resolveCustomTools(
      baseProfile,
      undefined,
      config.customTools
    ) ?? [];

  return new Set(resolved);
}

function applyCustomToolPolicy(
  candidate: SchemaV2PermissionConfig,
  selected: Set<string>
): void {
  const policy: Record<string, ToolPolicy> = {};

  for (const tool of ALL_TOOL_NAMES) {
    if (R5_TOOLS.has(tool)) continue;
    policy[tool] = selected.has(tool) ? "auto" : "off";
  }

  policy.winhelm_status = "auto";
  policy.winhelm_job_status = "auto";
  candidate.toolPolicy = policy;
}

function applyReadOnlyReduction(
  candidate: SchemaV2PermissionConfig
): void {
  candidate.folders = candidate.folders.map((folder) => ({
    ...folder,
    permission: "read",
  }));
  candidate.terminal = { mode: "off" };

  for (const tool of Object.keys(candidate.toolPolicy)) {
    if (!ALL_TOOL_NAMES.includes(tool as any)) continue;
    if (getToolMetadata(tool).annotations.destructiveHint) {
      candidate.toolPolicy[tool] = "off";
    }
  }
}

function setAliasedFolders(
  candidate: SchemaV2PermissionConfig,
  paths: string[]
): void {
  candidate.folders = candidate.folders.map((folder, index) => ({
    ...folder,
    alias: autoAlias(paths[index] ?? folder.path),
  }));

  if (candidate.profileState) {
    candidate.profileState.appliedSnapshot.folders =
      candidate.folders.map((folder) => ({ ...folder }));
  }
}

function normalizeAppliedFingerprint(
  candidate: SchemaV2PermissionConfig
): void {
  if (!candidate.profileState) return;
  candidate.profileState.appliedFingerprint =
    fingerprintGovernedState(
      candidate.profileState.appliedSnapshot
    );
}

function customTerminalMode(
  selected: Set<string>,
  readOnly: boolean
): SchemaV2PermissionConfig["terminal"]["mode"] {
  if (readOnly) return "off";
  for (const tool of selected) {
    if (R5_TOOLS.has(tool)) return "ask";
  }
  return "off";
}

/**
 * Pure legacy -> schema-v2 migration proposal.
 *
 * This function never persists changes. The wizard/admin plane must show the
 * proposal and obtain explicit user confirmation before writing it.
 */
export function proposeLegacyMigration(
  config: Readonly<ServerConfig>,
  now = new Date().toISOString(),
  explicitFolders?: string[]
): LegacyMigrationProposal {
  if (config.schemaVersion !== undefined) {
    return {
      status: "not-legacy",
      sourceProfile: null,
      suggestedPreset: null,
      candidate: null,
      warnings: [],
      notes: [
        "Migration proposal is only available for legacy configs without schemaVersion.",
      ],
    };
  }

  const sourceProfile: ToolProfile = config.profile ?? "full";
  const originalDirectories = [...(config.allowedDirectories ?? [])];
  const legacyDirectories =
    explicitFolders !== undefined
      ? [...explicitFolders]
      : originalDirectories;

  if (
    isWildcardAllowAll(legacyDirectories) ||
    (explicitFolders === undefined &&
      isWildcardAllowAll(originalDirectories))
  ) {
    return {
      status: "folder-selection-required",
      sourceProfile,
      suggestedPreset:
        isNamedLegacyPreset(sourceProfile)
          ? sourceProfile
          : null,
      candidate: null,
      warnings: [
        "Legacy allowedDirectories=[\"*\"] is not migrated automatically.",
      ],
      notes: [
        "Choose explicit folders in the wizard before creating schema-v2 permissions.",
      ],
    };
  }

  const selected = selectedLegacyTools(config);
  const namedPreset = isNamedLegacyPreset(sourceProfile)
    ? sourceProfile
    : null;
  const suggestedPreset: ProfilePreset | null =
    namedPreset ?? (selected ? null : "balanced");

  let candidate: SchemaV2PermissionConfig;

  if (namedPreset) {
    candidate = buildPresetConfig(namedPreset, {
      folders: legacyDirectories,
      now,
    });
  } else {
    // Legacy Custom does not become a named reusable Custom Profile in v1.3.
    // Build a neutral baseline without exposing that baseline as the migrated
    // profile identity.
    candidate = buildPresetConfig("balanced", {
      folders: legacyDirectories,
      now,
    });
    delete candidate.profilePreset;
    delete candidate.profileState;
  }

  setAliasedFolders(candidate, legacyDirectories);

  const warnings: string[] = [];
  const notes: string[] = [];

  if (
    explicitFolders !== undefined &&
    isWildcardAllowAll(originalDirectories)
  ) {
    warnings.push(
      "Explicit folder selection replaces legacy wildcard access; wildcard access is not carried into schema-v2."
    );
  }

  if (selected) {
    applyCustomToolPolicy(candidate, selected);
    candidate.terminal = {
      mode: customTerminalMode(
        selected,
        config.readOnly === true
      ),
    };
    warnings.push(
      "Legacy customTools are migrated as explicit toolPolicy state; v1.3 does not create a named Custom Profile."
    );
  } else if (candidate.terminal.mode === "full") {
    candidate.terminal = { mode: "ask" };
    warnings.push(
      "Legacy profile migration never enables terminal full automatically; terminal is proposed as ask."
    );
  }

  if (config.readOnly === true) {
    applyReadOnlyReduction(candidate);
    warnings.push(
      "Legacy readOnly=true is migrated conservatively: folders become read-only, terminal is off, and destructive tools are disabled."
    );
  }

  if (candidate.profileState) {
    // Preserve the original preset snapshot as the comparison baseline.
    // Any conservative migration overrides above intentionally show as
    // Modified from that preset rather than silently redefining the preset.
    normalizeAppliedFingerprint(candidate);
  }

  if (legacyDirectories.length === 0) {
    notes.push(
      "Legacy allowedDirectories=[] maps to folders=[] and remains fail-closed."
    );
  } else {
    notes.push(
      "Legacy allowedDirectories paths map to explicit aliased schema-v2 folders."
    );
  }

  if (namedPreset) {
    notes.push(
      "Legacy profile " +
        namedPreset +
        " maps to profilePreset=" +
        namedPreset +
        "; permission differences remain visible as Modified."
    );
  }

  return {
    status: "ready",
    sourceProfile,
    suggestedPreset,
    candidate,
    warnings,
    notes,
  };
}
