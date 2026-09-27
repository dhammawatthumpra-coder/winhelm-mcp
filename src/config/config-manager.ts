import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ServerConfig } from "../types/index.js";
import { DEFAULT_CONFIG } from "./default-config.js";

export interface CommandLogEntry {
  id: string;
  timestamp: string;
  command: string;
  cwd?: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private config: ServerConfig;
  private configFilePath: string;
  private executionHistory: CommandLogEntry[] = [];
  private readonly maxHistoryLength = 500;

  private constructor() {
    this.config = { ...DEFAULT_CONFIG };

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
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Initialize config by reading from file and environment variables
   */
  public async init(): Promise<void> {
    try {
      if (existsSync(this.configFilePath)) {
        const raw = await fs.readFile(this.configFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        this.config = {
          ...this.config,
          ...parsed,
        };
        console.log(`[ConfigManager] Loaded configuration from ${this.configFilePath}`);
      }
    } catch (err) {
      console.warn(`[ConfigManager] Could not read config file (${this.configFilePath}):`, (err as Error).message);
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
    if (process.env.MCP_READ_ONLY === "true" || process.env.MCP_READ_ONLY === "1") {
      this.config.readOnly = true;
    }
  }

  public isReadOnly(): boolean {
    return !!this.config.readOnly;
  }

  public getConfig(): Readonly<ServerConfig> {
    return this.config;
  }

  public async updateConfig(updates: Partial<ServerConfig>, persist = true): Promise<void> {
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

    // If allowSystemExecution is explicitly false, strictly block referencing unallowed drives in commands
    if (this.config.allowSystemExecution === false) {
      if (this.config.allowedDirectories && this.config.allowedDirectories.length > 0) {
        const driveMatches = command.match(/\b([a-zA-Z]):(?=[\\/\s"']|$)/g);
        if (driveMatches) {
          for (const match of driveMatches) {
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
    if (!this.config.allowedDirectories || this.config.allowedDirectories.length === 0) {
      return { allowed: true };
    }

    const resolvedTarget = path.resolve(targetPath).toLowerCase();
    const targetWithSep = resolvedTarget.endsWith(path.sep)
      ? resolvedTarget
      : resolvedTarget + path.sep;

    const isAllowed = this.config.allowedDirectories.some((dir) => {
      let cleanDir = dir.trim();
      // Handle drive letter variations e.g. "D:", "D", "d:\", "d:/"
      if (/^[a-zA-Z]:?[\\/]?$/.test(cleanDir)) {
        cleanDir = cleanDir[0].toUpperCase() + ":\\";
      }

      let resolvedDir = path.resolve(cleanDir).toLowerCase();
      if (!resolvedDir.endsWith(path.sep)) {
        resolvedDir += path.sep;
      }

      return targetWithSep.startsWith(resolvedDir) || resolvedTarget === resolvedDir.slice(0, -1);
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
