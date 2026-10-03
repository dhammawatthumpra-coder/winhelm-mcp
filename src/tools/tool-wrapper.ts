import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config/config-manager.js";
import { isToolInProfile } from "../config/profiles.js";

function createPolicyError(code: string, message: string, userAction: string): any {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ code, message, userAction }),
      },
    ],
  };
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
      const res = createPolicyError(
        "CONFIG_INVALID",
        "WinHelm configuration is invalid; tool execution is fail-closed.",
        "Open WinHelm settings and repair the configuration before retrying."
      );
      logger.toolFail(name, Date.now() - startTime, res.content[0].text);
      return res;
    }

    if (liveMode === "v2") {
      const res = createPolicyError(
        "SCHEMA_V2_ENFORCEMENT_PENDING",
        "Schema-v2 is enabled, but the v2 permission enforcement layer is not fully wired in this implementation checkpoint.",
        "Keep schema-v2 disabled for normal use until the permission layer is completed."
      );
      logger.toolFail(name, Date.now() - startTime, res.content[0].text);
      return res;
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
