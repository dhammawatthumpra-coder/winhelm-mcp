import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config/config-manager.js";
import { isToolInProfile } from "../config/profiles.js";
import type { SchemaV2PermissionConfig } from "../config/schema-v2.js";
import { evaluateSchemaV2ToolAccess } from "../permissions/tool-access.js";

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

  if (configMode === "legacy") {
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

    if (liveMode === "invalid") {
      return logAndReturnPolicyError(
        name,
        startTime,
        "CONFIGURATION_UNAVAILABLE",
        "WinHelm configuration is invalid; tool execution is fail-closed.",
        "Open WinHelm to repair the configuration before retrying.",
        { validationErrors: [...liveConfigManager.getConfigValidationErrors()] }
      );
    }

    if (liveMode === "v2") {
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
        return logAndReturnPolicyError(
          name,
          startTime,
          "APPROVAL_REQUIRED",
          access.reason,
          access.userAction ?? "Approve this action in WinHelm.",
          { tool: name, approvalEngine: "pending" }
        );
      }
    }

    try {
      const res = await handler(args, extra);
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

  server.registerTool(name, { inputSchema: schema }, wrappedHandler);
}
