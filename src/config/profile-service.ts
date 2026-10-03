import fs from "node:fs/promises";
import {
  existsSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerConfig } from "../types/index.js";
import { ConfigManager, isWildcardAllowAll } from "./config-manager.js";
import type {
  FolderPermission,
  ProfilePreset,
  SchemaV2PermissionConfig,
} from "./schema-v2.js";
import { buildPresetConfig } from "../permissions/presets.js";
import {
  proposeLegacyMigration,
  type LegacyMigrationProposal,
} from "./migrate.js";
import {
  diffGovernedState,
  fingerprintGovernedState,
  type GovernedPermissionState,
} from "../permissions/profile-state.js";

export interface ProfileFolderSelection {
  path: string;
  alias?: string;
}

export interface ProfileApplyInput {
  preset: ProfilePreset;
  folders?: ProfileFolderSelection[];
  confirmation?: string;
}

export interface ProfileStatus {
  schemaMode: ReturnType<ConfigManager["getConfigMode"]>;
  preset: ProfilePreset | null;
  modified: boolean | null;
  modifiedFields: string[];
  folders: FolderPermission[];
  terminalMode: string | null;
  toolPolicy: Record<string, string>;
  validationErrors: readonly string[];
}

export interface ProfilePreview {
  preset: ProfilePreset;
  folders: FolderPermission[];
  terminalMode: SchemaV2PermissionConfig["terminal"]["mode"];
  toolPolicy: Record<string, string>;
  changedFields: string[];
  requiresTypedConfirmation: boolean;
  legacyWildcardRequiresFolderSelection: boolean;
  warnings: string[];
}

export interface ProfileApplyResult {
  backupPath: string | null;
  status: ProfileStatus;
}

export interface LegacyMigrationInput {
  folders?: ProfileFolderSelection[];
}

export interface LegacyMigrationApplyResult {
  backupPath: string | null;
  proposal: LegacyMigrationProposal;
  status: ProfileStatus;
}

export class ProfileServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ProfileServiceError";
  }
}

const FULL_CONFIRMATIONS = new Set(["confirm", "ยืนยัน"]);

function normalizeComparable(input: string): string {
  const resolved = path.resolve(input.normalize("NFKC"));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(root: string, target: string): boolean {
  const rootCompare = normalizeComparable(root);
  const targetCompare = normalizeComparable(target);
  const relative = path.relative(rootCompare, targetCompare);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function systemProtectedRoots(): string[] {
  return [
    process.env.SystemRoot || "C:\\Windows",
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
}

export function validateWizardFolder(folderPath: string): string {
  const normalized = folderPath.normalize("NFKC").trim();
  if (!normalized || normalized === "*" || normalized.toLowerCase() === "all") {
    throw new ProfileServiceError(
      "WIZARD_FOLDER_BLOCKED",
      "Choose a specific folder; wildcard/all-drive access is not offered by the v1.3 wizard."
    );
  }

  const resolved = path.resolve(normalized);
  if (path.parse(resolved).root === resolved) {
    throw new ProfileServiceError(
      "WIZARD_FOLDER_BLOCKED",
      `Drive/filesystem root is not permitted in the wizard: ${resolved}`
    );
  }

  for (const protectedRoot of systemProtectedRoots()) {
    if (isInsideOrEqual(protectedRoot, resolved)) {
      throw new ProfileServiceError(
        "WIZARD_FOLDER_BLOCKED",
        `System folder is not permitted in the wizard: ${resolved}`
      );
    }
  }

  const home = path.resolve(os.homedir());
  if (normalizeComparable(home) === normalizeComparable(resolved)) {
    throw new ProfileServiceError(
      "WIZARD_FOLDER_BLOCKED",
      "The entire user-profile root is too broad for the wizard. Choose a project or document subfolder."
    );
  }

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new ProfileServiceError(
      "WIZARD_FOLDER_NOT_FOUND",
      `Folder does not exist or is not a directory: ${resolved}`
    );
  }

  return resolved;
}

function autoAlias(folderPath: string): string {
  const base = path.basename(folderPath);
  return base || folderPath;
}

function selectedFolders(
  manager: ConfigManager,
  input?: ProfileFolderSelection[]
): ProfileFolderSelection[] {
  if (input !== undefined) return input;

  const config = manager.getConfig();
  if (manager.getConfigMode() === "v2" && Array.isArray(config.folders)) {
    return config.folders.map((folder) => ({
      path: folder.path,
      ...(folder.alias ? { alias: folder.alias } : {}),
    }));
  }

  const legacy = config.allowedDirectories ?? [];
  if (isWildcardAllowAll(legacy)) return [];

  return legacy.map((folderPath) => ({
    path: folderPath,
    alias: autoAlias(folderPath),
  }));
}

function buildCandidate(
  manager: ConfigManager,
  input: ProfileApplyInput
): SchemaV2PermissionConfig {
  const selection = selectedFolders(manager, input.folders);
  const seen = new Set<string>();
  const normalizedSelection = selection.map((folder) => {
    const resolved = validateWizardFolder(folder.path);
    const compare = normalizeComparable(resolved);
    if (seen.has(compare)) {
      throw new ProfileServiceError(
        "WIZARD_FOLDER_DUPLICATE",
        `Folder is selected more than once: ${resolved}`
      );
    }
    seen.add(compare);

    return {
      path: resolved,
      alias: folder.alias?.normalize("NFKC").trim() || autoAlias(resolved),
    };
  });

  const candidate = buildPresetConfig(input.preset, {
    folders: normalizedSelection.map((folder) => folder.path),
  });

  candidate.folders = candidate.folders.map((folder, index) => ({
    ...folder,
    alias: normalizedSelection[index]?.alias,
  }));

  if (candidate.profileState) {
    candidate.profileState.appliedSnapshot.folders =
      candidate.folders.map((folder) => ({ ...folder }));
    candidate.profileState.appliedSnapshot.terminal = {
      ...candidate.terminal,
    };
    candidate.profileState.appliedSnapshot.toolPolicy = {
      ...candidate.toolPolicy,
    };
    candidate.profileState.appliedFingerprint =
      fingerprintGovernedState(candidate);
  }

  return candidate;
}

function currentGovernedState(
  manager: ConfigManager
): GovernedPermissionState | undefined {
  if (manager.getConfigMode() !== "v2") return undefined;
  const config = manager.getConfig();
  if (!config.terminal || !config.toolPolicy || !config.folders) return undefined;

  return {
    folders: config.folders,
    terminal: config.terminal,
    toolPolicy: config.toolPolicy,
  };
}

function requiresTypedConfirmation(
  candidate: SchemaV2PermissionConfig
): boolean {
  return candidate.terminal.mode === "full" ||
    candidate.terminal.mode === "dangerous";
}

function confirmationValid(value: string | undefined): boolean {
  if (!value) return false;
  return FULL_CONFIRMATIONS.has(
    value.normalize("NFKC").trim().toLowerCase()
  );
}

export function getProfileStatus(
  manager = ConfigManager.getInstance()
): ProfileStatus {
  const config = manager.getConfig();
  const current = currentGovernedState(manager);
  let modified: boolean | null = null;
  let modifiedFields: string[] = [];

  if (current && config.profileState?.appliedSnapshot) {
    const diff = diffGovernedState(
      config.profileState.appliedSnapshot,
      current
    );
    modified = diff.modified;
    modifiedFields = diff.fields;
  }

  return {
    schemaMode: manager.getConfigMode(),
    preset: config.profilePreset ?? null,
    modified,
    modifiedFields,
    folders: (config.folders ?? []).map((folder) => ({ ...folder })),
    terminalMode: config.terminal?.mode ?? null,
    toolPolicy: { ...(config.toolPolicy ?? {}) },
    validationErrors: [...manager.getConfigValidationErrors()],
  };
}

export function previewProfileApplication(
  input: ProfileApplyInput,
  manager = ConfigManager.getInstance()
): ProfilePreview {
  const legacyWildcard =
    manager.getConfigMode() === "legacy" &&
    isWildcardAllowAll(manager.getConfig().allowedDirectories);
  const legacyWildcardRequiresFolderSelection =
    legacyWildcard && input.folders === undefined;

  if (legacyWildcardRequiresFolderSelection) {
    return {
      preset: input.preset,
      folders: [],
      terminalMode:
        input.preset === "power" || input.preset === "full"
          ? "full"
          : input.preset === "safe"
            ? "off"
            : "ask",
      toolPolicy: {},
      changedFields: ["folders", "terminal.mode", "toolPolicy"],
      requiresTypedConfirmation:
        input.preset === "power" || input.preset === "full",
      legacyWildcardRequiresFolderSelection: true,
      warnings: [
        'Legacy allowedDirectories=["*"] is not migrated automatically. Choose specific folders first.',
      ],
    };
  }

  const candidate = buildCandidate(manager, input);
  const current = currentGovernedState(manager);
  const changedFields = current
    ? diffGovernedState(current, candidate).fields
    : ["folders", "terminal.mode", "toolPolicy"];

  return {
    preset: input.preset,
    folders: candidate.folders.map((folder) => ({ ...folder })),
    terminalMode: candidate.terminal.mode,
    toolPolicy: { ...candidate.toolPolicy },
    changedFields,
    requiresTypedConfirmation: requiresTypedConfirmation(candidate),
    legacyWildcardRequiresFolderSelection,
    warnings: [],
  };
}

async function backupConfig(
  manager: ConfigManager
): Promise<string | null> {
  const source = manager.getConfigFilePath();
  if (!source || !existsSync(source)) return null;

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
  const backupPath = `${source}.backup-${stamp}`;
  await fs.copyFile(source, backupPath);
  return backupPath;
}

function normalizeMigrationCandidateFolders(
  proposal: LegacyMigrationProposal,
  input: LegacyMigrationInput
): LegacyMigrationProposal {
  if (!proposal.candidate) return proposal;

  const candidate = structuredClone(proposal.candidate);
  const aliases = input.folders ?? candidate.folders.map((folder) => ({
    path: folder.path,
    ...(folder.alias ? { alias: folder.alias } : {}),
  }));
  const seen = new Set<string>();

  candidate.folders = candidate.folders.map((folder, index) => {
    const selection = aliases[index] ?? { path: folder.path };
    const resolved = validateWizardFolder(selection.path);
    const compare = normalizeComparable(resolved);
    if (seen.has(compare)) {
      throw new ProfileServiceError(
        "WIZARD_FOLDER_DUPLICATE",
        `Folder is selected more than once: ${resolved}`
      );
    }
    seen.add(compare);

    return {
      ...folder,
      path: resolved,
      alias:
        selection.alias?.normalize("NFKC").trim() ||
        folder.alias ||
        autoAlias(resolved),
    };
  });

  if (candidate.profileState) {
    candidate.profileState.appliedSnapshot.folders =
      candidate.profileState.appliedSnapshot.folders.map(
        (folder, index) => ({
          ...folder,
          path: candidate.folders[index]?.path ?? folder.path,
          alias:
            candidate.folders[index]?.alias ??
            folder.alias,
        })
      );
    candidate.profileState.appliedFingerprint =
      fingerprintGovernedState(
        candidate.profileState.appliedSnapshot
      );
  }

  return {
    ...proposal,
    candidate,
  };
}

export function previewLegacyMigrationApplication(
  input: LegacyMigrationInput = {},
  manager = ConfigManager.getInstance()
): LegacyMigrationProposal {
  const explicitFolders = input.folders?.map((folder) => folder.path);
  const proposal = proposeLegacyMigration(
    manager.getConfig(),
    new Date().toISOString(),
    explicitFolders
  );

  if (!proposal.candidate) return proposal;
  return normalizeMigrationCandidateFolders(proposal, input);
}

export async function applyLegacyMigrationApplication(
  input: LegacyMigrationInput = {},
  manager = ConfigManager.getInstance()
): Promise<LegacyMigrationApplyResult> {
  const proposal = previewLegacyMigrationApplication(input, manager);

  if (proposal.status === "not-legacy") {
    throw new ProfileServiceError(
      "MIGRATION_NOT_AVAILABLE",
      "Legacy migration is only available while WinHelm is using a config without schemaVersion."
    );
  }

  if (
    proposal.status === "folder-selection-required" ||
    !proposal.candidate
  ) {
    throw new ProfileServiceError(
      "FOLDER_SELECTION_REQUIRED",
      "Legacy wildcard access cannot be migrated automatically. Select explicit folders first."
    );
  }

  const backupPath = await backupConfig(manager);

  try {
    await manager.updateConfig(
      proposal.candidate as unknown as Partial<ServerConfig>,
      true
    );
  } catch (err) {
    if (backupPath && existsSync(backupPath)) {
      await fs
        .copyFile(backupPath, manager.getConfigFilePath())
        .catch(() => {});
      await manager
        .init(manager.getConfigFilePath())
        .catch(() => {});
    }
    throw new ProfileServiceError(
      "CONFIG_PERSIST_FAILED",
      `Failed to persist migrated configuration: ${(err as Error).message}`
    );
  }

  if (manager.getConfigMode() !== "v2") {
    throw new ProfileServiceError(
      "CONFIG_PERSIST_FAILED",
      "Legacy migration did not produce a valid schema-v2 configuration."
    );
  }

  return {
    backupPath,
    proposal,
    status: getProfileStatus(manager),
  };
}

export async function applyProfilePreset(
  input: ProfileApplyInput,
  manager = ConfigManager.getInstance()
): Promise<ProfileApplyResult> {
  const preview = previewProfileApplication(input, manager);

  if (preview.legacyWildcardRequiresFolderSelection) {
    throw new ProfileServiceError(
      "FOLDER_SELECTION_REQUIRED",
      'Legacy allowedDirectories=["*"] cannot be migrated automatically. Select specific folders first.'
    );
  }

  const candidate = buildCandidate(manager, input);
  if (
    requiresTypedConfirmation(candidate) &&
    !confirmationValid(input.confirmation)
  ) {
    throw new ProfileServiceError(
      "TYPED_CONFIRMATION_REQUIRED",
      'Type "confirm" (or "ยืนยัน" in Thai UI) locally before enabling terminal full.'
    );
  }

  const backupPath = await backupConfig(manager);

  try {
    await manager.updateConfig(
      candidate as unknown as Partial<ServerConfig>,
      true
    );
  } catch (err) {
    if (backupPath && existsSync(backupPath)) {
      await fs.copyFile(backupPath, manager.getConfigFilePath()).catch(() => {});
      await manager.init(manager.getConfigFilePath()).catch(() => {});
    }
    throw new ProfileServiceError(
      "CONFIG_PERSIST_FAILED",
      `Failed to persist profile configuration: ${(err as Error).message}`
    );
  }

  if (manager.getConfigMode() !== "v2") {
    throw new ProfileServiceError(
      "CONFIG_PERSIST_FAILED",
      "Profile application did not produce a valid schema-v2 configuration."
    );
  }

  return {
    backupPath,
    status: getProfileStatus(manager),
  };
}
