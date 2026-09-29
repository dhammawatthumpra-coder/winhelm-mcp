import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ExecutionResult } from "../types/index.js";
import { ConfigManager } from "../config/config-manager.js";
import { logger } from "../utils/logger.js";
import { getCleanChildEnv } from "../utils/child-env.js";

let cachedPwshAvailable: boolean | null = null;

/**
 * Check whether PowerShell 7+ (pwsh.exe) is installed on the host system.
 * Cached in memory after the initial check to eliminate recurring spawn overhead.
 */
export function isPwshAvailable(): boolean {
  if (cachedPwshAvailable !== null) {
    return cachedPwshAvailable;
  }
  try {
    const res = spawnSync("pwsh.exe", ["-NoProfile", "-Version"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 2000,
    });
    cachedPwshAvailable = res.status === 0;
  } catch {
    cachedPwshAvailable = false;
  }
  return cachedPwshAvailable;
}

/**
 * Reset or set pwsh availability cache (useful for testing and mocking)
 */
export function setPwshAvailableCache(val: boolean | null): void {
  cachedPwshAvailable = val;
}

/**
 * Select preferred PowerShell executable: pwsh.exe if available and preferred, else powershell.exe
 */
export function getPowerShellExecutable(preferPwsh = true): string {
  if (preferPwsh && isPwshAvailable()) {
    return "pwsh.exe";
  }
  return "powershell.exe";
}

export interface PowerShellOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Execute a PowerShell command with UTF-8 encoding, security guard, and timeout protection
 */
export function runPowerShell(
  command: string,
  options: PowerShellOptions = {}
): Promise<ExecutionResult> {
  const configManager = ConfigManager.getInstance();
  const config = configManager.getConfig();

  // 1. Security Check
  const check = configManager.isCommandAllowed(command);
  if (!check.allowed) {
    const reason = check.reason || "Command blocked by security policy";
    logger.security(reason, command);
    return Promise.reject(new Error(reason));
  }

  // 2. Validate CWD against allowedDirectories
  let cwd: string;
  if (options.cwd) {
    const cwdCheck = configManager.isPathAllowed(options.cwd);
    if (!cwdCheck.allowed && config.allowSystemExecution === false) {
      const reason = cwdCheck.reason || `Working directory "${options.cwd}" is not permitted`;
      logger.security(reason, command);
      return Promise.reject(new Error(reason));
    }
    cwd = options.cwd;
  } else {
    const currentCwd = process.cwd();
    const currentCheck = configManager.isPathAllowed(currentCwd);
    if (!currentCheck.allowed && config.allowSystemExecution === false) {
      const reason = currentCheck.reason || `Effective working directory "${currentCwd}" is not permitted`;
      logger.security(reason, command);
      return Promise.reject(new Error(reason));
    }
    if (currentCheck.allowed) {
      cwd = currentCwd;
    } else {
      const allowed = config.allowedDirectories;
      if (allowed && allowed.length > 0) {
        let first = allowed[0].trim();
        if (/^[a-zA-Z]:?[\\/]?$/.test(first)) {
          first = first[0].toUpperCase() + ":\\";
        }
        const resolvedAllowed = path.resolve(first);
        cwd = existsSync(resolvedAllowed) ? resolvedAllowed : currentCwd;
      } else {
        cwd = currentCwd;
      }
    }
  }

  const timeoutMs = options.timeoutMs || config.defaultTimeoutMs || 60000;
  const startTime = Date.now();
  const executionId = randomUUID();

  return new Promise((resolve, reject) => {
    // UTF-8 setup preamble for Windows PowerShell to prevent garbled Unicode / Thai characters
    const utf8Setup =
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " +
      "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); " +
      "$OutputEncoding = [System.Text.UTF8Encoding]::new(); ";
    const fullCommand = utf8Setup + command;
    const preferPwsh = config.preferPwsh !== false;
    const executable = getPowerShellExecutable(preferPwsh);

    const child = spawn(
      executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", fullCommand],
      {
        cwd,
        windowsHide: true,
        env: getCleanChildEnv(options.env),
      }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Process might already be dead
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? (timedOut ? -1 : 0);
      const durationMs = Date.now() - startTime;

      // Log execution for auditing
      configManager.logExecution({
        id: executionId,
        timestamp: new Date().toISOString(),
        command,
        cwd,
        exitCode,
        durationMs,
        timedOut,
      });

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
