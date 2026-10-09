import { ConfigManager } from "../config/config-manager.js";
import { getProfileStatus } from "../config/profile-service.js";
import type { SchemaV2PermissionConfig } from "../config/schema-v2.js";
import { getApprovalEngine, getApprovalPersistenceStatus } from "../approval/runtime.js";
import { summarizeRuntimeRisk } from "../permissions/risk.js";
import { getPackageVersion } from "../utils/version.js";
import {
  getRuntimeLocale,
  translate as t,
} from "../i18n/messages.js";

function policySummary(policy: Record<string, unknown> | undefined): {
  auto: number;
  ask: number;
  off: number;
  unknown: number;
} {
  const summary = { auto: 0, ask: 0, off: 0, unknown: 0 };
  for (const value of Object.values(policy ?? {})) {
    if (value === "auto") summary.auto += 1;
    else if (value === "ask") summary.ask += 1;
    else if (value === "off") summary.off += 1;
    else summary.unknown += 1;
  }
  return summary;
}

import { inspectPolicyCoverage } from "../permissions/policy-coverage.js";

export function buildRuntimeStatusSnapshot(
  manager = ConfigManager.getInstance()
): Record<string, unknown> {
  const config = manager.getConfig();
  const mode = manager.getConfigMode();
  const profile = getProfileStatus(manager);
  const jobs = getApprovalEngine().list();
  const pendingJobs = jobs.filter(
    (job) =>
      job.state === "awaiting_approval" ||
      job.state === "approved" ||
      job.state === "running"
  ).length;

  const coverage = manager.getPolicyCoverage() ?? inspectPolicyCoverage(config);

  return {
    version: getPackageVersion(),
    schemaMode: mode,
    canonicalRegisteredToolCount: coverage.registered_public_tool_count,
    registered_public_tool_count: coverage.registered_public_tool_count,
    policy_covered_public_tool_count: coverage.policy_covered_public_tool_count,
    missing_policy_tools: [...coverage.missing_policy_tools],
    policyCoverage: {
      registered_public_tool_count: coverage.registered_public_tool_count,
      policy_covered_public_tool_count: coverage.policy_covered_public_tool_count,
      missing_policy_tools: [...coverage.missing_policy_tools],
      explicit_policy_tools: [...coverage.explicit_policy_tools],
      backfilled_policy_tools: [...coverage.backfilled_policy_tools],
      separately_governed_terminal_tools: [...coverage.separately_governed_terminal_tools],
      unresolved_missing_tools: [...coverage.unresolved_missing_tools],
      status: coverage.status,
    },
    profilePreset: config.profilePreset ?? null,
    profile: {
      preset: profile.preset,
      modified: profile.modified,
      modifiedFields: [...profile.modifiedFields],
    },
    folders: (config.folders ?? []).map((folder) => ({
      path: folder.path,
      alias: folder.alias ?? null,
      permission: folder.permission,
    })),
    terminalMode: config.terminal?.mode ?? null,
    uiLanguage: getRuntimeLocale(),
    toolPolicySummary: policySummary(config.toolPolicy),
    riskState:
      mode === "v2"
        ? summarizeRuntimeRisk(
            config as unknown as SchemaV2PermissionConfig
          )
        : {
            available: false,
            reason:
              mode === "invalid"
                ? "schema-v2 configuration is invalid"
                : "schema-v2 permissions are not active",
          },
    approval: {
      mode: profile.approvalMode,
      behavior: profile.approvalBehavior,
      explicitConfirmationFloors: {
        ...profile.explicitConfirmationFloors,
      },
      blockHoldMs: config.approval?.blockHoldMs ?? null,
      jobTtlMs: config.approval?.jobTtlMs ?? null,
      maxPending: config.approval?.maxPending ?? null,
      pendingJobs,
      journal: (() => {
        const status = getApprovalPersistenceStatus();
        if (!status) return null;
        return {
          path: status.journalPath,
          integrityFailure: status.integrityFailure,
          quarantinedPath: status.quarantinedPath,
          recoveredJobs: status.recoveredJobs,
          unknownRecoveredJobs: status.unknownRecoveredJobs,
        };
      })(),
    },
    config: {
      valid: mode !== "invalid" && coverage.missing_policy_tools.length === 0,
      validationErrors: [
        ...manager.getConfigValidationErrors(),
        ...(coverage.missing_policy_tools.length > 0
          ? [`Missing deliberate policy coverage for registered tools: ${coverage.missing_policy_tools.join(", ")}`]
          : []),
      ],
      userAction:
        mode === "invalid" || coverage.missing_policy_tools.length > 0
          ? t("action.config.repair")
          : null,
    },
  };
}
