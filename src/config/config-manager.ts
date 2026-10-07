import fs from "node:fs/promises";
import {
  existsSync,
  realpathSync,
  readFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../types/index.js";
import { DEFAULT_CONFIG, DEFAULT_BLOCKED_PATTERNS } from "./default-config.js";
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  detectConfigMode,
  normalizeApprovalConfig,
  validateSchemaV2Config,
  type ConfigMode,
} from "./schema-v2.js";
import {
  canonicalizeExistingAwarePath,
  checkFolderAccess,
  isInsideOrEqualPrecomputed,
  normalizePathForCompare,
  prepareFolderAccessContext,
  protectedRuleBlocksPath,
} from "../permissions/folder-access.js";
import { buildProtectedPathRules } from "../permissions/protected-paths.js";
import { setConfiguredLocale } from "../i18n/messages.js";
import { atomicWriteUtf8 } from "./atomic-write.js";

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

export interface PreparedPathAccessContext {
  readonly mode: ConfigMode;
  readonly access: "read" | "write";
  checkPathAccess(
    targetPath: string,
    options?: { denyRootMutation?: boolean; rejectReparseMutation?: boolean }
  ): { allowed: boolean; reason?: string; code?: string };
}

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private rawConfig: ServerConfig;
  private config: ServerConfig;
  private configMode: ConfigMode = "legacy";
  private configValidationErrors: string[] = [];
  private runtimeEffectivePort: number | undefined;
  /**
   * Live bearer token after an admin rotation. It shadows the token resolved at
   * startup, and is dropped whenever the manager instance is replaced.
   */
  private runtimeAuthToken: string | undefined;
  private configFilePath: string;
  private configWatcher: FSWatcher | null = null;
  private configReloadTimer: NodeJS.Timeout | null = null;
  private readonly configReloadDebounceMs = 100;
  private executionHistory: CommandLogEntry[] = [];
  private readonly maxHistoryLength = 500;

  private constructor(customConfigPath?: string) {
    this.rawConfig = { ...DEFAULT_CONFIG };
    this.config = { ...DEFAULT_CONFIG };
    setConfiguredLocale(undefined);

    if (customConfigPath) {
      this.configFilePath = path.resolve(customConfigPath);
      this.loadConfigSync();
      return;
    }

    // Check multiple candidate locations so external MCP clients (Claude/Cursor) find it regardless of CWD.
    // winhelm.local.json takes precedence over winhelm.config.json for local overrides.
    const candidates = [
      path.resolve(process.cwd(), "winhelm.local.json"),
      path.resolve(process.cwd(), "winhelm.config.json"),
      path.resolve(process.cwd(), "win-commander.config.json"),
      process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..", "winhelm.local.json") : "",
      process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..", "winhelm.config.json") : "",
      process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "winhelm.local.json") : "",
      process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "winhelm.config.json") : "",
      process.execPath ? path.resolve(path.dirname(process.execPath), "..", "winhelm.local.json") : "",
      process.execPath ? path.resolve(path.dirname(process.execPath), "..", "winhelm.config.json") : "",
      process.execPath ? path.resolve(path.dirname(process.execPath), "winhelm.local.json") : "",
      process.execPath ? path.resolve(path.dirname(process.execPath), "winhelm.config.json") : "",
      path.join(os.homedir(), ".winhelm", "local.json"),
      path.join(os.homedir(), ".winhelm", "config.json"),
      path.join(os.homedir(), ".win-commander", "config.json"),
    ].filter(Boolean);

    let chosen = candidates[1] || candidates[0];
    for (const c of candidates) {
      if (existsSync(c)) {
        chosen = c;
        break;
      }
    }
    this.configFilePath = chosen;
    this.loadConfigSync();
  }

  private refreshEffectiveConfig(): void {
    const detectedMode = detectConfigMode(this.rawConfig as unknown as Record<string, unknown>);

    if (detectedMode === "legacy") {
      this.configMode = "legacy";
      this.configValidationErrors = [];
      this.config = { ...this.rawConfig };
      setConfiguredLocale(this.config.ui?.language);
      return;
    }

    if (detectedMode === "invalid") {
      this.configMode = "invalid";
      this.configValidationErrors = [
        `Unsupported schemaVersion "${String(this.rawConfig.schemaVersion)}"; expected 2 or omit schemaVersion for legacy mode`,
      ];
      this.config = {
        ...this.rawConfig,
        folders: [],
        terminal: { mode: "off" },
        toolPolicy: {},
        approval: normalizeApprovalConfig(DEFAULT_APPROVAL_CONFIG),
        network: { ...DEFAULT_NETWORK_CONFIG },
      };
      setConfiguredLocale(this.config.ui?.language);
      return;
    }

    const validation = validateSchemaV2Config(
      this.rawConfig as unknown as Record<string, unknown>
    );
    this.configMode = validation.valid ? "v2" : "invalid";
    this.configValidationErrors = [...validation.errors];

    // schemaVersion=2 is the authoritative permission model. Legacy governed
    // fields may remain in the raw file for migration diagnostics/backups, but
    // they must not influence runtime authorization once v2 is selected.
    const {
      allowedDirectories: _legacyAllowedDirectories,
      readOnly: _legacyReadOnly,
      profile: _legacyProfile,
      customTools: _legacyCustomTools,
      ...nonGovernedRaw
    } = this.rawConfig;

    this.config = {
      ...nonGovernedRaw,
      ...validation.value,
      // Keep legacy-only helpers fail-closed/non-authoritative if an old call
      // site still inspects them while the v2 wrapper owns authorization.
      allowedDirectories: [],
      readOnly: false,
      profile: undefined,
      customTools: undefined,
    } as ServerConfig;
    setConfiguredLocale(this.config.ui?.language);
  }

  private applyRawUpdates(updates: Partial<ServerConfig> | Record<string, unknown>): void {
    this.rawConfig = {
      ...this.rawConfig,
      ...updates,
    } as ServerConfig;
    this.refreshEffectiveConfig();
  }

  private loadConfigSync(): void {
    if (this.configFilePath && existsSync(this.configFilePath)) {
      try {
        const raw = readFileSync(this.configFilePath, "utf-8");
        const cleanRaw = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        if (!cleanRaw.trim()) return;
        const parsed = JSON.parse(cleanRaw);
        this.applyRawUpdates(parsed);
      } catch (err) {
        console.error(`[ConfigManager] FATAL: Syntax error in configuration file (${this.configFilePath}):`, (err as Error).message);
        throw new Error(`Failed to parse configuration file (${this.configFilePath}): ${(err as Error).message}`);
      }
    }
  }

  public static getInstance(customConfigPath?: string): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager(customConfigPath);
    } else if (
      customConfigPath &&
      ConfigManager.instance.configFilePath !== path.resolve(customConfigPath)
    ) {
      ConfigManager.instance.stopWatchingConfig();
      ConfigManager.instance = new ConfigManager(customConfigPath);
    }
    return ConfigManager.instance;
  }

  public static resetInstance(customConfigPath?: string): ConfigManager {
    ConfigManager.instance?.stopWatchingConfig();
    ConfigManager.instance = new ConfigManager(customConfigPath);
    return ConfigManager.instance;
  }

  public getConfigFilePath(): string {
    return this.configFilePath;
  }

  private replaceRawConfigFromFile(
    parsed: Record<string, unknown>
  ): void {
    this.rawConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
    } as ServerConfig;
  }

  private applyEnvironmentOverrides(): void {
    const rawModeBeforeEnv = detectConfigMode(
      this.rawConfig as unknown as Record<string, unknown>
    );

    if (process.env.MCP_AUTH_TOKEN) {
      this.rawConfig.authToken = process.env.MCP_AUTH_TOKEN;
    }

    if (process.env.MCP_ALLOWED_DIRECTORIES) {
      const envDirectories =
        process.env.MCP_ALLOWED_DIRECTORIES.split(",")
          .map((p) => p.trim())
          .filter(Boolean);

      if (rawModeBeforeEnv === "v2") {
        const readOnlyEnv =
          process.env.MCP_READ_ONLY === "true" ||
          process.env.MCP_READ_ONLY === "1";
        this.rawConfig.folders = envDirectories
          .filter((entry) => !isWildcardAllowAll([entry]))
          .map((folderPath) => ({
            path: folderPath,
            permission: readOnlyEnv ? "read" : "readwrite",
          }));
      } else {
        this.rawConfig.allowedDirectories = envDirectories;
      }
    }

    if (process.env.MCP_BLOCKED_COMMANDS) {
      const extraBlocked = process.env.MCP_BLOCKED_COMMANDS.split(",")
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      this.rawConfig.blockedCommands = Array.from(
        new Set([
          ...this.rawConfig.blockedCommands,
          ...extraBlocked,
        ])
      );
    }

    if (process.env.MCP_ALLOWED_HOSTS) {
      const extraHosts = process.env.MCP_ALLOWED_HOSTS.split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      const existing = this.rawConfig.allowedHosts || [];
      this.rawConfig.allowedHosts = Array.from(
        new Set([...existing, ...extraHosts])
      );
    }

    if (
      process.env.MCP_READ_ONLY === "true" ||
      process.env.MCP_READ_ONLY === "1"
    ) {
      if (rawModeBeforeEnv === "v2") {
        this.rawConfig.folders = (this.rawConfig.folders ?? []).map(
          (folder) => ({
            ...folder,
            permission: "read",
          })
        );
        this.rawConfig.terminal = {
          ...(this.rawConfig.terminal ?? { mode: "off" }),
          mode: "off",
        };
      } else {
        this.rawConfig.readOnly = true;
      }
    }

    if (
      process.env.WINHELM_ALLOW_SYSTEM_EXEC === "true" ||
      process.env.WINHELM_ALLOW_SYSTEM_EXEC === "1" ||
      process.env.MCP_ALLOW_SYSTEM_EXEC === "true" ||
      process.env.MCP_ALLOW_SYSTEM_EXEC === "1"
    ) {
      this.rawConfig.allowSystemExecution = true;
    } else if (
      process.env.WINHELM_ALLOW_SYSTEM_EXEC === "false" ||
      process.env.WINHELM_ALLOW_SYSTEM_EXEC === "0" ||
      process.env.MCP_ALLOW_SYSTEM_EXEC === "false" ||
      process.env.MCP_ALLOW_SYSTEM_EXEC === "0"
    ) {
      this.rawConfig.allowSystemExecution = false;
    }
  }

  private enterFailClosedConfig(reason: string): void {
    this.configMode = "invalid";
    this.configValidationErrors = [reason];
    this.config = {
      ...this.rawConfig,
      folders: [],
      terminal: { mode: "off" },
      toolPolicy: {},
      approval: normalizeApprovalConfig(DEFAULT_APPROVAL_CONFIG),
      network: { ...DEFAULT_NETWORK_CONFIG },
      allowedDirectories: [],
      readOnly: false,
      profile: undefined,
      customTools: undefined,
    };
    setConfiguredLocale(this.config.ui?.language);
  }

  /**
   * Initialize config by reading from file, custom path, or in-memory override object
   */
  public async init(configOrPath?: string | Partial<ServerConfig>): Promise<void> {
    if (configOrPath && typeof configOrPath === "object") {
      this.applyRawUpdates(configOrPath);
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
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Configuration root must be a JSON object.");
          }
          this.replaceRawConfigFromFile(parsed as Record<string, unknown>);
          console.log(`[ConfigManager] Loaded configuration from ${this.configFilePath}`);
        }
      } else if (typeof configOrPath === "string") {
        console.warn(`[ConfigManager] Specified config file not found: ${this.configFilePath}`);
      }
    } catch (err) {
      console.error(`[ConfigManager] FATAL: Could not read config file (${this.configFilePath}):`, (err as Error).message);
      throw new Error(`Failed to load configuration file (${this.configFilePath}): ${(err as Error).message}`);
    }

    this.applyEnvironmentOverrides();

    this.refreshEffectiveConfig();
    this.logSecurityWarnings();
  }

  private async reloadConfigFromDisk(): Promise<boolean> {
    try {
      if (!existsSync(this.configFilePath)) {
        throw new Error("Configuration file was removed.");
      }

      const raw = await fs.readFile(this.configFilePath, "utf8");
      const cleanRaw =
        raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      if (!cleanRaw.trim()) {
        throw new Error("Configuration file is empty.");
      }

      const parsed = JSON.parse(cleanRaw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Configuration root must be a JSON object.");
      }

      this.replaceRawConfigFromFile(
        parsed as Record<string, unknown>
      );
      this.applyEnvironmentOverrides();
      this.refreshEffectiveConfig();
      this.logSecurityWarnings();

      console.log(
        `[ConfigManager] Hot-reloaded configuration from ${this.configFilePath}`
      );
      return true;
    } catch (err) {
      const reason =
        `Hot reload failed for ${this.configFilePath}: ` +
        ((err as Error).message || String(err));
      this.enterFailClosedConfig(reason);
      console.error(`[ConfigManager] ${reason}`);
      return false;
    }
  }

  private scheduleConfigReload(): void {
    if (this.configReloadTimer) {
      clearTimeout(this.configReloadTimer);
    }

    this.configReloadTimer = setTimeout(() => {
      this.configReloadTimer = null;
      void this.reloadConfigFromDisk();
    }, this.configReloadDebounceMs);
  }

  public startWatchingConfig(): boolean {
    this.stopWatchingConfig();

    const directory = path.dirname(this.configFilePath);
    if (!existsSync(directory)) {
      console.warn(
        `[ConfigManager] Config watch directory does not exist: ${directory}`
      );
      return false;
    }

    const expectedName = path.basename(this.configFilePath);
    const expectedCompare =
      process.platform === "win32"
        ? expectedName.toLowerCase()
        : expectedName;

    try {
      this.configWatcher = watch(
        directory,
        { persistent: false },
        (_eventType, filename) => {
          if (filename) {
            const observed = filename.toString();
            const observedCompare =
              process.platform === "win32"
                ? observed.toLowerCase()
                : observed;
            if (observedCompare !== expectedCompare) return;
          }
          this.scheduleConfigReload();
        }
      );

      this.configWatcher.on("error", (err) => {
        console.error(
          `[ConfigManager] Config watcher error for ${this.configFilePath}:`,
          err
        );
      });
      this.configWatcher.unref?.();
      return true;
    } catch (err) {
      console.error(
        `[ConfigManager] Failed to watch config file ${this.configFilePath}:`,
        err
      );
      this.configWatcher = null;
      return false;
    }
  }

  public stopWatchingConfig(): void {
    if (this.configReloadTimer) {
      clearTimeout(this.configReloadTimer);
      this.configReloadTimer = null;
    }
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = null;
    }
  }

  private static hasLoggedSystemExecWarning = false;
  private static hasWarnedWildcardDirectories = false;

  public static resetWarningFlags(): void {
    ConfigManager.hasLoggedSystemExecWarning = false;
    ConfigManager.hasWarnedWildcardDirectories = false;
  }

  public logSecurityWarnings(): void {
    if (this.configMode === "legacy" && this.config.allowSystemExecution === true && !ConfigManager.hasLoggedSystemExecWarning) {
      ConfigManager.hasLoggedSystemExecWarning = true;
      console.warn("[SECURITY] ⚠️  System execution enabled - Runtime binaries on C: are now accessible");
    }
    if (this.configMode === "legacy" && isWildcardAllowAll(this.config.allowedDirectories) && !ConfigManager.hasWarnedWildcardDirectories) {
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

  public getConfigMode(): ConfigMode {
    return this.configMode;
  }

  public getConfigValidationErrors(): readonly string[] {
    return this.configValidationErrors;
  }

  public setRuntimeEffectivePort(port: number | undefined): void {
    this.runtimeEffectivePort =
      typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
        ? port
        : undefined;
  }

  public getRuntimeEffectivePort(): number | undefined {
    return this.runtimeEffectivePort;
  }

  public setRuntimeAuthToken(token: string | undefined): void {
    this.runtimeAuthToken =
      typeof token === "string" && token.trim().length > 0
        ? token.trim()
        : undefined;
  }

  public getRuntimeAuthToken(): string | undefined {
    return this.runtimeAuthToken;
  }

  public async updateConfig(updates: Partial<ServerConfig>, persist = false): Promise<void> {
    if (!persist) {
      this.applyRawUpdates(updates);
      return;
    }

    const nextRaw = {
      ...this.rawConfig,
      ...updates,
    } as ServerConfig;

    try {
      await atomicWriteUtf8(
        this.configFilePath,
        JSON.stringify(nextRaw, null, 2)
      );
    } catch (err) {
      console.error(
        `[ConfigManager] Failed to persist config to ${this.configFilePath}:`,
        err
      );
      throw err;
    }

    this.rawConfig = nextRaw;
    this.refreshEffectiveConfig();
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
    if (this.configMode === "legacy" && this.config.allowSystemExecution === false) {
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

  private getProtectedPathRules(
    options: { includeInstallRoot?: boolean } = {}
  ): ReturnType<typeof buildProtectedPathRules> {
    const installRoot =
      options.includeInstallRoot === false
        ? undefined
        : this.getSchemaV2InstallRoot();
    return buildProtectedPathRules({
      configFilePath: this.configFilePath,
      dataDir: path.join(os.homedir(), ".winhelm"),
      logDir: path.resolve(process.cwd(), "logs"),
      ...(installRoot ? { installRoot } : {}),
    });
  }

  private protectedPathDenial(
    targetPath: string
  ): { allowed: false; code: string; reason: string } | undefined {
    // Legacy mode protects the config, data and log paths (where the auth token
    // and audit trail live) but keeps the install-root rule to schema-v2, so
    // v1.2.1 workflows that edit files next to the executable still work.
    const rules = this.getProtectedPathRules({ includeInstallRoot: false });
    if (rules.length === 0) return undefined;

    let canonicalTarget: string;
    try {
      canonicalTarget = canonicalizeExistingAwarePath(targetPath);
    } catch {
      // A path that cannot be canonicalized is not treated as protected here;
      // the ordinary allowedDirectories check still has to approve it.
      try {
        canonicalTarget = path.resolve(String(targetPath).normalize("NFKC"));
      } catch {
        return undefined;
      }
    }

    for (const rule of rules) {
      try {
        if (protectedRuleBlocksPath(rule, canonicalTarget)) {
          return {
            allowed: false,
            code: "FOLDER_PROTECTED_PATH",
            reason: `Path is protected by WinHelm security policy: ${rule.label || rule.path}`,
          };
        }
      } catch {
        // A malformed protected rule never grants access.
      }
    }

    return undefined;
  }

  /**
   * Validate if a filesystem path is permitted under allowedDirectories
   */
  private isLegacyPathAllowed(targetPath: string): { allowed: boolean; reason?: string; code?: string } {
    // WinHelm's own config/data/log/install paths stay denied in legacy mode
    // too: they hold the auth token, admin material and the active
    // configuration. v1.2.1 relied on allowedDirectories alone, so a wildcard
    // legacy config used to expose them to tools.
    const protectedDenial = this.protectedPathDenial(targetPath);
    if (protectedDenial) return protectedDenial;

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

  private getSchemaV2InstallRoot(): string | undefined {
    try {
      const moduleFile = fileURLToPath(import.meta.url);
      return path.resolve(path.dirname(moduleFile), "../..");
    } catch {
      return undefined;
    }
  }

  /**
   * Pre-canonicalize invariant authorization state for repeated batch checks.
   * Scoped to the current configuration snapshot; does not maintain a global
   * stale cache across updates or reloads.
   */
  public preparePathAccessContext(
    access: "read" | "write" = "read",
    options: { denyRootMutation?: boolean; rejectReparseMutation?: boolean } = {}
  ): PreparedPathAccessContext {
    const mode = this.configMode;

    if (mode === "invalid") {
      return {
        mode,
        access,
        checkPathAccess: () => ({
          allowed: false,
          code: "CONFIG_INVALID",
          reason: "WinHelm configuration is invalid; filesystem access is fail-closed.",
        }),
      };
    }

    if (mode === "v2") {
      const installRootAccess =
        this.config.development?.installRootAccess ?? "none";
      const allowInstallRootAccess =
        installRootAccess === "readwrite" ||
        (access === "read" && installRootAccess === "read");
      const protectedPaths = this.getProtectedPathRules({
        includeInstallRoot: !allowInstallRootAccess,
      });

      const folderContext = prepareFolderAccessContext(
        this.config.folders ?? [],
        protectedPaths
      );

      const defaultDenyRootMutation = options.denyRootMutation;
      const defaultRejectReparseMutation =
        options.rejectReparseMutation ?? (access === "write");

      return {
        mode,
        access,
        checkPathAccess: (
          targetPath: string,
          callOptions: {
            denyRootMutation?: boolean;
            rejectReparseMutation?: boolean;
          } = {}
        ) => {
          const result = checkFolderAccess(
            targetPath,
            access,
            this.config.folders ?? [],
            {
              denyRootMutation:
                callOptions.denyRootMutation ?? defaultDenyRootMutation,
              rejectReparseMutation:
                callOptions.rejectReparseMutation ?? defaultRejectReparseMutation,
              preparedContext: folderContext,
            }
          );
          return {
            allowed: result.allowed,
            reason: result.reason,
            code: result.code,
          };
        },
      };
    }

    // Legacy mode
    const rules = this.getProtectedPathRules({ includeInstallRoot: false });
    const preparedRules = rules
      .map((r) => {
        try {
          const canonical = canonicalizeExistingAwarePath(r.path);
          return {
            rule: r,
            canonical,
            cmp: normalizePathForCompare(canonical),
          };
        } catch {
          return undefined;
        }
      })
      .filter((p): p is { rule: (typeof rules)[0]; canonical: string; cmp: string } => Boolean(p));

    const isWildcard = isWildcardAllowAll(this.config.allowedDirectories);
    const noAllowedDirs =
      !this.config.allowedDirectories ||
      this.config.allowedDirectories.length === 0;

    const preparedDirs: string[] = [];
    if (!isWildcard && !noAllowedDirs) {
      for (const dir of this.config.allowedDirectories ?? []) {
        let cleanDir = dir.trim();
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
        preparedDirs.push(normDir);
      }
    }

    return {
      mode,
      access,
      checkPathAccess: (targetPath: string) => {
        let canonicalTarget: string;
        try {
          canonicalTarget = canonicalizeExistingAwarePath(targetPath);
        } catch {
          try {
            canonicalTarget = path.resolve(
              String(targetPath).normalize("NFKC")
            );
          } catch {
            return {
              allowed: false,
              reason: `Access to path "${targetPath}" is forbidden by allowedDirectories policy.`,
            };
          }
        }

        const targetCmp = normalizePathForCompare(canonicalTarget);
        for (const p of preparedRules) {
          const blocked =
            p.rule.kind === "tree"
              ? isInsideOrEqualPrecomputed(p.cmp, targetCmp)
              : p.cmp === targetCmp;
          if (blocked) {
            return {
              allowed: false,
              code: "FOLDER_PROTECTED_PATH",
              reason: `Path is protected by WinHelm security policy: ${p.rule.label || p.rule.path}`,
            };
          }
        }

        if (isWildcard) {
          return { allowed: true };
        }
        if (noAllowedDirs) {
          return {
            allowed: false,
            reason: `Access to path "${targetPath}" is blocked: no allowedDirectories configured. Set allowedDirectories to specific paths, or ["*"] to allow all (not recommended for public exposure).`,
          };
        }

        const targetWithSep = targetCmp.endsWith(path.sep)
          ? targetCmp
          : targetCmp + path.sep;

        const isAllowed = preparedDirs.some(
          (normDir) =>
            targetWithSep.startsWith(normDir) ||
            targetCmp === normDir.slice(0, -1)
        );

        if (!isAllowed) {
          return {
            allowed: false,
            reason: `Access to path "${targetPath}" is forbidden by allowedDirectories policy. Allowed roots: ${this.config.allowedDirectories?.join(", ")}`,
          };
        }

        return { allowed: true };
      },
    };
  }

  /**
   * Unified filesystem authorization bridge.
   *
   * Legacy mode preserves v1.2.1 allowedDirectories behavior.
   * Schema-v2 uses folders/read-readwrite semantics plus protected paths.
   * Invalid config is always fail-closed.
   */
  public checkPathAccess(
    targetPath: string,
    access: "read" | "write" = "read",
    options: {
      denyRootMutation?: boolean;
      rejectReparseMutation?: boolean;
      preparedContext?: PreparedPathAccessContext;
    } = {}
  ): { allowed: boolean; reason?: string; code?: string } {
    if (options.preparedContext) {
      return options.preparedContext.checkPathAccess(targetPath, options);
    }

    if (this.configMode === "invalid") {
      return {
        allowed: false,
        code: "CONFIG_INVALID",
        reason: "WinHelm configuration is invalid; filesystem access is fail-closed.",
      };
    }

    if (this.configMode === "v2") {
      const installRootAccess =
        this.config.development?.installRootAccess ?? "none";
      const allowInstallRootAccess =
        installRootAccess === "readwrite" ||
        (access === "read" && installRootAccess === "read");
      const protectedPaths = this.getProtectedPathRules({
        includeInstallRoot: !allowInstallRootAccess,
      });

      const result = checkFolderAccess(
        targetPath,
        access,
        this.config.folders ?? [],
        {
          denyRootMutation: options.denyRootMutation,
          rejectReparseMutation:
            options.rejectReparseMutation ?? access === "write",
          protectedPaths,
        }
      );

      return {
        allowed: result.allowed,
        reason: result.reason,
        code: result.code,
      };
    }

    return this.isLegacyPathAllowed(targetPath);
  }

  /**
   * Backward-compatible read-oriented path check. New mutation call sites
   * should use checkPathAccess(path, "write", ...).
   */
  public isPathAllowed(targetPath: string): { allowed: boolean; reason?: string } {
    return this.checkPathAccess(targetPath, "read");
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
