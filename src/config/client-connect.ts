import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteUtf8 } from "./atomic-write.js";
import { sanitizeObject } from "../utils/sanitizer.js";

export type SupportedMcpClient = "claude" | "cursor";

export interface ClientConnectionTarget {
  client: SupportedMcpClient;
  displayName: string;
  configPath: string;
  configDirectoryExists: boolean;
  configFileExists: boolean;
}

export interface WinHelmLocalMcpEntry {
  command: string;
  args: string[];
}

export interface ClientConnectionPreview {
  target: ClientConnectionTarget;
  proposedEntry: WinHelmLocalMcpEntry;
  existingEntry: unknown | null;
  changed: boolean;
  warnings: string[];
}

export interface ClientConnectionApplyResult {
  preview: ClientConnectionPreview;
  backupPath: string | null;
  bytesWritten: number;
}

export class ClientConnectionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ClientConnectionError";
  }
}

function claudeConfigPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const appData =
    env.APPDATA ||
    path.join(os.homedir(), "AppData", "Roaming");
  return path.resolve(
    appData,
    "Claude",
    "claude_desktop_config.json"
  );
}

function cursorConfigPath(
  home = os.homedir()
): string {
  return path.resolve(home, ".cursor", "mcp.json");
}

export function resolveClientConnectionTarget(
  client: SupportedMcpClient,
  overrides: {
    claudeConfigPath?: string;
    cursorConfigPath?: string;
  } = {}
): ClientConnectionTarget {
  const configPath =
    client === "claude"
      ? path.resolve(
          overrides.claudeConfigPath ?? claudeConfigPath()
        )
      : path.resolve(
          overrides.cursorConfigPath ?? cursorConfigPath()
        );

  return {
    client,
    displayName:
      client === "claude" ? "Claude Desktop" : "Cursor",
    configPath,
    configDirectoryExists: existsSync(path.dirname(configPath)),
    configFileExists: existsSync(configPath),
  };
}

function runtimeEntryPoint(): string {
  const argvEntry = process.argv[1]
    ? path.resolve(process.argv[1])
    : undefined;
  if (
    argvEntry &&
    existsSync(argvEntry) &&
    path.basename(argvEntry).toLowerCase() === "index.js"
  ) {
    return argvEntry;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  // Built package: dist/config/client-connect.js -> dist/index.js
  const builtAdjacent = path.resolve(moduleDir, "../index.js");
  if (existsSync(builtAdjacent)) return builtAdjacent;

  // Source/test runtime: src/config/client-connect.ts -> dist/index.js
  const projectBuild = path.resolve(moduleDir, "../../dist/index.js");
  if (existsSync(projectBuild)) return projectBuild;

  // Deterministic fallback for preview before a local build.
  return builtAdjacent;
}

export function buildWinHelmLocalMcpEntry(
  winhelmConfigPath: string,
  options: {
    nodeExecutable?: string;
    entryPoint?: string;
  } = {}
): WinHelmLocalMcpEntry {
  const command = path.resolve(
    options.nodeExecutable ?? process.execPath
  );
  const entryPoint = path.resolve(
    options.entryPoint ?? runtimeEntryPoint()
  );
  const configPath = path.resolve(winhelmConfigPath);

  return {
    command,
    args: [
      entryPoint,
      "--stdio",
      "--config",
      configPath,
    ],
  };
}

async function loadClientConfig(
  configPath: string
): Promise<Record<string, unknown>> {
  if (!existsSync(configPath)) return {};

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    throw new ClientConnectionError(
      "CLIENT_CONFIG_READ_FAILED",
      `Could not read client MCP config: ${(err as Error).message}`
    );
  }

  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Configuration root must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ClientConnectionError(
      "CLIENT_CONFIG_INVALID_JSON",
      `Client MCP config is not valid JSON; WinHelm will not overwrite it: ${(err as Error).message}`
    );
  }
}

function mcpServersObject(
  config: Record<string, unknown>
): Record<string, unknown> {
  const value = config.mcpServers;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientConnectionError(
      "CLIENT_CONFIG_INVALID_MCP_SERVERS",
      "Client config mcpServers must be a JSON object."
    );
  }
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export async function previewClientConnection(
  client: SupportedMcpClient,
  winhelmConfigPath: string,
  options: {
    claudeConfigPath?: string;
    cursorConfigPath?: string;
    nodeExecutable?: string;
    entryPoint?: string;
  } = {}
): Promise<ClientConnectionPreview> {
  const target = resolveClientConnectionTarget(client, options);
  const current = await loadClientConfig(target.configPath);
  const servers = mcpServersObject(current);
  const proposedEntry = buildWinHelmLocalMcpEntry(
    winhelmConfigPath,
    options
  );
  const existingRaw =
    Object.prototype.hasOwnProperty.call(servers, "winhelm")
      ? servers.winhelm
      : null;
  const existingEntry =
    existingRaw === null
      ? null
      : sanitizeObject(
          structuredClone(existingRaw) as Record<string, unknown>
        );

  const warnings: string[] = [];
  if (!target.configDirectoryExists) {
    warnings.push(
      `${target.displayName} config directory was not detected yet; it will be created if you apply this connection.`
    );
  }
  if (existingRaw !== null) {
    warnings.push(
      "An existing mcpServers.winhelm entry will be replaced after a backup is created."
    );
  }

  return {
    target,
    proposedEntry,
    existingEntry,
    changed: stableJson(existingRaw) !== stableJson(proposedEntry),
    warnings,
  };
}

async function backupExistingClientConfig(
  configPath: string
): Promise<string | null> {
  if (!existsSync(configPath)) return null;
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
  const backupPath = `${configPath}.winhelm-backup-${stamp}`;
  await fs.copyFile(configPath, backupPath);
  return backupPath;
}

export async function applyClientConnection(
  client: SupportedMcpClient,
  winhelmConfigPath: string,
  options: {
    claudeConfigPath?: string;
    cursorConfigPath?: string;
    nodeExecutable?: string;
    entryPoint?: string;
  } = {}
): Promise<ClientConnectionApplyResult> {
  const preview = await previewClientConnection(
    client,
    winhelmConfigPath,
    options
  );
  const current = await loadClientConfig(preview.target.configPath);
  const servers = mcpServersObject(current);
  const merged = {
    ...current,
    mcpServers: {
      ...servers,
      winhelm: preview.proposedEntry,
    },
  };

  const backupPath = await backupExistingClientConfig(
    preview.target.configPath
  );

  try {
    const result = await atomicWriteUtf8(
      preview.target.configPath,
      JSON.stringify(merged, null, 2) + "\n"
    );
    return {
      preview,
      backupPath,
      bytesWritten: result.bytesWritten,
    };
  } catch (err) {
    if (backupPath && existsSync(backupPath)) {
      await fs
        .copyFile(backupPath, preview.target.configPath)
        .catch(() => {});
    }
    throw new ClientConnectionError(
      "CLIENT_CONFIG_WRITE_FAILED",
      `Could not update client MCP config: ${(err as Error).message}`
    );
  }
}
