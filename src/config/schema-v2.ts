export const SCHEMA_V2 = 2 as const;

export type SchemaVersion = typeof SCHEMA_V2;
export type FolderPermissionMode = "read" | "readwrite";
export type TerminalMode = "off" | "safe" | "ask" | "full" | "dangerous";
export type ToolPolicy = "auto" | "ask" | "off";
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
}

export interface ApprovalConfig {
  blockHoldMs: number;
  jobTtlMs: number;
  maxPending: number;
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
  profileState?: ProfileState;
}

export const DEFAULT_APPROVAL_CONFIG: Readonly<ApprovalConfig> = Object.freeze({
  blockHoldMs: 60_000,
  jobTtlMs: 180_000,
  maxPending: 5,
});

export interface ApprovalValidationResult {
  valid: boolean;
  errors: string[];
  value: ApprovalConfig;
}

/**
 * Schema-v2 is opt-in. Legacy config files without schemaVersion remain on
 * the v1.2.1 compatibility path.
 */
export function isSchemaV2Config(config: { schemaVersion?: unknown }): boolean {
  return config.schemaVersion === SCHEMA_V2;
}

/**
 * Normalize optional approval settings without mutating the caller.
 * Validation remains explicit so callers can fail closed rather than silently
 * accepting unsafe values.
 */
export function normalizeApprovalConfig(
  approval?: Partial<ApprovalConfig> | null
): ApprovalConfig {
  return {
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
