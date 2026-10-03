import { fileURLToPath } from "node:url";
import type { SchemaV2PermissionConfig } from "../config/schema-v2.js";
import {
  checkFolderAccess,
  type FolderAccessResult,
  type ProtectedPathRule,
} from "./folder-access.js";
import { evaluateTerminalMode, evaluateToolPolicy } from "./policy.js";

export type ToolAccessDecision = "allow" | "ask" | "deny";

export interface ToolAccessResult {
  decision: ToolAccessDecision;
  code: string;
  reason: string;
  userAction?: string;
  pathChecks?: FolderAccessResult[];
}

export interface ToolAccessOptions {
  protectedPaths?: ProtectedPathRule[];
}

const TERMINAL_EXECUTION_TOOLS = new Set([
  "terminal_run",
  "terminal_task_start",
  "terminal_task_send",
  "terminal_task_kill",
]);

interface PathRequirement {
  value: unknown;
  access: "read" | "write";
  denyRootMutation?: boolean;
}

function pathRequirements(toolName: string, args: Record<string, any>): PathRequirement[] {
  switch (toolName) {
    case "file_read":
    case "file_preview":
    case "file_tail":
    case "file_hash":
      return [{ value: args.path, access: "read" }];

    case "file_list":
    case "file_search":
    case "file_search_ripgrep":
      return [{ value: args.path ?? ".", access: "read" }];

    case "file_write":
    case "file_edit":
    case "file_delete_safe":
      return [{ value: args.path, access: "write", denyRootMutation: true }];

    case "file_copy":
      return [
        { value: args.source, access: "read" },
        { value: args.destination, access: "write", denyRootMutation: true },
      ];

    case "file_move":
      return [
        { value: args.source, access: "write", denyRootMutation: true },
        { value: args.destination, access: "write", denyRootMutation: true },
      ];

    case "archive_zip":
      return [
        { value: args.source_dir, access: "read" },
        { value: args.zip_path, access: "write", denyRootMutation: true },
      ];

    case "archive_unzip":
      return [
        { value: args.zip_path, access: "read" },
        // Extracting children into the configured root is allowed; replacing
        // the root node itself is not what this argument represents.
        { value: args.target_dir, access: "write", denyRootMutation: false },
      ];

    case "pdf_generate":
      return [
        { value: args.source_path, access: "read" },
        { value: args.pdf_path, access: "write", denyRootMutation: true },
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
        ? "Choose a readwrite folder or change its permission in WinHelm settings."
        : "Choose a path inside an allowed WinHelm folder.",
    pathChecks: [check],
  };
}

export function evaluateSchemaV2ToolAccess(
  toolName: string,
  args: Record<string, any>,
  config: SchemaV2PermissionConfig,
  options: ToolAccessOptions = {}
): ToolAccessResult {
  if (TERMINAL_EXECUTION_TOOLS.has(toolName)) {
    const terminal = evaluateTerminalMode(config.terminal.mode);

    if (config.terminal.mode === "safe") {
      return {
        decision: "deny",
        code: "TERMINAL_MODE_REQUIRED",
        reason: "Safe terminal mode permits only the dedicated command_run adapter, not terminal_* execution tools.",
        userAction: "Use command_run for supported package-manager operations or change Terminal mode locally.",
      };
    }

    if (terminal.decision === "deny") {
      return {
        decision: "deny",
        code: "TERMINAL_MODE_REQUIRED",
        reason: terminal.reason,
        userAction: "Change Terminal mode in WinHelm settings.",
      };
    }

    if (terminal.decision === "ask") {
      return {
        decision: "ask",
        code: "APPROVAL_REQUIRED",
        reason: terminal.reason,
        userAction: "Approve this terminal action in WinHelm.",
      };
    }

    return {
      decision: "allow",
      code: terminal.code,
      reason: terminal.reason,
    };
  }

  const policy = evaluateToolPolicy(config.toolPolicy[toolName]);
  if (policy.decision === "deny") {
    return {
      decision: "deny",
      code: "TOOL_POLICY_OFF",
      reason: policy.reason,
      userAction: "Enable this tool in WinHelm permissions.",
    };
  }

  const requirements = pathRequirements(toolName, args);
  const pathChecks: FolderAccessResult[] = [];
  for (const requirement of requirements) {
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

  if (policy.decision === "ask") {
    return {
      decision: "ask",
      code: "APPROVAL_REQUIRED",
      reason: policy.reason,
      userAction: "Approve this action in WinHelm.",
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
