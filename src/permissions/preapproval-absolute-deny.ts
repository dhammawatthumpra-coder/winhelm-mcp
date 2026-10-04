import type { SchemaV2PermissionConfig } from "../config/schema-v2.js";
import { ConfigManager } from "../config/config-manager.js";
import {
  validateNetworkTarget,
  type NetworkResolver,
} from "./network-target.js";
import {
  CommandRunPolicyError,
  preflightCommandRun,
} from "../engine/command-runner.js";
import { preflightZipExtractionSecurity } from "../engine/filesystem.js";
import { translate as t } from "../i18n/messages.js";
import { pathRequirements } from "./tool-access.js";
import { isFolderListingRequest } from "./request-paths.js";

export interface AbsoluteDenyPreflightResult {
  code: string;
  reason: string;
  userAction?: string;
  details?: Record<string, unknown>;
}

const READ_ONLY_MUTATION_TOOLS = new Set([
  "file_write",
  "file_edit",
  "file_delete_safe",
  "file_move",
  "file_copy",
  "archive_zip",
  "archive_unzip",
  "pdf_generate",
  "terminal_run",
  "terminal_task_start",
  "process_kill",
  "service_control",
]);

let networkResolverForTesting: NetworkResolver | undefined;

/**
 * Test-only dependency seam for deterministic DNS preflight coverage.
 * Production callers never set this and therefore use the normal resolver.
 */
export function setPreapprovalNetworkResolverForTesting(
  resolver: NetworkResolver | undefined
): void {
  networkResolverForTesting = resolver;
}

function readOnlyDenial(toolName: string): AbsoluteDenyPreflightResult {
  return {
    code: "READ_ONLY_MODE",
    reason: `Tool ${toolName} is blocked because WinHelm is operating in read-only mode.`,
    userAction: t("action.error.review"),
  };
}

async function preflightNetworkTarget(
  args: Record<string, any>,
  config: SchemaV2PermissionConfig,
  manager: ConfigManager
): Promise<AbsoluteDenyPreflightResult | undefined> {
  const validation = await validateNetworkTarget(String(args.url ?? ""), {
    allowLoopback: config.network?.allowLoopback === true,
    effectivePort: manager.getRuntimeEffectivePort(),
    resolver: networkResolverForTesting,
  });

  if (validation.allowed) return undefined;

  return {
    code: validation.code ?? "NETWORK_TARGET_BLOCKED",
    reason:
      validation.reason ?? "Network target blocked by WinHelm security policy.",
    userAction: t("action.network.target"),
    details: {
      url: validation.url.toString(),
      addresses: validation.addresses,
    },
  };
}

function preflightManagerPathSecurity(
  toolName: string,
  args: Record<string, any>,
  config: SchemaV2PermissionConfig,
  manager: ConfigManager
): AbsoluteDenyPreflightResult | undefined {
  const folderListing =
    toolName === "file_list" &&
    isFolderListingRequest(args.path, config.folders);
  const requirements = folderListing ? [] : pathRequirements(toolName, args);

  for (const requirement of requirements) {
    if (
      typeof requirement.value !== "string" ||
      requirement.value.trim() === ""
    ) {
      continue;
    }

    // The static access evaluator has already resolved named path arguments
    // in-place. ConfigManager adds the authoritative protected-path and
    // existing-aware reparse checks used again inside execution engines.
    const check = manager.checkPathAccess(
      requirement.value,
      requirement.access,
      {
        denyRootMutation: requirement.denyRootMutation,
        rejectReparseMutation: requirement.access === "write",
      }
    );
    if (!check.allowed) {
      return {
        code: check.code ?? "FOLDER_ACCESS_DENIED",
        reason:
          check.reason ??
          "Path is blocked by WinHelm filesystem security policy.",
        userAction:
          check.code === "FOLDER_READ_ONLY"
            ? t("action.folder.readwrite")
            : t("action.folder.allowed"),
      };
    }
  }

  return undefined;
}

/**
 * Central asynchronous Absolute-Deny preflight for checks that historically
 * lived only inside tool handlers/execution engines.
 *
 * This layer is intentionally called after the existing static capability/path
 * gate but before Mandatory Confirmation or ApprovalEngine.request(). Checks
 * that can change are also retained/re-run in the execution path.
 */
export async function preflightAbsoluteDeny(
  toolName: string,
  args: Record<string, any>,
  config: SchemaV2PermissionConfig,
  manager: ConfigManager = ConfigManager.getInstance()
): Promise<AbsoluteDenyPreflightResult | undefined> {
  try {
    const pathSecurity = preflightManagerPathSecurity(
      toolName,
      args,
      config,
      manager
    );
    if (pathSecurity) return pathSecurity;

    if (toolName === "http_ping" || toolName === "http_request") {
      const network = await preflightNetworkTarget(args, config, manager);
      if (network) return network;
    }

    if (
      manager.isReadOnly() &&
      (READ_ONLY_MUTATION_TOOLS.has(toolName) ||
        (toolName === "http_request" &&
          !["GET", "HEAD"].includes(
            String(args.method ?? "GET").toUpperCase()
          )))
    ) {
      return readOnlyDenial(toolName);
    }

    if (toolName === "terminal_run" || toolName === "terminal_task_start") {
      const command = String(args.command ?? "");
      const check = manager.isCommandAllowed(command);
      if (!check.allowed) {
        return {
          code: "COMMAND_SECURITY_BLOCKED",
          reason:
            check.reason ?? "Command blocked by WinHelm security policy.",
          userAction: t("action.command.allowed"),
        };
      }
    }

    if (toolName === "command_run") {
      try {
        preflightCommandRun({
          command: String(args.command ?? ""),
          args: Array.isArray(args.args)
            ? args.args.map((value: unknown) => String(value))
            : [],
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          timeoutMs:
            typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        });
      } catch (err) {
        if (err instanceof CommandRunPolicyError) {
          return {
            code: err.code,
            reason: err.message,
            userAction: t("action.command.allowed"),
          };
        }
        throw err;
      }
    }

    if (toolName === "archive_unzip") {
      try {
        await preflightZipExtractionSecurity(
          String(args.zip_path ?? ""),
          String(args.target_dir ?? "")
        );
      } catch (err) {
        return {
          code: "ARCHIVE_SECURITY_PREFLIGHT_DENIED",
          reason: (err as Error).message || String(err),
          userAction: t("action.folder.allowed"),
        };
      }
    }

    return undefined;
  } catch (err) {
    return {
      code: "ABSOLUTE_DENY_PREFLIGHT_FAILED",
      reason:
        (err as Error).message ||
        "Absolute-Deny security preflight could not establish a safe authorization state.",
      userAction: t("action.error.review"),
    };
  }
}
