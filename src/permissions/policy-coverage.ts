/**
 * Policy Coverage & Deterministic Backfill Service for WinHelm v1.4
 * Single Source of Truth for tool-policy coverage inspection, normalization,
 * and profile-consistent backfill of registered public MCP tools.
 */
import { ALL_V14_TOOL_NAMES } from "../tools/registry.js";
import type {
  ProfilePreset,
  SchemaV2PermissionConfig,
  ToolPolicy,
} from "../config/schema-v2.js";
import { R5_TOOLS, buildToolPolicyForPreset } from "./presets.js";

export type PolicyCoverageStatus = "complete" | "backfilled" | "incomplete";

export interface PolicyCoverageReport {
  readonly registered_public_tool_count: number;
  readonly policy_covered_public_tool_count: number;
  readonly missing_policy_tools: string[];
  readonly explicit_policy_tools: string[];
  readonly backfilled_policy_tools: string[];
  readonly separately_governed_terminal_tools: string[];
  readonly unresolved_missing_tools: string[];
  readonly profilePreset: ProfilePreset | null;
  readonly status: PolicyCoverageStatus;
}

export interface PolicyCoverageOptions {
  registeredToolNames?: readonly string[];
  rawToolPolicy?: Record<string, unknown>;
}

export interface PolicyNormalizationResult {
  normalizedPolicy: Record<string, ToolPolicy>;
  coverage: PolicyCoverageReport;
}

function isKnownProductPreset(preset: string | null | undefined): preset is "safe" | "balanced" | "power" {
  return preset === "safe" || preset === "balanced" || preset === "power";
}

function isKnownLegacyPreset(preset: string | null | undefined): preset is "minimal" | "core" | "dev" | "sysadmin" | "full" {
  return (
    preset === "minimal" ||
    preset === "core" ||
    preset === "dev" ||
    preset === "sysadmin" ||
    preset === "full"
  );
}

export function isKnownPreset(preset: string | null | undefined): preset is ProfilePreset {
  return isKnownProductPreset(preset) || isKnownLegacyPreset(preset);
}

/**
 * Deterministically normalize tool policy by backfilling missing registered tools
 * based on active profile semantics without weakening existing explicit policies.
 *
 * Rules:
 * 1. Explicit existing toolPolicy entries MUST be preserved.
 * 2. Missing entries synthesized only from known profile/preset semantics.
 * 3. Explicit 'off' stays 'off'; explicit 'ask' stays 'ask'.
 * 4. Unknown/legacy profile missing entries remain fail-closed (or follow accepted rule).
 * 5. Idempotent across multiple invocations.
 */
export function normalizeToolPolicyCoverage<T extends Partial<SchemaV2PermissionConfig> | Record<string, unknown>>(
  config: T,
  registeredToolNames: readonly string[] = ALL_V14_TOOL_NAMES
): T {
  const { normalizedPolicy } = normalizeToolPolicyCoverageWithReport(
    config,
    registeredToolNames
  );

  return {
    ...config,
    toolPolicy: normalizedPolicy,
  };
}

/**
 * Perform deterministic normalization and return both the normalized policy
 * map and the full policy coverage report.
 */
export function normalizeToolPolicyCoverageWithReport(
  config: Partial<SchemaV2PermissionConfig> | Record<string, unknown>,
  registeredToolNames: readonly string[] = ALL_V14_TOOL_NAMES
): PolicyNormalizationResult {
  const rawPolicy = ((config.toolPolicy ?? {}) as Record<string, unknown>);
  const profilePreset =
    ((config.profilePreset ??
      (config as SchemaV2PermissionConfig).profileState?.preset) as ProfilePreset | undefined) ?? null;

  const normalizedPolicy: Record<string, ToolPolicy> = {};

  // Copy existing entries without mutation (Rule 1 & Rule 3: explicit policy preserved)
  for (const [key, value] of Object.entries(rawPolicy)) {
    if (typeof value === "string" && (value === "auto" || value === "ask" || value === "off")) {
      normalizedPolicy[key] = value as ToolPolicy;
    }
  }

  const explicit_policy_tools: string[] = [];
  const backfilled_policy_tools: string[] = [];
  const separately_governed_terminal_tools: string[] = [];
  const unresolved_missing_tools: string[] = [];

  const knownPreset = isKnownPreset(profilePreset);
  const presetPolicy = knownPreset ? buildToolPolicyForPreset(profilePreset) : null;

  for (const tool of registeredToolNames) {
    if (R5_TOOLS.has(tool)) {
      // Governed by terminal.mode + Approval Mode
      separately_governed_terminal_tools.push(tool);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(rawPolicy, tool)) {
      explicit_policy_tools.push(tool);
      continue;
    }

    // Missing key from rawPolicy
    if (presetPolicy && tool in presetPolicy) {
      // Safe backfill from active profile semantics
      normalizedPolicy[tool] = presetPolicy[tool];
      backfilled_policy_tools.push(tool);
    } else {
      // Unknown or absent profile semantics: fail-closed, cannot infer authority
      unresolved_missing_tools.push(tool);
    }
  }

  explicit_policy_tools.sort();
  backfilled_policy_tools.sort();
  separately_governed_terminal_tools.sort();
  unresolved_missing_tools.sort();

  const missing_policy_tools = [...unresolved_missing_tools];
  const registered_public_tool_count = registeredToolNames.length;
  const policy_covered_public_tool_count =
    registered_public_tool_count - missing_policy_tools.length;

  let status: PolicyCoverageStatus = "complete";
  if (missing_policy_tools.length > 0) {
    status = "incomplete";
  } else if (backfilled_policy_tools.length > 0) {
    status = "backfilled";
  }

  const coverage: PolicyCoverageReport = {
    registered_public_tool_count,
    policy_covered_public_tool_count,
    missing_policy_tools,
    explicit_policy_tools,
    backfilled_policy_tools,
    separately_governed_terminal_tools,
    unresolved_missing_tools,
    profilePreset,
    status,
  };

  return {
    normalizedPolicy,
    coverage,
  };
}

/**
 * Inspect policy coverage of a configuration against registered public tools.
 */
export function inspectPolicyCoverage(
  config: Partial<SchemaV2PermissionConfig> | Record<string, unknown>,
  options: PolicyCoverageOptions = {}
): PolicyCoverageReport {
  const registered = options.registeredToolNames ?? ALL_V14_TOOL_NAMES;
  const currentPolicy = ((config.toolPolicy ?? {}) as Record<string, unknown>);
  const rawPolicy = options.rawToolPolicy;
  const profilePreset =
    ((config.profilePreset ??
      (config as SchemaV2PermissionConfig).profileState?.preset) as ProfilePreset | undefined) ?? null;

  const explicit_policy_tools: string[] = [];
  const backfilled_policy_tools: string[] = [];
  const separately_governed_terminal_tools: string[] = [];
  const unresolved_missing_tools: string[] = [];

  const knownPreset = isKnownPreset(profilePreset);

  for (const tool of registered) {
    if (R5_TOOLS.has(tool)) {
      separately_governed_terminal_tools.push(tool);
      continue;
    }

    if (rawPolicy !== undefined) {
      if (Object.prototype.hasOwnProperty.call(rawPolicy, tool)) {
        explicit_policy_tools.push(tool);
      } else if (Object.prototype.hasOwnProperty.call(currentPolicy, tool)) {
        backfilled_policy_tools.push(tool);
      } else if (knownPreset) {
        backfilled_policy_tools.push(tool);
      } else {
        unresolved_missing_tools.push(tool);
      }
    } else {
      if (Object.prototype.hasOwnProperty.call(currentPolicy, tool)) {
        explicit_policy_tools.push(tool);
      } else if (knownPreset) {
        backfilled_policy_tools.push(tool);
      } else {
        unresolved_missing_tools.push(tool);
      }
    }
  }

  explicit_policy_tools.sort();
  backfilled_policy_tools.sort();
  separately_governed_terminal_tools.sort();
  unresolved_missing_tools.sort();

  const missing_policy_tools = [...unresolved_missing_tools];
  const registered_public_tool_count = registered.length;
  const policy_covered_public_tool_count =
    registered_public_tool_count - missing_policy_tools.length;

  let status: PolicyCoverageStatus = "complete";
  if (missing_policy_tools.length > 0) {
    status = "incomplete";
  } else if (backfilled_policy_tools.length > 0) {
    status = "backfilled";
  }

  return {
    registered_public_tool_count,
    policy_covered_public_tool_count,
    missing_policy_tools,
    explicit_policy_tools,
    backfilled_policy_tools,
    separately_governed_terminal_tools,
    unresolved_missing_tools,
    profilePreset,
    status,
  };
}
