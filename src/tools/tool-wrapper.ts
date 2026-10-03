import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config/config-manager.js";
import { isToolInProfile } from "../config/profiles.js";
import type { SchemaV2PermissionConfig } from "../config/schema-v2.js";
import { evaluateSchemaV2ToolAccess } from "../permissions/tool-access.js";
import { getApprovalEngine } from "../approval/runtime.js";
import { runToolWithHybridApproval } from "../approval/tool-flow.js";
import {
  approvalSessionKey,
  getProvenanceTracker,
} from "../approval/provenance.js";
import { isRecoveryToolName } from "./registry.js";
import { getToolMetadata } from "./metadata.js";
import { getServerRuntimeContext } from "../gateway/session-context.js";

function createPolicyError(
  code: string,
  message: string,
  userAction?: string,
  details?: Record<string, unknown>
): any {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code,
            message,
            ...(userAction ? { userAction } : {}),
            ...(details ? { details } : {}),
          },
        }),
      },
    ],
  };
}

function logAndReturnPolicyError(
  name: string,
  startTime: number,
  code: string,
  message: string,
  userAction?: string,
  details?: Record<string, unknown>
): any {
  const res = createPolicyError(code, message, userAction, details);
  logger.toolFail(name, Date.now() - startTime, res.content[0].text);
  return res;
}

/**
 * Wraps a tool execution with performance timing, ANSI terminal logging, and memory telemetry.
 *
 * Legacy mode preserves the v1.2.1 profile-registration filter.
 * Schema-v2/invalid modes expose the current tool surface, but execution remains
 * fail-closed until the v2 path/tool permission layer is wired in.
 */
export function registerTracedTool(
  server: McpServer,
  name: string,
  schema: any,
  handler: (args: any, extra: any) => Promise<any>
): void {
  const configManager = ConfigManager.getInstance();
  const config = configManager.getConfig();
  const configMode = configManager.getConfigMode();
  const recoveryTool = isRecoveryToolName(name);

  if (configMode === "legacy" && !recoveryTool) {
    const profile = config.profile || "full";
    if (!isToolInProfile(name, profile, config.customTools)) {
      return;
    }
  }

  const wrappedHandler = async (args: any, extra: any) => {
    const startTime = Date.now();
    logger.toolStart(name, args);

    const liveConfigManager = ConfigManager.getInstance();
    const liveMode = liveConfigManager.getConfigMode();
    const provenance = getProvenanceTracker();
    const runtimeContext = getServerRuntimeContext(server);
    const effectiveSessionId =
      extra?.sessionId ?? runtimeContext?.sessionId;
    const sessionKey = approvalSessionKey(effectiveSessionId);

    const executeAndRecord = async (executionExtra: any) => {
      try {
        const result = await handler(args, executionExtra);
        provenance.recordResult(
          sessionKey,
          name,
          args ?? {},
          result
        );
        return result;
      } catch (err) {
        provenance.recordThrownError(
          sessionKey,
          name,
          args ?? {},
          err
        );
        throw err;
      }
    };

    let executeTool = () => executeAndRecord(extra);

    if (liveMode === "invalid" && !recoveryTool) {
      return logAndReturnPolicyError(
        name,
        startTime,
        "CONFIGURATION_UNAVAILABLE",
        "WinHelm configuration is invalid; tool execution is fail-closed.",
        "Open WinHelm to repair the configuration before retrying.",
        { validationErrors: [...liveConfigManager.getConfigValidationErrors()] }
      );
    }

    if (liveMode === "v2" && !recoveryTool) {
      const liveConfig =
        liveConfigManager.getConfig() as unknown as SchemaV2PermissionConfig;
      const access = evaluateSchemaV2ToolAccess(name, args ?? {}, liveConfig);

      if (access.decision === "deny") {
        return logAndReturnPolicyError(
          name,
          startTime,
          access.code,
          access.reason,
          access.userAction,
          access.pathChecks
            ? {
                pathChecks: access.pathChecks.map((check) => ({
                  code: check.code,
                  reason: check.reason,
                  canonicalPath: check.canonicalPath,
                  matchedFolder:
                    check.matchedFolder?.alias ?? check.matchedFolder?.path,
                })),
              }
            : undefined
        );
      }

      if (access.decision === "ask") {
        const executionController = new AbortController();
        const executionExtra = {
          ...extra,
          signal: executionController.signal,
        };
        const requestId =
          typeof extra?.requestId === "string" ||
          typeof extra?.requestId === "number"
            ? extra.requestId
            : undefined;

        executeTool = () =>
          runToolWithHybridApproval({
            engine: getApprovalEngine(),
            tool: name,
            args: args ?? {},
            approval: liveConfig.approval,
            context: {
              sessionId: effectiveSessionId,
              requestId,
              signal: extra?.signal,
            },
            execute: () => executeAndRecord(executionExtra),
          });
      }
    }

    try {
      const res = await executeTool();
      const durationMs = Date.now() - startTime;

      if (res && res.isError) {
        const errorText = res.content?.[0]?.text || "Tool reported error";
        logger.toolFail(name, durationMs, errorText);
      } else {
        let summary: string | undefined;
        if (res && Array.isArray(res.content) && res.content[0]) {
          const first = res.content[0];
          if (first.type === "image") {
            summary = `[Image Binary: ${first.mimeType || "image/png"}]`;
          } else if (first.text) {
            summary = first.text.replace(/\r?\n/g, " ").trim();
          }
        }
        logger.toolDone(name, durationMs, summary);
      }
      return res;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      logger.toolFail(name, durationMs, err.message || String(err));
      throw err;
    }
  };

  const metadata = getToolMetadata(name);
  server.registerTool(
    name,
    {
      title: metadata.title,
      description: metadata.description,
      inputSchema: schema,
      annotations: metadata.annotations,
    },
    wrappedHandler
  );
}
