import fs from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
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
  /** How the config path was chosen (override / classic / MSIX evidence). */
  resolutionBasis?: string;
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
    message: string,
    public readonly candidates: string[] = []
  ) {
    super(message);
    this.name = "ClientConnectionError";
  }
}

export type ClaudeConfigResolutionBasis =
  | "override"
  | "classic-config"
  | "msix-config"
  | "classic-install"
  | "msix-install";

export interface ClaudeConfigResolution {
  configPath: string;
  basis: ClaudeConfigResolutionBasis;
  candidates: string[];
}

export interface ClaudeConfigCandidatePaths {
  classicConfigPath: string;
  msixConfigPaths: string[];
}

/**
 * Locates every Claude Desktop MSIX package root under
 * %LOCALAPPDATA%\Packages by name + data-directory evidence. The publisher
 * suffix of the package family name is installation-specific, so it is never
 * hard-coded; a directory only qualifies when it also holds the package's
 * virtualized Claude Roaming data directory.
 */
function claudeMsixPackageRoots(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const localAppData =
    env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local");
  const packagesDir = path.join(localAppData, "Packages");
  let entries: string[];
  try {
    entries = readdirSync(packagesDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^claude/i.test(name))
    .map((name) => path.join(packagesDir, name))
    .filter((packageDir) =>
      existsSync(
        path.join(packageDir, "LocalCache", "Roaming", "Claude")
      )
    );
}

export function claudeConfigCandidatePaths(
  env: NodeJS.ProcessEnv = process.env
): ClaudeConfigCandidatePaths {
  const appData =
    env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const classicConfigPath = path.resolve(
    appData,
    "Claude",
    "claude_desktop_config.json"
  );
  const msixConfigPaths = claudeMsixPackageRoots(env)
    .map((packageDir) =>
      path.join(
        packageDir,
        "LocalCache",
        "Roaming",
        "Claude",
        "claude_desktop_config.json"
      )
    )
    .filter((configPath) => existsSync(configPath));
  return { classicConfigPath, msixConfigPaths };
}

/**
 * Resolves the Claude Desktop MCP config target.
 *
 * Order: explicit override (parameter beats environment), an existing classic
 * config, an existing MSIX virtualized config, then installation evidence for
 * a first-time connection. Ambiguous evidence fails closed instead of
 * guessing, because writing a config the client never reads silently breaks
 * the connection.
 */
export function resolveClaudeConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { claudeConfigPath?: string } = {}
): ClaudeConfigResolution {
  const explicit =
    overrides.claudeConfigPath ?? env.WINHELM_CLAUDE_CONFIG_PATH;
  if (explicit) {
    const configPath = path.resolve(explicit);
    return {
      configPath,
      basis: "override",
      candidates: [configPath],
    };
  }

  const { classicConfigPath, msixConfigPaths } =
    claudeConfigCandidatePaths(env);
  const classicExists = existsSync(classicConfigPath);

  const existingCandidates: string[] = [
    ...(classicExists ? [classicConfigPath] : []),
    ...msixConfigPaths,
  ];
  if (existingCandidates.length > 1) {
    throw new ClientConnectionError(
      "CLAUDE_CONFIG_AMBIGUOUS",
      "Multiple existing Claude Desktop MCP configs were found; pick one explicitly via WINHELM_CLAUDE_CONFIG_PATH (candidates are listed without reading their contents).",
      existingCandidates
    );
  }
  if (classicExists) {
    return {
      configPath: classicConfigPath,
      basis: "classic-config",
      candidates: [classicConfigPath],
    };
  }
  if (msixConfigPaths.length === 1) {
    return {
      configPath: msixConfigPaths[0],
      basis: "msix-config",
      candidates: msixConfigPaths,
    };
  }

  // No existing config anywhere: fall back to installation evidence.
  const appData =
    env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localAppData =
    env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local");
  const classicInstall =
    existsSync(path.join(appData, "Claude")) ||
    existsSync(path.join(localAppData, "AnthropicClaude"));
  const msixInstalls = claudeMsixPackageRoots(env);

  if (classicInstall && msixInstalls.length > 0) {
    throw new ClientConnectionError(
      "CLAUDE_CONFIG_AMBIGUOUS",
      "Both a classic and an MSIX Claude Desktop installation were detected but neither has an MCP config yet; pick the target explicitly via WINHELM_CLAUDE_CONFIG_PATH.",
      [
        classicConfigPath,
        ...msixInstalls.map((packageDir) =>
          path.join(
            packageDir,
            "LocalCache",
            "Roaming",
            "Claude",
            "claude_desktop_config.json"
          )
        ),
      ],
    );
  }
  if (msixInstalls.length === 1) {
    const msixConfigPath = path.join(
      msixInstalls[0],
      "LocalCache",
      "Roaming",
      "Claude",
      "claude_desktop_config.json"
    );
    return {
      configPath: msixConfigPath,
      basis: "msix-install",
      candidates: [msixConfigPath],
    };
  }
  if (msixInstalls.length > 1) {
    throw new ClientConnectionError(
      "CLAUDE_CONFIG_AMBIGUOUS",
      "Multiple Claude Desktop MSIX packages were detected; pick the target explicitly via WINHELM_CLAUDE_CONFIG_PATH.",
      msixInstalls.map((packageDir) =>
        path.join(
          packageDir,
          "LocalCache",
          "Roaming",
          "Claude",
          "claude_desktop_config.json"
        )
      ),
    );
  }
  if (classicInstall) {
    return {
      configPath: classicConfigPath,
      basis: "classic-install",
      candidates: [classicConfigPath],
    };
  }

  throw new ClientConnectionError(
    "CLAUDE_CONFIG_UNRESOLVED",
    "No Claude Desktop installation was detected; set WINHELM_CLAUDE_CONFIG_PATH to the config path the client actually reads."
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
    env?: NodeJS.ProcessEnv;
  } = {}
): ClientConnectionTarget {
  const env = overrides.env ?? process.env;
  let configPath: string;
  let resolutionBasis: string | undefined;
  if (client === "claude") {
    const resolution = resolveClaudeConfigPath(env, overrides);
    configPath = resolution.configPath;
    resolutionBasis = resolution.basis;
  } else {
    configPath = path.resolve(
      overrides.cursorConfigPath ??
        env.WINHELM_CURSOR_CONFIG_PATH ??
        cursorConfigPath()
    );
  }

  return {
    client,
    displayName:
      client === "claude" ? "Claude Desktop" : "Cursor",
    configPath,
    configDirectoryExists: existsSync(path.dirname(configPath)),
    configFileExists: existsSync(configPath),
    ...(resolutionBasis ? { resolutionBasis } : {}),
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
    options.nodeExecutable ??
      process.env.WINHELM_NODE_EXECUTABLE_PATH ??
      process.execPath
  );
  const entryPoint = path.resolve(
    options.entryPoint ??
      process.env.WINHELM_SERVER_ENTRYPOINT_PATH ??
      runtimeEntryPoint()
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
  if (!existsSync(proposedEntry.command)) {
    warnings.push(
      `Node executable was not found at ${proposedEntry.command}.`
    );
  }
  if (!existsSync(proposedEntry.args[0])) {
    warnings.push(
      `WinHelm server entrypoint was not found at ${proposedEntry.args[0]}.`
    );
  }
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
  if (!existsSync(preview.proposedEntry.command)) {
    throw new ClientConnectionError(
      "NODE_EXECUTABLE_NOT_FOUND",
      `Node executable was not found: ${preview.proposedEntry.command}`
    );
  }
  if (!existsSync(preview.proposedEntry.args[0])) {
    throw new ClientConnectionError(
      "WINHELM_ENTRYPOINT_NOT_FOUND",
      `WinHelm server entrypoint was not found: ${preview.proposedEntry.args[0]}`
    );
  }

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
