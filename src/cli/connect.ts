import path from "node:path";
import { ConfigManager } from "../config/config-manager.js";
import {
  applyClientConnection,
  previewClientConnection,
  type ClientConnectionPreview,
  type SupportedMcpClient,
} from "../config/client-connect.js";

export interface ConnectCliResult {
  handled: boolean;
  exitCode: number;
  output?: string;
  error?: string;
}

function argValue(args: string[], flag: string): string | undefined {
  const exact = args.indexOf(flag);
  if (
    exact >= 0 &&
    args[exact + 1] &&
    !args[exact + 1].startsWith("-")
  ) {
    return args[exact + 1];
  }

  const prefixed = args.find((arg) =>
    arg.startsWith(flag + "=")
  );
  return prefixed?.slice(flag.length + 1);
}

function parseClient(value: string | undefined):
  | SupportedMcpClient
  | "all"
  | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "cursor") return "cursor";
  if (normalized === "all") return "all";
  return undefined;
}

function formatPreview(preview: ClientConnectionPreview): string {
  const lines = [
    `${preview.target.displayName} MCP connection`,
    `Config: ${preview.target.configPath}`,
    ...(preview.target.resolutionBasis
      ? [`Resolution: ${preview.target.resolutionBasis}`]
      : []),
    `Existing config: ${preview.target.configFileExists ? "yes" : "no"}`,
    `Changed: ${preview.changed ? "yes" : "no"}`,
    "Proposed mcpServers.winhelm:",
    JSON.stringify(preview.proposedEntry, null, 2),
  ];

  if (preview.existingEntry !== null) {
    lines.push(
      "Existing winhelm entry (secrets redacted):",
      JSON.stringify(preview.existingEntry, null, 2)
    );
  }

  for (const warning of preview.warnings) {
    lines.push("WARNING: " + warning);
  }

  return lines.join("\n");
}

export interface ConnectCliOptions {
  claudeConfigPath?: string;
  cursorConfigPath?: string;
  nodeExecutable?: string;
  entryPoint?: string;
}

export async function runConnectCliCommand(
  args: string[],
  options: ConnectCliOptions = {}
): Promise<ConnectCliResult> {
  if (args[0] !== "connect") {
    return { handled: false, exitCode: 0 };
  }

  try {
    const requestedRaw = args[1];
    const requested = parseClient(requestedRaw);
    if (!requested) {
      return {
        handled: true,
        exitCode: 1,
        error:
          "Usage: winhelm connect <claude|cursor|all> [--config <winhelm-config>] [--yes|--dry-run]",
      };
    }

    const configArg = argValue(args.slice(2), "--config");
    const dryRun = args.includes("--dry-run");
    const yes = args.includes("--yes") || args.includes("-y");

    const manager = ConfigManager.getInstance(configArg);
    await manager.init(configArg);
    const winhelmConfigPath = path.resolve(
      manager.getConfigFilePath()
    );

    const clients: SupportedMcpClient[] =
      requested === "all"
        ? ["claude", "cursor"]
        : [requested];

    const previews = [];
    for (const client of clients) {
      previews.push(
        await previewClientConnection(
          client,
          winhelmConfigPath,
          options
        )
      );
    }

    const previewText = previews
      .map(formatPreview)
      .join("\n\n");

    if (dryRun) {
      return {
        handled: true,
        exitCode: 0,
        output:
          previewText +
          "\n\nDry run only; no client config was changed.",
      };
    }

    if (!yes) {
      return {
        handled: true,
        exitCode: 2,
        output: previewText,
        error:
          "Client connection requires --yes to write config (or use --dry-run).",
      };
    }

    const results = [];
    for (const client of clients) {
      results.push(
        await applyClientConnection(
          client,
          winhelmConfigPath,
          options
        )
      );
    }

    const lines = ["WinHelm MCP client connection updated."];
    for (const result of results) {
      lines.push(
        `${result.preview.target.displayName}: ${result.preview.target.configPath}`,
        ...(result.backupPath
          ? [`Backup: ${result.backupPath}`]
          : []),
        `Bytes written: ${result.bytesWritten}`
      );
    }
    lines.push(
      "Fully restart/reload the client so it reloads MCP configuration."
    );

    return {
      handled: true,
      exitCode: 0,
      output: lines.join("\n"),
    };
  } catch (err) {
    return {
      handled: true,
      exitCode: 1,
      error: (err as Error).message || String(err),
    };
  }
}
