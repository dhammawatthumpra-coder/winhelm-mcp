export const SCHEMA_V2 = 2 as const;

export type SchemaVersion = typeof SCHEMA_V2;
export type FolderPermissionMode = "read" | "readwrite";
export type TerminalMode = "off" | "safe" | "ask" | "full" | "dangerous";
export type ToolPolicy = "auto" | "ask" | "off";
export type ApprovalChannel = "dashboard" | "toast" | "cli";
export type UiLanguage = "en" | "th";
export type ProfilePreset =
  | "safe"
  | "balanced"
  | "power"
  | "minimal"
  | "core"
  | "dev"
  | "sysadmin"
  | "full";

export interface FolderPermission {
  path: string;
  alias?: string;
  permission: FolderPermissionMode;
}

export interface TerminalPermissionConfig {
  mode: TerminalMode;
  approvalTtlSeconds?: number;
  dangerousExpiresMinutes?: number;
}

export interface ApprovalConfig {
  channels: ApprovalChannel[];
  blockHoldMs: number;
  jobTtlMs: number;
  maxPending: number;
}

export interface NetworkPermissionConfig {
  allowLoopback: boolean;
}

export interface UiConfig {
  language: UiLanguage;
}

export interface ProfileState {
  preset: ProfilePreset;
  appliedAt: string;
  appliedSnapshot: {
    folders: FolderPermission[];
    terminal: TerminalPermissionConfig;
    toolPolicy: Record<string, ToolPolicy>;
  };
  appliedFingerprint?: string;
}

export interface SchemaV2PermissionConfig {
  schemaVersion: SchemaVersion;
  profilePreset?: ProfilePreset;
  folders: FolderPermission[];
  terminal: TerminalPermissionConfig;
  toolPolicy: Record<string, ToolPolicy>;
  approval: ApprovalConfig;
  network: NetworkPermissionConfig;
  ui?: UiConfig;
  profileState?: ProfileState;
}

export const DEFAULT_NETWORK_CONFIG: Readonly<NetworkPermissionConfig> = Object.freeze({
  allowLoopback: false,
});

export const DEFAULT_APPROVAL_CONFIG: Readonly<ApprovalConfig> = Object.freeze({
  channels: Object.freeze(["dashboard", "toast"]) as unknown as ApprovalChannel[],
  blockHoldMs: 60_000,
  jobTtlMs: 180_000,
  maxPending: 5,
});

export type ConfigMode = "legacy" | "v2" | "invalid";

export interface ApprovalValidationResult {
  valid: boolean;
  errors: string[];
  value: ApprovalConfig;
}

export interface SchemaV2ValidationResult {
  valid: boolean;
  errors: string[];
  value: SchemaV2PermissionConfig;
}

const PROFILE_PRESETS = new Set<ProfilePreset>([
  "safe",
  "balanced",
  "power",
  "minimal",
  "core",
  "dev",
  "sysadmin",
  "full",
]);

const TERMINAL_MODES = new Set<TerminalMode>([
  "off",
  "safe",
  "ask",
  "full",
  "dangerous",
]);

const TOOL_POLICIES = new Set<ToolPolicy>(["auto", "ask", "off"]);
const APPROVAL_CHANNELS = new Set<ApprovalChannel>(["dashboard", "toast", "cli"]);

/**
 * Config mode is explicit:
 * - no schemaVersion => v1.2.1 legacy compatibility
 * - schemaVersion === 2 => schema-v2 (subject to semantic validation)
 * - any other explicit schemaVersion => invalid/fail-closed
 */
export function detectConfigMode(config: { schemaVersion?: unknown }): ConfigMode {
  if (!Object.prototype.hasOwnProperty.call(config, "schemaVersion")) return "legacy";
  return config.schemaVersion === SCHEMA_V2 ? "v2" : "invalid";
}

export function isSchemaV2Config(config: { schemaVersion?: unknown }): boolean {
  return detectConfigMode(config) === "v2";
}

export function normalizeApprovalConfig(
  approval?: Partial<ApprovalConfig> | null
): ApprovalConfig {
  return {
    channels: approval?.channels
      ? [...approval.channels]
      : [...DEFAULT_APPROVAL_CONFIG.channels],
    blockHoldMs: approval?.blockHoldMs ?? DEFAULT_APPROVAL_CONFIG.blockHoldMs,
    jobTtlMs: approval?.jobTtlMs ?? DEFAULT_APPROVAL_CONFIG.jobTtlMs,
    maxPending: approval?.maxPending ?? DEFAULT_APPROVAL_CONFIG.maxPending,
  };
}

export function validateApprovalConfig(
  approval?: Partial<ApprovalConfig> | null
): ApprovalValidationResult {
  const value = normalizeApprovalConfig(approval);
  const errors: string[] = [];

  if (
    !Array.isArray(value.channels) ||
    value.channels.length === 0 ||
    value.channels.some((channel) => !APPROVAL_CHANNELS.has(channel))
  ) {
    errors.push("approval.channels must contain only dashboard, toast, or cli");
  }

  if (!Number.isInteger(value.blockHoldMs) || value.blockHoldMs < 1_000 || value.blockHoldMs > 90_000) {
    errors.push("approval.blockHoldMs must be an integer between 1000 and 90000 ms");
  }

  if (!Number.isInteger(value.jobTtlMs) || value.jobTtlMs < 30_000 || value.jobTtlMs > 600_000) {
    errors.push("approval.jobTtlMs must be an integer between 30000 and 600000 ms");
  }

  if (!Number.isInteger(value.maxPending) || value.maxPending < 1 || value.maxPending > 100) {
    errors.push("approval.maxPending must be an integer between 1 and 100");
  }

  return { valid: errors.length === 0, errors, value };
}

function validateFolders(input: unknown, errors: string[]): FolderPermission[] {
  if (!Array.isArray(input)) {
    errors.push("folders must be an array");
    return [];
  }

  const folders: FolderPermission[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== "object") {
      errors.push(`folders[${i}] must be an object`);
      continue;
    }

    const item = raw as Record<string, unknown>;
    const folderPath = typeof item.path === "string" ? item.path.trim() : "";
    const permission = item.permission;

    if (!folderPath) {
      errors.push(`folders[${i}].path must be a non-empty string`);
      continue;
    }
    if (permission !== "read" && permission !== "readwrite") {
      errors.push(`folders[${i}].permission must be read or readwrite`);
      continue;
    }
    if (item.alias !== undefined && (typeof item.alias !== "string" || item.alias.trim() === "")) {
      errors.push(`folders[${i}].alias must be a non-empty string when provided`);
      continue;
    }

    folders.push({
      path: folderPath,
      ...(typeof item.alias === "string" ? { alias: item.alias.trim() } : {}),
      permission,
    });
  }

  return folders;
}

function validateTerminal(input: unknown, errors: string[]): TerminalPermissionConfig {
  if (!input || typeof input !== "object") {
    errors.push("terminal must be an object");
    return { mode: "off" };
  }

  const raw = input as Record<string, unknown>;
  const mode = raw.mode;
  if (typeof mode !== "string" || !TERMINAL_MODES.has(mode as TerminalMode)) {
    errors.push("terminal.mode must be one of off, safe, ask, full, dangerous");
    return { mode: "off" };
  }

  const terminal: TerminalPermissionConfig = { mode: mode as TerminalMode };

  if (raw.approvalTtlSeconds !== undefined) {
    if (
      !Number.isInteger(raw.approvalTtlSeconds) ||
      (raw.approvalTtlSeconds as number) < 30 ||
      (raw.approvalTtlSeconds as number) > 600
    ) {
      errors.push("terminal.approvalTtlSeconds must be an integer between 30 and 600");
    } else {
      terminal.approvalTtlSeconds = raw.approvalTtlSeconds as number;
    }
  }

  if (raw.dangerousExpiresMinutes !== undefined) {
    if (
      !Number.isInteger(raw.dangerousExpiresMinutes) ||
      (raw.dangerousExpiresMinutes as number) < 1 ||
      (raw.dangerousExpiresMinutes as number) > 480
    ) {
      errors.push("terminal.dangerousExpiresMinutes must be an integer between 1 and 480");
    } else {
      terminal.dangerousExpiresMinutes = raw.dangerousExpiresMinutes as number;
    }
  }

  return terminal;
}

function validateToolPolicy(input: unknown, errors: string[]): Record<string, ToolPolicy> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push("toolPolicy must be an object");
    return {};
  }

  const result: Record<string, ToolPolicy> = {};
  for (const [name, rawPolicy] of Object.entries(input as Record<string, unknown>)) {
    if (!name.trim()) {
      errors.push("toolPolicy keys must be non-empty");
      continue;
    }
    if (typeof rawPolicy !== "string" || !TOOL_POLICIES.has(rawPolicy as ToolPolicy)) {
      errors.push(`toolPolicy.${name} must be auto, ask, or off`);
      continue;
    }
    result[name] = rawPolicy as ToolPolicy;
  }
  return result;
}

/**
 * Validate only the governed schema-v2 permission surface.
 * Semantic errors return a fail-closed normalized value rather than silently
 * falling back to legacy semantics.
 */
export function validateSchemaV2Config(input: Record<string, unknown>): SchemaV2ValidationResult {
  const errors: string[] = [];

  if (input.schemaVersion !== SCHEMA_V2) {
    errors.push("schemaVersion must be 2");
  }

  let profilePreset: ProfilePreset | undefined;
  if (input.profilePreset !== undefined) {
    if (typeof input.profilePreset !== "string" || !PROFILE_PRESETS.has(input.profilePreset as ProfilePreset)) {
      errors.push("profilePreset must be one of safe, balanced, power, minimal, core, dev, sysadmin, full");
    } else {
      profilePreset = input.profilePreset as ProfilePreset;
    }
  }

  const folders = validateFolders(input.folders, errors);
  const terminal = validateTerminal(input.terminal, errors);
  const toolPolicy = validateToolPolicy(input.toolPolicy, errors);

  const rawApproval =
    input.approval && typeof input.approval === "object" && !Array.isArray(input.approval)
      ? (input.approval as Partial<ApprovalConfig>)
      : input.approval === undefined
        ? undefined
        : null;

  if (input.approval !== undefined && rawApproval === null) {
    errors.push("approval must be an object");
  }
  const approvalResult = validateApprovalConfig(rawApproval ?? undefined);
  errors.push(...approvalResult.errors);

  let network: NetworkPermissionConfig = { ...DEFAULT_NETWORK_CONFIG };
  if (input.network !== undefined) {
    if (!input.network || typeof input.network !== "object" || Array.isArray(input.network)) {
      errors.push("network must be an object");
    } else {
      const rawNetwork = input.network as Record<string, unknown>;
      if (
        rawNetwork.allowLoopback !== undefined &&
        typeof rawNetwork.allowLoopback !== "boolean"
      ) {
        errors.push("network.allowLoopback must be boolean");
      } else if (typeof rawNetwork.allowLoopback === "boolean") {
        network = { allowLoopback: rawNetwork.allowLoopback };
      }
    }
  }

  let ui: UiConfig | undefined;
  if (input.ui !== undefined) {
    if (!input.ui || typeof input.ui !== "object" || Array.isArray(input.ui)) {
      ui = { language: "en" };
    } else {
      const rawUi = input.ui as Record<string, unknown>;
      ui = {
        language: rawUi.language === "th" ? "th" : "en",
      };
    }
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    value: {
      schemaVersion: SCHEMA_V2,
      ...(profilePreset ? { profilePreset } : {}),
      folders: valid ? folders : [],
      terminal: valid ? terminal : { mode: "off" },
      toolPolicy: valid ? toolPolicy : {},
      approval: approvalResult.value,
      network: valid ? network : { ...DEFAULT_NETWORK_CONFIG },
      ...(ui ? { ui } : {}),
      ...(valid && input.profileState && typeof input.profileState === "object"
        ? { profileState: input.profileState as unknown as ProfileState }
        : {}),
    },
  };
}
