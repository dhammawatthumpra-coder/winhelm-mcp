import { fileURLToPath } from "node:url";
import type { FolderPermission, SchemaV2PermissionConfig } from "../config/schema-v2.js";
import {
  checkFolderAccess,
  type FolderAccessResult,
  type ProtectedPathRule,
} from "./folder-access.js";
import { evaluateTerminalMode, evaluateToolPolicy } from "./policy.js";
import { evaluateApprovalMode } from "./approval-model.js";
import { isToolRiskClassified } from "./risk.js";
import { productProfileAllowsTool } from "./presets.js";
import { resolveRequestPath, isFolderListingRequest, type FolderDescriptor } from "./request-paths.js";
import { translate as t } from "../i18n/messages.js";

export type ToolAccessDecision = "allow" | "ask" | "deny";

export interface ToolAccessResult {
  decision: ToolAccessDecision;
  code: string;
  reason: string;
  userAction?: string;
  pathChecks?: FolderAccessResult[];
  /** Extra structured context for the caller, e.g. the configured folders. */
  details?: Record<string, unknown>;
}

export interface ToolAccessOptions {
  protectedPaths?: ProtectedPathRule[];
  /**
   * Run only the capability/static/path security gate. Approval Mode and
   * explicit-confirmation-floor decisions are deliberately deferred until
   * after asynchronous Absolute-Deny preflight.
   */
  deferApprovalDecision?: boolean;
}

const TERMINAL_EXECUTION_TOOLS = new Set([
  "terminal_run",
  "terminal_task_start",
  "terminal_task_send",
  "terminal_task_kill",
]);

const COMMAND_RUN_TOOL = "command_run";

export interface PathRequirement {
  /** Argument name to write the resolved path back into, when it is a field. */
  field?: string;
  value: unknown;
  access: "read" | "write";
  denyRootMutation?: boolean;
}

export function pathRequirements(toolName: string, args: Record<string, any>): PathRequirement[] {
  switch (toolName) {
    case "file_read":
    case "file_preview":
    case "file_tail":
    case "file_hash":
      return [{ field: "path", value: args.path, access: "read" }];

    case "file_inspect_batch": {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      return paths.map((value: unknown) => ({ value, access: "read" as const }));
    }

    case "file_provenance_lookup":
      return [{ field: "path", value: args.path, access: "read" }];

    case "file_compare":
      return [
        { field: "path_a", value: args.path_a, access: "read" },
        { field: "path_b", value: args.path_b, access: "read" },
      ];

    case "directory_manifest":
      return [{ field: "root_path", value: args.root_path, access: "read" }];

    // Spec 3.4 Tier B: path sources require normal read authorization.
    // Pure text/value sources produce no path requirement.
    case "json_parse_strict": {
      const source = args.source as Record<string, unknown> | undefined;
      if (source && typeof source.path === "string") {
        return [{ field: "source_path", value: source.path, access: "read" }];
      }
      return [];
    }

    case "json_canonical_hash": {
      const source = args.source as Record<string, unknown> | undefined;
      if (source && typeof source.path === "string") {
        return [{ field: "source_path", value: source.path, access: "read" }];
      }
      return [];
    }

    case "git_status_structured":
      return [
        { field: "repo_path", value: args.repo_path, access: "read" },
      ];

    case "git_diff_structured":
      return [
        { field: "repo_path", value: args.repo_path, access: "read" },
      ];

    case "file_write_atomic":
    case "file_create_exclusive":
      return [
        {
          field: "path",
          value: args.path,
          access: "write",
          denyRootMutation: true,
        },
      ];

    case "file_list":
    case "file_search":
    case "file_search_ripgrep":
      return [{ field: "path", value: args.path ?? ".", access: "read" }];

    case "file_write":
    case "file_edit":
    case "file_delete_safe":
      return [
        {
          field: "path",
          value: args.path,
          access: "write",
          denyRootMutation: true,
        },
      ];

    case "file_copy":
      return [
        { field: "source", value: args.source, access: "read" },
        {
          field: "destination",
          value: args.destination,
          access: "write",
          denyRootMutation: true,
        },
      ];

    case "file_move":
      return [
        {
          field: "source",
          value: args.source,
          access: "write",
          denyRootMutation: true,
        },
        {
          field: "destination",
          value: args.destination,
          access: "write",
          denyRootMutation: true,
        },
      ];

    case "archive_zip":
      return [
        { field: "source_dir", value: args.source_dir, access: "read" },
        {
          field: "zip_path",
          value: args.zip_path,
          access: "write",
          denyRootMutation: true,
        },
      ];

    case "archive_unzip":
      return [
        { field: "zip_path", value: args.zip_path, access: "read" },
        // Extracting children into the configured root is allowed; replacing
        // the root node itself is not what this argument represents.
        {
          field: "target_dir",
          value: args.target_dir,
          access: "write",
          denyRootMutation: false,
        },
      ];

    case "pdf_generate":
      return [
        { field: "source_path", value: args.source_path, access: "read" },
        {
          field: "pdf_path",
          value: args.pdf_path,
          access: "write",
          denyRootMutation: true,
        },
      ];

    case "system_open": {
      const target = args.target;
      if (typeof target !== "string" || !target.trim()) {
        return [{ value: target, access: "read" }];
      }

      try {
        const parsed = new URL(target);
        if (parsed.protocol === "file:") {
          return [{ value: fileURLToPath(parsed), access: "read" }];
        }
        // Non-file URLs are governed by tool policy, not folder policy.
        return [];
      } catch {
        return [{ value: target, access: "read" }];
      }
    }

    default:
      return [];
  }
}

function deniedFromPath(check: FolderAccessResult): ToolAccessResult {
  return {
    decision: "deny",
    code: check.code,
    reason: check.reason,
    userAction:
      check.code === "FOLDER_READ_ONLY"
        ? t("action.folder.readwrite")
        : t("action.folder.allowed"),
    pathChecks: [check],
  };
}

export interface RequestFolderAccessView {
  /** Argument name the path came from, when it is a named field. */
  argument: string | null;
  /** Path exactly as the caller supplied it. */
  requested: string;
  /** Resolved path, or null when resolution was refused. */
  resolved: string | null;
  allowed: boolean;
  code: string;
  reason: string;
  /** Folder that authorizes the path, with its permission. */
  folder: FolderDescriptor | null;
}

/**
 * Read-only folder resolution for the approval dialog (4.4 asks the user to see
 * the folder and its permission). It reuses the same resolver and folder check
 * as the policy gate so the dialog cannot disagree with enforcement.
 */
export function describeRequestFolderAccess(
  toolName: string,
  args: Record<string, any>,
  folders: FolderPermission[] | undefined
): RequestFolderAccessView[] {
  const views: RequestFolderAccessView[] = [];

  for (const requirement of pathRequirements(toolName, args)) {
    if (
      typeof requirement.value !== "string" ||
      requirement.value.trim() === ""
    ) {
      continue;
    }

    const resolution = resolveRequestPath(requirement.value, folders);
    const resolved = resolution.ok ? resolution.path : null;

    let check: FolderAccessResult | null = null;
    if (resolved) {
      check = checkFolderAccess(resolved, requirement.access, folders ?? [], {
        denyRootMutation: requirement.denyRootMutation,
        rejectReparseMutation: requirement.access === "write",
      });
    }

    views.push({
      argument: requirement.field ?? null,
      requested: requirement.value,
      resolved,
      allowed: check ? check.allowed : false,
      code: check
        ? check.code
        : resolution.ok
          ? "PATH_INVALID"
          : resolution.code,
      reason: check ? check.reason : resolution.ok ? "" : resolution.reason,
      folder: check?.matchedFolder
        ? {
            alias: check.matchedFolder.alias ?? null,
            path: check.matchedFolder.path,
            permission: check.matchedFolder.permission,
          }
        : null,
    });
  }

  return views;
}

export function evaluateSchemaV2ToolAccess(
  toolName: string,
  args: Record<string, any>,
  config: SchemaV2PermissionConfig,
  options: ToolAccessOptions = {}
): ToolAccessResult {
  if (config.approval?.mode && !isToolRiskClassified(toolName)) {
    return {
      decision: "deny",
      code: "RISK_CLASSIFICATION_REQUIRED",
      reason:
        "This tool has no accepted Approval Model risk classification; execution is fail-closed.",
      userAction: t("action.tool.enable"),
    };
  }

  const profileAllows = productProfileAllowsTool(
    config.profilePreset ?? null,
    toolName
  );
  if (profileAllows === false) {
    return {
      decision: "deny",
      code: "PROFILE_CAPABILITY_DENIED",
      reason:
        "The active Capability Profile does not include this tool capability.",
      userAction: t("action.tool.enable"),
    };
  }

  if (toolName === COMMAND_RUN_TOOL) {
    const terminal = evaluateTerminalMode(config.terminal.mode);
    const approvalMode = config.approval?.mode;

    if (config.terminal.mode === "safe") {
      const cwdCheck = checkFolderAccess(
        args.cwd,
        "write",
        config.folders,
        {
          denyRootMutation: false,
          rejectReparseMutation: true,
          protectedPaths: options.protectedPaths,
        }
      );

      if (!cwdCheck.allowed) {
        return {
          decision: "deny",
          code: cwdCheck.code === "PATH_INVALID"
            ? "SAFE_CWD_REQUIRED"
            : cwdCheck.code,
          reason:
            cwdCheck.code === "PATH_INVALID"
              ? "Safe command_run requires an explicit cwd inside a readwrite WinHelm folder."
              : cwdCheck.reason,
          userAction: t("action.safe.cwd"),
          pathChecks: [cwdCheck],
        };
      }

      if (options.deferApprovalDecision || !approvalMode) {
        return {
          decision: "allow",
          code: "TERMINAL_SAFE",
          reason:
            "Safe command_run is permitted at the static capability/path gate; approval semantics are evaluated after Absolute-Deny preflight.",
          pathChecks: [cwdCheck],
        };
      }

      const approval = evaluateApprovalMode(toolName, approvalMode, {
        terminalExecution: "safe-adapter",
      });
      return {
        decision: approval.decision,
        code:
          approval.decision === "ask"
            ? "APPROVAL_REQUIRED"
            : approval.code,
        reason: approval.reason,
        ...(approval.decision === "ask"
          ? { userAction: t("action.approve.command") }
          : {}),
        pathChecks: [cwdCheck],
      };
    }

    if (terminal.decision === "deny") {
      return {
        decision: "deny",
        code: "TERMINAL_MODE_REQUIRED",
        reason: terminal.reason,
        userAction: t("action.terminal.change"),
      };
    }

    if (options.deferApprovalDecision) {
      return {
        decision: "allow",
        code: terminal.code,
        reason:
          "Direct command_run passed the static terminal capability gate; approval semantics are evaluated after Absolute-Deny preflight.",
      };
    }

    if (!approvalMode) {
      if (terminal.decision === "ask") {
        return {
          decision: "ask",
          code: "APPROVAL_REQUIRED",
          reason: terminal.reason,
          userAction: t("action.approve.command"),
        };
      }

      return {
        decision: "allow",
        code: terminal.code,
        reason: terminal.reason,
      };
    }

    const approval = evaluateApprovalMode(toolName, approvalMode, {
      terminalExecution: "direct",
      explicitConfirmationFloor: config.terminal.mode === "ask",
    });
    return {
      decision: approval.decision,
      code:
        approval.decision === "ask"
          ? "APPROVAL_REQUIRED"
          : approval.code,
      reason: approval.reason,
      ...(approval.decision === "ask"
        ? { userAction: t("action.approve.command") }
        : {}),
    };
  }

  if (TERMINAL_EXECUTION_TOOLS.has(toolName)) {
    const terminal = evaluateTerminalMode(config.terminal.mode);
    const approvalMode = config.approval?.mode;

    if (config.terminal.mode === "safe") {
      return {
        decision: "deny",
        code: "TERMINAL_MODE_REQUIRED",
        reason: "Safe terminal mode permits only the dedicated command_run adapter, not terminal_* execution tools.",
        userAction: t("action.terminal.safe_command"),
      };
    }

    if (terminal.decision === "deny") {
      return {
        decision: "deny",
        code: "TERMINAL_MODE_REQUIRED",
        reason: terminal.reason,
        userAction: t("action.terminal.change"),
      };
    }

    if (options.deferApprovalDecision) {
      return {
        decision: "allow",
        code: terminal.code,
        reason:
          "Terminal execution passed the static capability gate; approval semantics are evaluated after Absolute-Deny preflight.",
      };
    }

    if (!approvalMode) {
      if (terminal.decision === "ask") {
        return {
          decision: "ask",
          code: "APPROVAL_REQUIRED",
          reason: terminal.reason,
          userAction: t("action.approve.terminal"),
        };
      }

      return {
        decision: "allow",
        code: terminal.code,
        reason: terminal.reason,
      };
    }

    const approval = evaluateApprovalMode(toolName, approvalMode, {
      terminalExecution: "direct",
      explicitConfirmationFloor: config.terminal.mode === "ask",
    });
    return {
      decision: approval.decision,
      code:
        approval.decision === "ask"
          ? "APPROVAL_REQUIRED"
          : approval.code,
      reason: approval.reason,
      ...(approval.decision === "ask"
        ? { userAction: t("action.approve.terminal") }
        : {}),
    };
  }

  const policy = evaluateToolPolicy(config.toolPolicy[toolName]);
  if (policy.decision === "deny") {
    return {
      decision: "deny",
      code: policy.code,
      reason: policy.reason,
      userAction: t("action.tool.enable"),
    };
  }

  if (config.approval?.mode && !isToolRiskClassified(toolName)) {
    return {
      decision: "deny",
      code: "RISK_CLASSIFICATION_REQUIRED",
      reason:
        "This tool has no accepted Approval Model risk classification; execution is fail-closed.",
      userAction: t("action.tool.enable"),
    };
  }

  const requirements = pathRequirements(toolName, args);
  // §5.1: `file_list "."` with several folders lists the folders themselves,
  // so it has no single path to resolve or authorize. Tool policy still
  // decides allow/ask/deny below.
  const folderListing =
    toolName === "file_list" &&
    isFolderListingRequest(args.path, config.folders);
  // §5.1: resolve before authorization and write the result back into the
  // request, so the authorized path and the path the tool executes with are
  // the same one.
  const resolvedRequirements: PathRequirement[] = [];
  for (const requirement of folderListing ? [] : requirements) {
    if (
      typeof requirement.value !== "string" ||
      requirement.value.trim() === ""
    ) {
      resolvedRequirements.push(requirement);
      continue;
    }

    const resolution = resolveRequestPath(requirement.value, config.folders);
    if (!resolution.ok) {
      return {
        decision: "deny",
        code: resolution.code,
        reason: resolution.reason,
        userAction:
          resolution.code === "AMBIGUOUS_PATH"
            ? t("action.path.alias")
            : t("action.folder.allowed"),
        details: { folders: resolution.folders },
      };
    }

    if (requirement.field) {
      args[requirement.field] = resolution.path;
    }
    resolvedRequirements.push({
      ...requirement,
      value: resolution.path,
    });
  }

  const pathChecks: FolderAccessResult[] = [];
  for (const requirement of resolvedRequirements) {
    const check = checkFolderAccess(
      requirement.value,
      requirement.access,
      config.folders,
      {
        denyRootMutation: requirement.denyRootMutation,
        rejectReparseMutation: requirement.access === "write",
        protectedPaths: options.protectedPaths,
      }
    );
    pathChecks.push(check);
    if (!check.allowed) {
      const denied = deniedFromPath(check);
      denied.pathChecks = pathChecks;
      return denied;
    }
  }

  if (options.deferApprovalDecision) {
    return {
      decision: "allow",
      code: "STATIC_ACCESS_ALLOWED",
      reason:
        "Tool passed capability, policy-disable, risk, and path security gates; approval semantics are evaluated after Absolute-Deny preflight.",
      pathChecks,
    };
  }

  const approvalMode = config.approval?.mode;
  if (!approvalMode) {
    if (policy.decision === "ask") {
      return {
        decision: "ask",
        code: "APPROVAL_REQUIRED",
        reason: policy.reason,
        userAction: t("action.approve.generic"),
        pathChecks,
      };
    }

    return {
      decision: "allow",
      code: "POLICY_AUTO",
      reason: policy.reason,
      pathChecks,
    };
  }

  const approval = evaluateApprovalMode(toolName, approvalMode, {
    explicitConfirmationFloor: policy.decision === "ask",
    mandatoryConfirmation: toolName === "service_control",
    // A concrete WinHelm-owned process kill is bounded and follows ordinary
    // Approval Mode behavior. The wrapper escalates external/name-based
    // targets through the runtime Mandatory Confirmation classifier.
    ...(toolName === "process_kill"
      ? { riskClassOverride: "R1" as const }
      : {}),
  });

  return {
    decision: approval.decision,
    code:
      approval.decision === "ask"
        ? "APPROVAL_REQUIRED"
        : approval.code,
    reason: approval.reason,
    ...(approval.decision === "ask"
      ? { userAction: t("action.approve.generic") }
      : {}),
    pathChecks,
  };
}
