import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config/config-manager.js";
import { isToolInProfile } from "../config/profiles.js";

/**
 * Wraps a tool execution with performance timing, ANSI terminal logging, and memory telemetry.
 * Automatically filters out tools not included in the active profile to save LLM context tokens.
 */
export function registerTracedTool(
  server: McpServer,
  name: string,
  schema: any,
  handler: (args: any, extra: any) => Promise<any>
): void {
  const profile = ConfigManager.getInstance().getConfig().profile || "full";
  if (!isToolInProfile(name, profile)) {
    return;
  }
  const wrappedHandler = async (args: any, extra: any) => {
    const startTime = Date.now();
    logger.toolStart(name, args);
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
