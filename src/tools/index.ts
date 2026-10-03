import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTerminalTools } from "./terminal-tools.js";
import { registerFileTools } from "./file-tools.js";
import { registerDesktopTools } from "./desktop-tools.js";
import { registerNetworkTools } from "./network-tools.js";
import { registerRecoveryTools } from "./recovery-tools.js";
import { registerCommandTools } from "./command-tools.js";

/**
 * Register all WinHelm tools into an McpServer instance
 */
export function registerAllTools(server: McpServer): void {
  registerTerminalTools(server);
  registerFileTools(server);
  registerDesktopTools(server);
  registerNetworkTools(server);
  registerRecoveryTools(server);
  registerCommandTools(server);
}

export * from "./registry.js";
export {
  registerTerminalTools,
  registerFileTools,
  registerDesktopTools,
  registerNetworkTools,
  registerRecoveryTools,
  registerCommandTools,
};
