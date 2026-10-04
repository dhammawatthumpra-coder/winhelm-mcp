import {
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { ConfigManager } from "../config/config-manager.js";

export type SafePackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface CommandRunInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandRunResult {
  command: string;
  resolvedExecutable: string;
  resolvedArgs: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export interface ResolvedCommandPlan {
  requestedCommand: string;
  executable: string;
  argsPrefix: string[];
  adapter?: SafePackageManager;
}

export interface ResolutionOptions {
  nodeExecutable?: string;
  pathEnv?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
}

export type CommandRunPolicyCode =
  | "COMMAND_RUN_REJECTED"
  | "COMMAND_SECURITY_BLOCKED"
  | "SAFE_COMMAND_PLAN_DENIED"
  | "TERMINAL_MODE_REQUIRED"
  | string;

export class CommandRunPolicyError extends Error {
  constructor(
    public readonly code: CommandRunPolicyCode,
    message: string
  ) {
    super(message);
    this.name = "CommandRunPolicyError";
  }
}

export interface PreparedCommandRun {
  plan: ResolvedCommandPlan;
  finalArgs: string[];
  cwd: string;
  timeoutMs: number;
  displayCommand: string;
}

const SAFE_PACKAGE_MANAGERS = new Set<SafePackageManager>([
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);

const SHELL_OR_INTERPRETER_NAMES = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "bash.exe",
  "sh",
  "sh.exe",
  "wsl",
  "wsl.exe",
]);

const SAFE_META = /[;&|<>`$()]/;

const INSTALL_SUBCOMMANDS: Record<SafePackageManager, Set<string>> = {
  npm: new Set(["install", "i", "ci"]),
  pnpm: new Set(["install", "i"]),
  yarn: new Set(["install"]),
  bun: new Set(["install"]),
};

const VERSION_FORMS = new Set(["--version", "-v", "version"]);

const BLOCKED_SAFE_FLAGS = [
  /^-g$/i,
  /^--global(?:=|$)/i,
  /^--location(?:=|$)/i,
  /^--prefix(?:=|$)/i,
  /^--cwd(?:=|$)/i,
  /^--dir(?:=|$)/i,
  /^-C$/i,
  /^--workspace(?:=|$)/i,
  /^--workspaces(?:=|$)/i,
  /^--workspace-root(?:=|$)/i,
  /^--include-workspace-root(?:=|$)/i,
  /^--global-dir(?:=|$)/i,
  /^--global-bin-dir(?:=|$)/i,
  /^--modules-dir(?:=|$)/i,
  /^--virtual-store-dir(?:=|$)/i,
  /^--store-dir(?:=|$)/i,
  /^--config-dir(?:=|$)/i,
  /^--userconfig(?:=|$)/i,
  /^--globalconfig(?:=|$)/i,
  /^--npmrc(?:=|$)/i,
];

const OUTPUT_LIMIT = 1 * 1024 * 1024;

function canonicalExisting(input: string): string {
  const resolved = path.resolve(input);
  return realpathSync(resolved);
}

function normalizeCommandName(command: string): string {
  const trimmed = command.normalize("NFKC").trim();
  if (!trimmed) throw new Error("command must be a non-empty string");
  return trimmed.toLowerCase();
}

function bareCommandAlias(command: string): string {
  const lower = normalizeCommandName(command);
  if (/[\\/]/.test(lower) || /^[a-z]:/i.test(lower)) {
    throw new Error("Safe command_run does not accept executable paths.");
  }

  for (const ext of [".cmd", ".exe"]) {
    if (lower.endsWith(ext)) return lower.slice(0, -ext.length);
  }
  return lower;
}

function pathEntries(pathEnv: string | undefined, cwd: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  const cwdCanonical = existsSync(cwd) ? canonicalExisting(cwd) : path.resolve(cwd);
  const cwdCompare =
    process.platform === "win32" ? cwdCanonical.toLowerCase() : cwdCanonical;

  for (const raw of (pathEnv ?? "").split(path.delimiter)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || entry === ".") continue;

    let canonical: string;
    try {
      canonical = existsSync(entry) ? canonicalExisting(entry) : path.resolve(entry);
    } catch {
      continue;
    }

    const compare =
      process.platform === "win32" ? canonical.toLowerCase() : canonical;
    const relative = path.relative(cwdCompare, compare);
    if (
      compare === cwdCompare ||
      (relative !== "" &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative))
    ) {
      continue;
    }

    if (!seen.has(compare)) {
      seen.add(compare);
      entries.push(canonical);
    }
  }

  return entries;
}

function existingFile(candidate: string): string | undefined {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
    return canonicalExisting(candidate);
  } catch {
    return undefined;
  }
}

function trustedNodePlan(
  command: SafePackageManager,
  nodeExecutable: string,
  pathDirs: string[]
): ResolvedCommandPlan | undefined {
  const node = existingFile(nodeExecutable);
  if (!node) return undefined;

  const roots = [
    path.dirname(node),
    ...pathDirs,
  ];

  const candidates: string[] = [];
  for (const root of roots) {
    if (command === "npm") {
      candidates.push(path.join(root, "node_modules", "npm", "bin", "npm-cli.js"));
    } else if (command === "pnpm" || command === "yarn") {
      candidates.push(path.join(root, "node_modules", "corepack", "dist", `${command}.js`));
    }
  }

  for (const candidate of candidates) {
    const entry = existingFile(candidate);
    if (entry) {
      return {
        requestedCommand: command,
        executable: node,
        argsPrefix: [entry],
        adapter: command,
      };
    }
  }

  return undefined;
}

function trustedExePlan(
  command: SafePackageManager,
  pathDirs: string[],
  platform: NodeJS.Platform
): ResolvedCommandPlan | undefined {
  const exeNames =
    platform === "win32"
      ? [`${command}.exe`]
      : [command];

  for (const root of pathDirs) {
    for (const exeName of exeNames) {
      const executable = existingFile(path.join(root, exeName));
      if (executable) {
        return {
          requestedCommand: command,
          executable,
          argsPrefix: [],
          adapter: command,
        };
      }
    }

    if (platform === "win32" && command === "bun") {
      const bunFromNpm = existingFile(
        path.join(root, "node_modules", "bun", "bin", "bun.exe")
      );
      if (bunFromNpm) {
        return {
          requestedCommand: command,
          executable: bunFromNpm,
          argsPrefix: [],
          adapter: command,
        };
      }
    }
  }

  return undefined;
}

export function resolveSafePackageManager(
  commandInput: string,
  options: ResolutionOptions = {}
): ResolvedCommandPlan {
  const command = bareCommandAlias(commandInput) as SafePackageManager;
  if (!SAFE_PACKAGE_MANAGERS.has(command)) {
    throw new Error(
      "Safe command_run permits only npm, pnpm, yarn, or bun."
    );
  }

  if (SHELL_OR_INTERPRETER_NAMES.has(normalizeCommandName(commandInput))) {
    throw new Error("Shell/interpreter launch is not permitted in Safe mode.");
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const pathDirs = pathEntries(options.pathEnv ?? process.env.PATH, cwd);
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const platform = options.platform ?? process.platform;

  const nodePlan =
    command === "bun"
      ? undefined
      : trustedNodePlan(command, nodeExecutable, pathDirs);
  if (nodePlan) return nodePlan;

  const exePlan = trustedExePlan(command, pathDirs, platform);
  if (exePlan) return exePlan;

  throw new Error(
    `Trusted ${command} installation could not be resolved without using the project cwd or a shell.`
  );
}

function validateSafeArgs(
  command: SafePackageManager,
  argsInput: string[]
): { args: string[]; operation: "version" | "install" } {
  const args = argsInput.map((arg) => arg.normalize("NFKC"));

  for (const value of [command, ...args]) {
    if (SAFE_META.test(value)) {
      throw new Error(
        "Safe command_run rejects shell metacharacters even though it does not invoke a shell."
      );
    }
  }

  if (args.length === 1 && VERSION_FORMS.has(args[0])) {
    return { args, operation: "version" };
  }

  const first = args[0];
  if (!first || !INSTALL_SUBCOMMANDS[command].has(first)) {
    throw new Error(
      `Safe ${command} permits only version checks and install operations.`
    );
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (BLOCKED_SAFE_FLAGS.some((pattern) => pattern.test(arg))) {
      throw new Error(
        `Safe ${command} rejected path/global/workspace-affecting option: ${arg}`
      );
    }

    if (
      (arg === "--location" ||
        arg === "--prefix" ||
        arg === "--cwd" ||
        arg === "--dir" ||
        arg === "-C" ||
        arg === "--workspace" ||
        arg === "--config-dir" ||
        arg === "--userconfig" ||
        arg === "--globalconfig") &&
      i + 1 < args.length
    ) {
      throw new Error(
        `Safe ${command} rejected option that can redirect execution outside cwd: ${arg}`
      );
    }

    if (/^--ignore-scripts=/i.test(arg) && !/^--ignore-scripts=(true|1)$/i.test(arg)) {
      throw new Error("Safe command_run does not allow disabling --ignore-scripts.");
    }
  }

  const withoutIgnoreScripts = args.filter(
    (arg) => !/^--ignore-scripts(?:=(true|1))?$/i.test(arg)
  );

  return {
    args: [...withoutIgnoreScripts, "--ignore-scripts"],
    operation: "install",
  };
}

export function buildSafePackageManagerPlan(
  commandInput: string,
  argsInput: string[],
  cwd: string,
  options: ResolutionOptions = {}
): ResolvedCommandPlan & { args: string[]; operation: "version" | "install" } {
  const command = bareCommandAlias(commandInput) as SafePackageManager;
  const validated = validateSafeArgs(command, argsInput);
  const resolved = resolveSafePackageManager(commandInput, {
    ...options,
    cwd,
  });

  return {
    ...resolved,
    args: [...resolved.argsPrefix, ...validated.args],
    operation: validated.operation,
  };
}

function resolveDirectExecutable(
  commandInput: string,
  cwd: string,
  options: ResolutionOptions = {}
): ResolvedCommandPlan {
  const command = commandInput.normalize("NFKC").trim();
  if (!command) throw new Error("command must be a non-empty string");

  const lowerBase = path.basename(command).toLowerCase();
  if (SHELL_OR_INTERPRETER_NAMES.has(lowerBase)) {
    throw new Error(
      "command_run does not launch shells/interpreters. Use terminal_run when the current Terminal mode permits it."
    );
  }

  if (/[\\/]/.test(command) || /^[a-z]:/i.test(command)) {
    const executable = existingFile(
      path.isAbsolute(command) ? command : path.resolve(cwd, command)
    );
    if (!executable) throw new Error(`Executable not found: ${command}`);
    if (process.platform === "win32" && path.extname(executable).toLowerCase() !== ".exe") {
      throw new Error(
        "command_run requires a directly executable .exe on Windows; shell shims such as .cmd are not supported."
      );
    }
    return { requestedCommand: command, executable, argsPrefix: [] };
  }

  const safeAlias = lowerBase.replace(/\.(cmd|exe)$/i, "");
  if (SAFE_PACKAGE_MANAGERS.has(safeAlias as SafePackageManager)) {
    return resolveSafePackageManager(safeAlias, {
      ...options,
      cwd,
    });
  }

  const pathDirs = pathEntries(options.pathEnv ?? process.env.PATH, cwd);
  const platform = options.platform ?? process.platform;
  const candidates =
    platform === "win32"
      ? [`${command}.exe`, command.toLowerCase().endsWith(".exe") ? command : ""].filter(Boolean)
      : [command];

  for (const root of pathDirs) {
    for (const candidate of candidates) {
      const executable = existingFile(path.join(root, candidate));
      if (executable) {
        return { requestedCommand: command, executable, argsPrefix: [] };
      }
    }
  }

  throw new Error(
    `Direct executable "${command}" was not found in trusted PATH entries outside cwd.`
  );
}

function appendLimited(
  current: Buffer[],
  chunk: Buffer,
  total: { value: number }
): void {
  if (total.value >= OUTPUT_LIMIT) return;
  const remaining = OUTPUT_LIMIT - total.value;
  const part = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  current.push(part);
  total.value += part.length;
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform !== "win32") return;

  await new Promise<void>((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      () => resolve()
    );
  });
}

export function preflightCommandRun(
  input: CommandRunInput
): PreparedCommandRun {
  const manager = ConfigManager.getInstance();
  const config = manager.getConfig();
  const mode = config.terminal?.mode ?? "off";
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const args = input.args ?? [];
  const timeoutMs = input.timeoutMs ?? 60_000;
  const displayCommand = [input.command, ...args].join(" ");

  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
    throw new CommandRunPolicyError(
      "COMMAND_RUN_REJECTED",
      "timeoutMs must be an integer between 100 and 600000."
    );
  }

  let plan: ResolvedCommandPlan;
  let finalArgs: string[];

  if (mode === "safe") {
    const cwdCheck = manager.checkPathAccess(cwd, "write", {
      denyRootMutation: false,
    });
    if (!cwdCheck.allowed) {
      throw new CommandRunPolicyError(
        cwdCheck.code || "SAFE_COMMAND_PLAN_DENIED",
        cwdCheck.reason ||
          "Safe command_run cwd must be a readwrite WinHelm folder."
      );
    }

    try {
      const safePlan = buildSafePackageManagerPlan(
        input.command,
        args,
        cwd
      );
      plan = safePlan;
      finalArgs = safePlan.args;
    } catch (err) {
      if (err instanceof CommandRunPolicyError) throw err;
      throw new CommandRunPolicyError(
        "SAFE_COMMAND_PLAN_DENIED",
        (err as Error).message || String(err)
      );
    }
  } else if (mode === "ask" || mode === "full") {
    try {
      plan = resolveDirectExecutable(input.command, cwd);
    } catch (err) {
      throw new CommandRunPolicyError(
        "COMMAND_RUN_REJECTED",
        (err as Error).message || String(err)
      );
    }
    finalArgs = [...plan.argsPrefix, ...args];

    const allowed = manager.isCommandAllowed(displayCommand);
    if (!allowed.allowed) {
      throw new CommandRunPolicyError(
        "COMMAND_SECURITY_BLOCKED",
        allowed.reason || "Command blocked by WinHelm security policy."
      );
    }
  } else if (mode === "dangerous") {
    throw new CommandRunPolicyError(
      "TERMINAL_MODE_REQUIRED",
      "Dangerous terminal mode is reserved for WinHelm v1.4 and is blocked by the v1.3 runtime."
    );
  } else {
    throw new CommandRunPolicyError(
      "TERMINAL_MODE_REQUIRED",
      "Terminal mode does not permit command_run."
    );
  }

  return {
    plan,
    finalArgs,
    cwd,
    timeoutMs,
    displayCommand,
  };
}

export async function runCommandNoShell(
  input: CommandRunInput
): Promise<CommandRunResult> {
  // Re-run the exact same deterministic planning/security checks at execution
  // time. Pre-approval callers use preflightCommandRun(), while this second
  // evaluation protects against config/path/executable changes before spawn.
  const prepared = preflightCommandRun(input);
  const { plan, finalArgs, cwd, timeoutMs } = prepared;

  const startedAt = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutTotal = { value: 0 };
  const stderrTotal = { value: 0 };
  let timedOut = false;
  let aborted = false;

  const child = spawn(plan.executable, finalArgs, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout?.on("data", (chunk: Buffer) =>
    appendLimited(stdoutChunks, chunk, stdoutTotal)
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    appendLimited(stderrChunks, chunk, stderrTotal)
  );

  let timeout: NodeJS.Timeout | undefined;
  const stop = async (reason: "timeout" | "abort") => {
    if (child.exitCode !== null) return;
    if (reason === "timeout") timedOut = true;
    else aborted = true;

    try {
      child.kill();
    } catch {
      // Best effort before Windows process-tree termination.
    }
    if (child.pid) await terminateProcessTree(child.pid);
  };

  timeout = setTimeout(() => {
    void stop("timeout");
  }, timeoutMs);
  timeout.unref?.();

  const abortHandler = () => {
    void stop("abort");
  };
  input.signal?.addEventListener("abort", abortHandler, { once: true });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? (timedOut || aborted ? 1 : -1)));
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortHandler);
  });

  return {
    command: input.command,
    resolvedExecutable: plan.executable,
    resolvedArgs: finalArgs,
    cwd,
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    durationMs: Date.now() - startedAt,
    timedOut,
    aborted,
  };
}
