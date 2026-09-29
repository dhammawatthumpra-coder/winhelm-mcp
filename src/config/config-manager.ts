import fs from "node:fs/promises";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ServerConfig } from "../types/index.js";
import { DEFAULT_CONFIG, DEFAULT_BLOCKED_PATTERNS } from "./default-config.js";

export interface CommandLogEntry {
  id: string;
  timestamp: string;
  command: string;
  cwd?: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export function isWildcardAllowAll(dirs: string[] | undefined): boolean {
  if (!dirs || dirs.length === 0) return false;
  return dirs.some((d) => {
    const trimmed = d.trim().toLowerCase();
    return trimmed === "*" || trimmed === "all";
  });
}

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private config: ServerConfig;
  private configFilePath: string;
  private executionHistory: CommandLogEntry[] = [];
  private readonly maxHistoryLength = 500;

  private constructor(customConfigPath?: string) {
    this.config = { ...DEFAULT_CONFIG };

    if (customConfigPath) {
      this.configFilePath = path.resolve(customConfigPath);
      this.loadConfigSync();
      return;
    }

    // Check multiple candidate locations so external MCP clients (Claude/Cursor) find it regardless of CWD
    const candidates = [
      path.resolve(process.cwd(), "winhelm.config.json"),
      path.resolve(process.cwd(), "win-commander.config.json"),
      process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..", "winhelm.config.json") : "",
      process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "winhelm.config.json") : "",
      process.execPath ? path.resolve(path.dirname(process.execPath), "..", "winhelm.config.json") : "",
      process.execPath ? path.resolve(path.dirname(process.execPath), "winhelm.config.json") : "",
      path.join(os.homedir(), ".winhelm", "config.json"),
      path.join(os.homedir(), ".win-commander", "config.json"),
    ].filter(Boolean);

    let chosen = candidates[0];
    for (const c of candidates) {
      if (existsSync(c)) {
        chosen = c;
        break;
      }
    }
    this.configFilePath = chosen;
    this.loadConfigSync();
  }

  private loadConfigSync(): void {
    if (this.configFilePath && existsSync(this.configFilePath)) {
      try {
        const raw = readFileSync(this.configFilePath, "utf-8");
        const cleanRaw = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        if (!cleanRaw.trim()) return;
        const parsed = JSON.parse(cleanRaw);
        this.config = {
          ...this.config,
          ...parsed,
        };
      } catch (err) {
        console.error(`[ConfigManager] FATAL: Syntax error in configuration file (${this.configFilePath}):`, (err as Error).message);
        throw new Error(`Failed to parse configuration file (${this.configFilePath}): ${(err as Error).message}`);
      }
    }
  }

  public static getInstance(customConfigPath?: string): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager(customConfigPath);
    } else if (customConfigPath && ConfigManager.instance.configFilePath !== path.resolve(customConfigPath)) {
      ConfigManager.instance = new ConfigManager(customConfigPath);
    }
    return ConfigManager.instance;
  }

  public static resetInstance(customConfigPath?: string): ConfigManager {
    ConfigManager.instance = new ConfigManager(customConfigPath);
    return ConfigManager.instance;
  }

  public getConfigFilePath(): string {
    return this.configFilePath;
  }

  /**
   * Initialize config by reading from file, custom path, or in-memory override object
   */
  public async init(configOrPath?: string | Partial<ServerConfig>): Promise<void> {
    if (configOrPath && typeof configOrPath === "object") {
      this.config = {
        ...this.config,
        ...configOrPath,
      };
      return;
    }

    if (typeof configOrPath === "string") {
      this.configFilePath = path.resolve(configOrPath);
    }
    try {
      if (existsSync(this.configFilePath)) {
        const raw = await fs.readFile(this.configFilePath, "utf-8");
        const cleanRaw = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        if (cleanRaw.trim()) {
          const parsed = JSON.parse(cleanRaw);
          this.config = {
            ...this.config,
            ...parsed,
          };
          console.log(`[ConfigManager] Loaded configuration from ${this.configFilePath}`);
        }
      } else if (typeof configOrPath === "string") {
        console.warn(`[ConfigManager] Specified config file not found: ${this.configFilePath}`);
      }
    } catch (err) {
      console.error(`[ConfigManager] FATAL: Could not read config file (${this.configFilePath}):`, (err as Error).message);
      throw new Error(`Failed to load configuration file (${this.configFilePath}): ${(err as Error).message}`);
    }

    // Apply environment variables overrides
    if (process.env.MCP_AUTH_TOKEN) {
      this.config.authToken = process.env.MCP_AUTH_TOKEN;
    }
    if (process.env.MCP_ALLOWED_DIRECTORIES) {
      this.config.allowedDirectories = process.env.MCP_ALLOWED_DIRECTORIES.split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    }
    if (process.env.MCP_BLOCKED_COMMANDS) {
      const extraBlocked = process.env.MCP_BLOCKED_COMMANDS.split(",")
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      this.config.blockedCommands = Array.from(new Set([...this.config.blockedCommands, ...extraBlocked]));
    }
    if (process.env.MCP_ALLOWED_HOSTS) {
      const extraHosts = process.env.MCP_ALLOWED_HOSTS.split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      const existing = this.config.allowedHosts || [];
      this.config.allowedHosts = Array.from(new Set([...existing, ...extraHosts]));
    }
    if (process.env.MCP_READ_ONLY === "true" || process.env.MCP_READ_ONLY === "1") {
      this.config.readOnly = true;
    }
    if (
      process.env.WINHELM_ALLOW_SYSTEM_EXEC === "true" ||
      process.env.WINHELM_ALLOW_SYSTEM_EXEC === "1" ||
      process.env.MCP_ALLOW_SYSTEM_EXEC === "true" ||
      process.env.MCP_ALLOW_SYSTEM_EXEC === "1"
    ) {
      this.config.allowSystemExecution = true;
    }

    this.logSecurityWarnings();
  }

  private static hasLoggedSystemExecWarning = false;
  private static hasWarnedWildcardDirectories = false;

  public static resetWarningFlags(): void {
    ConfigManager.hasLoggedSystemExecWarning = false;
    ConfigManager.hasWarnedWildcardDirectories = false;
  }

  public logSecurityWarnings(): void {
    if (this.config.allowSystemExecution === true && !ConfigManager.hasLoggedSystemExecWarning) {
      ConfigManager.hasLoggedSystemExecWarning = true;
      console.warn("[SECURITY] ⚠️  System execution enabled - Runtime binaries on C: are now accessible");
    }
    if (isWildcardAllowAll(this.config.allowedDirectories) && !ConfigManager.hasWarnedWildcardDirectories) {
      ConfigManager.hasWarnedWildcardDirectories = true;
      console.warn("[SECURITY] ⚠️  allowedDirectories set to wildcard '*' - Filesystem boundary is open to all paths");
    }
  }

  public isReadOnly(): boolean {
    return !!this.config.readOnly;
  }

  public getConfig(): Readonly<ServerConfig> {
    return this.config;
  }

  public async updateConfig(updates: Partial<ServerConfig>, persist = false): Promise<void> {
    this.config = { ...this.config, ...updates };
    if (!persist) return;
    try {
      const dir = path.dirname(this.configFilePath);
      if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
      }
      await fs.writeFile(this.configFilePath, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (err) {
      console.error(`[ConfigManager] Failed to persist config to ${this.configFilePath}:`, err);
    }
  }

  /**
   * Validate if a command is allowed to run
   */
  public isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
    const normalized = command.trim().toLowerCase();
    for (const blocked of this.config.blockedCommands) {
      if (normalized.includes(blocked.toLowerCase())) {
        return {
          allowed: false,
          reason: `Command execution blocked by security policy: matches blocked pattern "${blocked}"`,
        };
      }
    }

    // Check regex blocked patterns
    const patterns = this.config.blockedCommandPatterns || DEFAULT_BLOCKED_PATTERNS;
    for (const pattern of patterns) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(command)) {
          return {
            allowed: false,
            reason: `Command execution blocked by security policy: matches dangerous pattern "${pattern}"`,
          };
        }
      } catch {
        // ignore invalid custom regex pattern
      }
    }

    // If allowSystemExecution is explicitly false, strictly block referencing unallowed paths in commands
    if (this.config.allowSystemExecution === false) {
      if (
        this.config.allowedDirectories &&
        this.config.allowedDirectories.length > 0 &&
        !isWildcardAllowAll(this.config.allowedDirectories)
      ) {
        // Extract absolute Windows paths like C:\Windows\System32\cmd.exe or D:/project/file
        const pathMatches = command.match(/[A-Za-z]:[\\/][^\s"'`|;&]*/g);
        if (pathMatches) {
          for (const token of pathMatches) {
            const check = this.isPathAllowed(token);
            if (!check.allowed) {
              return {
                allowed: false,
                reason: `Command execution blocked: references forbidden path "${token}" outside allowedDirectories (${this.config.allowedDirectories.join(", ")})`,
              };
            }
          }
        }

        // Also check standalone drive references like "C:" or "D:"
        const bareDriveMatches = command.match(/\b([a-zA-Z]):(?=[\s"'`|;&]|$)/g);
        if (bareDriveMatches) {
          for (const match of bareDriveMatches) {
            const driveLetter = match[0].toUpperCase() + ":\\";
            const check = this.isPathAllowed(driveLetter);
            if (!check.allowed) {
              return {
                allowed: false,
                reason: `Command execution blocked: references forbidden drive "${match}" outside allowedDirectories (${this.config.allowedDirectories.join(", ")})`,
              };
            }
          }
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Validate if a filesystem path is permitted under allowedDirectories
   */
  public isPathAllowed(targetPath: string): { allowed: boolean; reason?: string } {
    if (isWildcardAllowAll(this.config.allowedDirectories)) {
      return { allowed: true };
    }
    if (!this.config.allowedDirectories || this.config.allowedDirectories.length === 0) {
      return {
        allowed: false,
        reason: `Access to path "${targetPath}" is blocked: no allowedDirectories configured. Set allowedDirectories to specific paths, or ["*"] to allow all (not recommended for public exposure).`,
      };
    }

    // Normalize Unicode (e.g. full-width dots ．． or full-width drive letters Ｃ：) to prevent normalization bypasses
    const normalizedInput = typeof targetPath === "string" ? targetPath.normalize("NFKC") : targetPath;
    let resolvedTarget = path.resolve(normalizedInput);
    // Resolve symlinks / junctions to prevent directory traversal escapes
    try {
      if (existsSync(resolvedTarget)) {
        resolvedTarget = realpathSync(resolvedTarget);
      } else {
        // If file doesn't exist yet, resolve the nearest existing parent directory
        let cur = path.dirname(resolvedTarget);
        while (cur && !existsSync(cur)) {
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
        if (existsSync(cur)) {
          const realCur = realpathSync(cur);
          const rel = path.relative(cur, resolvedTarget);
          resolvedTarget = path.resolve(realCur, rel);
        }
      }
    } catch {
      // fallback to path.resolve if realpath fails
    }

    const normTarget = resolvedTarget.toLowerCase();
    const targetWithSep = normTarget.endsWith(path.sep)
      ? normTarget
      : normTarget + path.sep;

    const isAllowed = this.config.allowedDirectories.some((dir) => {
      let cleanDir = dir.trim();
      // Handle drive letter variations e.g. "D:", "D", "d:\", "d:/"
      if (/^[a-zA-Z]:?[\\/]?$/.test(cleanDir)) {
        cleanDir = cleanDir[0].toUpperCase() + ":\\";
      }

      let resolvedDir = path.resolve(cleanDir);
      try {
        if (existsSync(resolvedDir)) {
          resolvedDir = realpathSync(resolvedDir);
        }
      } catch {
        // fallback
      }

      let normDir = resolvedDir.toLowerCase();
      if (!normDir.endsWith(path.sep)) {
        normDir += path.sep;
      }

      return targetWithSep.startsWith(normDir) || normTarget === normDir.slice(0, -1);
    });

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `Access to path "${targetPath}" is forbidden by allowedDirectories policy. Allowed roots: ${this.config.allowedDirectories.join(", ")}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record command execution for auditing
   */
  public logExecution(entry: CommandLogEntry): void {
    this.executionHistory.push(entry);
    if (this.executionHistory.length > this.maxHistoryLength) {
      this.executionHistory.shift();
    }
  }

  public getHistory(): ReadonlyArray<CommandLogEntry> {
    return this.executionHistory;
  }
}
