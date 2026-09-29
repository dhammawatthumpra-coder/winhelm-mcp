#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigManager } from "./config/config-manager.js";
import { createServer } from "./gateway/server.js";
import { isValidProfile, resolveCustomTools } from "./config/profiles.js";
import { registerAllTools } from "./tools/index.js";
import { validateNetworkExposure, isLoopbackHost } from "./utils/network-gate.js";

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(flag: string, fallback?: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("-") ? args[idx + 1] : fallback;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
WinHelm - Windows Native MCP Server
Usage:
  winhelm [options]

Options:
  --config <path>       Load configuration from a specific JSON file (e.g. project-specific config)
  --port <number>       Port to listen on (default: 8788 or PORT env)
  --host <string>       Host interface (default: 127.0.0.1 or HOST env)
  --profile, -p <name>  Tool profile: minimal (6), core (15), dev (28), sysadmin (37), full (38) (default: full)
  --stdio               Run in stdio mode for local MCP clients (OpenAI tunnel-client, Claude, Cursor)
  --auth <token>        Bearer authentication token (or MCP_AUTH_TOKEN env)
  --read-only           Enable read-only mode (block mutating actions)
  --allowed-dirs <list> Comma-separated allowed directories (e.g. "D:\\mcp,C:\\Projects")
  --tools <list>        Explicit comma-separated tools to load or +tool/-tool modifiers
  --system-exec         Enable execution of runtime binaries on C: (default: false)
  --no-persist          Do not persist CLI overrides to config file (default behavior)
  --persist             Persist CLI overrides back to config file
  --help, -h            Show this help message
`);
  process.exit(0);
}

async function main() {
  const IS_STDIO = args.includes("--stdio") || getArg("--transport") === "stdio";
  if (IS_STDIO) {
    // In stdio mode, process.stdout is the JSON-RPC wire. All logs must go to stderr.
    console.log = (...a: any[]) => console.error(...a);
  }

  const CONFIG_ARG = getArg("--config");
  const NO_PERSIST = args.includes("--no-persist");
  const configManager = ConfigManager.getInstance(CONFIG_ARG);
  await configManager.init(CONFIG_ARG);

  const PORT = parseInt(getArg("--port", process.env.PORT || "8788")!, 10);
  const HOST = getArg("--host", process.env.HOST || "127.0.0.1")!;
  const AUTH_TOKEN = getArg("--auth", process.env.MCP_AUTH_TOKEN || undefined);
  const ALLOWED_DIRS = getArg("--allowed-dirs", process.env.MCP_ALLOWED_DIRECTORIES || undefined);
  const READ_ONLY = args.includes("--read-only") || process.env.MCP_READ_ONLY === "true" || process.env.MCP_READ_ONLY === "1";
  const ALLOW_SYSTEM_EXEC = args.includes("--system-exec") || args.includes("--allow-system-exec");
  const PROFILE_ARG = getArg("--profile", getArg("-p", process.env.WINHELM_PROFILE || undefined));
  const TOOLS_ARG = getArg("--tools");

  const updates: Record<string, any> = {};
  if (AUTH_TOKEN) updates.authToken = AUTH_TOKEN;
  if (READ_ONLY) updates.readOnly = true;
  if (ALLOW_SYSTEM_EXEC) updates.allowSystemExecution = true;
  if (PROFILE_ARG) {
    if (isValidProfile(PROFILE_ARG)) {
      updates.profile = PROFILE_ARG;
    } else {
      console.error(`[WinHelm] Unknown profile: "${PROFILE_ARG}". Valid profiles: minimal, core, dev, sysadmin, full, custom`);
      process.exit(1);
    }
  }
  if (TOOLS_ARG) {
    const baseProfile = (updates.profile || configManager.getConfig().profile || "full") as any;
    updates.customTools = resolveCustomTools(baseProfile, TOOLS_ARG);
    if (!updates.profile) updates.profile = "custom";
  }
  if (ALLOWED_DIRS) {
    updates.allowedDirectories = ALLOWED_DIRS.split(",")
      .map((d) => d.trim())
      .filter(Boolean);
  }
  if (Object.keys(updates).length > 0) {
    // By default, CLI overrides are in-memory session-only unless --persist is explicitly passed
    const shouldPersist = args.includes("--persist") && !NO_PERSIST;
    await configManager.updateConfig(updates, shouldPersist);
  }

  // Ensure security warnings print after all CLI / config overrides take effect
  configManager.logSecurityWarnings();

  // Startup Security Gate: Non-stdio + Non-loopback interface MUST have an authToken
  const effectiveAuthToken = AUTH_TOKEN || configManager.getConfig().authToken;
  const exposureCheck = validateNetworkExposure({
    host: HOST,
    isStdio: IS_STDIO,
    authToken: effectiveAuthToken,
  });

  if (!exposureCheck.allowed) {
    console.error("\n" + "=".repeat(78));
    console.error("FATAL SECURITY ERROR: Server cannot bind to a non-loopback address without authentication.");
    console.error(`   Interface: ${HOST}:${PORT}`);
    console.error("   Exposing WinHelm to a network without authentication permits remote code execution.");
    console.error(`   ${exposureCheck.error}`);
    console.error("=".repeat(78) + "\n");
    process.exit(1);
  }

  if (IS_STDIO) {
    const mcpServer = new McpServer({
      name: "winhelm-mcp",
      version: "1.2.0",
    });
    registerAllTools(mcpServer);

    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);

    console.error(`[WinHelm] Connected via stdio transport (Profile: ${configManager.getConfig().profile || "full"}).`);

    const shutdown = async () => {
      await mcpServer.close().catch(() => {});
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const { start, stop } = createServer({
    port: PORT,
    host: HOST,
    authToken: AUTH_TOKEN,
  });

  const server = await start();

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) {
      console.log("\n[WinHelm] Force exit.");
      process.exit(0);
    }
    isShuttingDown = true;
    console.log("\n[WinHelm] Shutting down server gracefully...");

    // Safety timeout in case of any lingering event loop handles
    const forceExitTimer = setTimeout(() => {
      console.log("[WinHelm] Server stopped. Goodbye!");
      process.exit(0);
    }, 1200);
    forceExitTimer.unref();

    try {
      await stop(server);
    } catch {
      // ignore
    }

    console.log("[WinHelm] Server stopped. Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Auto-run if executed directly or in standalone SEA binary
const argv1 = process.argv[1] || "";
const isSeaBinary = process.execPath.toLowerCase().endsWith(".exe") && !process.execPath.toLowerCase().endsWith("node.exe");
const isDirectEntry =
  isSeaBinary ||
  argv1.endsWith("index.ts") ||
  argv1.endsWith("index.js") ||
  argv1.endsWith("winhelm") ||
  (typeof import.meta !== "undefined" && import.meta?.url && argv1 && import.meta.url.includes(argv1.replace(/\\/g, "/")));

if (isDirectEntry) {
  main().catch((err) => {
    console.error("[WinHelm] Fatal error on startup:", err);
    process.exit(1);
  });
}

export { createServer, ConfigManager, validateNetworkExposure, isLoopbackHost };
