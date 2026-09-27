import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ConfigManager } from "../config/config-manager.js";
import { logger } from "../utils/logger.js";
import { getPowerShellExecutable } from "./powershell-runner.js";

export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  startTime: string;
  endTime?: string;
  status: "running" | "completed" | "failed" | "killed";
  exitCode?: number | null;
  outputBuffer: string[];
  process?: ChildProcess;
}

export interface TaskSummary {
  id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  startTime: string;
  endTime?: string;
  status: BackgroundTask["status"];
  exitCode?: number | null;
  outputLinesCount: number;
}

export class TaskManager {
  private static instance: TaskManager | null = null;
  private tasks = new Map<string, BackgroundTask>();
  private readonly maxBufferLines = 1000;
  private readonly maxRetainedTasks = 50;

  private constructor() {}

  public static getInstance(): TaskManager {
    if (!TaskManager.instance) {
      TaskManager.instance = new TaskManager();
    }
    return TaskManager.instance;
  }

  /**
   * Start a command as a long-running background task
   */
  public startTask(command: string, cwd = process.cwd()): TaskSummary {
    const configManager = ConfigManager.getInstance();

    // 1. Security Check
    const check = configManager.isCommandAllowed(command);
    if (!check.allowed) {
      const reason = check.reason || "Command blocked by security policy";
      logger.security(reason, command);
      throw new Error(reason);
    }

    // 2. Validate CWD against allowedDirectories
    const cwdCheck = configManager.isPathAllowed(cwd);
    const config = configManager.getConfig();
    if (!cwdCheck.allowed && config.allowSystemExecution === false) {
      const reason = cwdCheck.reason || `Working directory "${cwd}" is not permitted`;
      logger.security(reason, command);
      throw new Error(reason);
    }

    const taskId = randomUUID().slice(0, 8);
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
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      }
    );

    const task: BackgroundTask = {
      id: taskId,
      command,
      cwd,
      pid: child.pid,
      startTime: new Date().toISOString(),
      status: "running",
      outputBuffer: [],
      process: child,
    };

    const appendOutput = (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split(/\r?\n/);
      for (const line of lines) {
        if (!line && lines.length === 1) continue;
        task.outputBuffer.push(line);
        if (task.outputBuffer.length > this.maxBufferLines) {
          task.outputBuffer.shift();
        }
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    child.on("close", (code) => {
      task.endTime = new Date().toISOString();
      task.exitCode = code;
      if (task.status === "running") {
        task.status = code === 0 ? "completed" : "failed";
      }
      logger.info(`Background task [${taskId}] exited`, `Exit code: ${code}`);
    });

    child.on("error", (err) => {
      task.endTime = new Date().toISOString();
      task.status = "failed";
      task.outputBuffer.push(`[Process Error]: ${err.message}`);
      logger.error(`Background task [${taskId}] error`, err.message);
    });

    this.tasks.set(taskId, task);

    // Prune oldest completed tasks if exceeding retention limit
    if (this.tasks.size > this.maxRetainedTasks) {
      for (const [id, t] of this.tasks.entries()) {
        if (t.status !== "running") {
          this.tasks.delete(id);
          break;
        }
      }
    }

    logger.info(`Background task started [${taskId}]`, `PID: ${child.pid} | Command: ${command}`);

    return {
      id: task.id,
      command: task.command,
      cwd: task.cwd,
      pid: task.pid,
      startTime: task.startTime,
      status: task.status,
      outputLinesCount: 0,
    };
  }

  /**
   * List all background tasks
   */
  public listTasks(): TaskSummary[] {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      command: t.command,
      cwd: t.cwd,
      pid: t.pid,
      startTime: t.startTime,
      endTime: t.endTime,
      status: t.status,
      exitCode: t.exitCode,
      outputLinesCount: t.outputBuffer.length,
    }));
  }

  /**
   * Get buffered logs for a task
   */
  public getTaskLogs(taskId: string, tailLines = 100): { logs: string; task: TaskSummary } {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Background task "${taskId}" not found`);
    }

    const sliced = task.outputBuffer.slice(-tailLines);
    return {
      logs: sliced.join("\n"),
      task: {
        id: task.id,
        command: task.command,
        cwd: task.cwd,
        pid: task.pid,
        startTime: task.startTime,
        endTime: task.endTime,
        status: task.status,
        exitCode: task.exitCode,
        outputLinesCount: task.outputBuffer.length,
      },
    };
  }

  /**
   * Send text to standard input of a running background task
   */
  public sendInput(taskId: string, input: string): { success: boolean } {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Background task "${taskId}" not found`);
    }
    if (task.status !== "running" || !task.process || !task.process.stdin) {
      throw new Error(`Task "${taskId}" is not currently running (status: ${task.status})`);
    }

    task.process.stdin.write(input + "\n");
    return { success: true };
  }

  private terminateProcess(task: BackgroundTask): void {
    if (!task.process || task.status !== "running") return;
    task.status = "killed";
    if (task.pid && process.platform === "win32") {
      try {
        execSync(`taskkill /pid ${task.pid} /T /F`, { stdio: "ignore" });
        return;
      } catch {
        // Fallback to standard process kill
      }
    }
    try {
      task.process.kill("SIGKILL");
    } catch {
      // process might already be dead
    }
  }

  /**
   * Terminate a background task
   */
  public killTask(taskId: string): { success: boolean } {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Background task "${taskId}" not found`);
    }

    this.terminateProcess(task);
    return { success: true };
  }

  /**
   * Terminate all background tasks on server shutdown
   */
  public killAll(): void {
    for (const task of this.tasks.values()) {
      this.terminateProcess(task);
    }
  }
}

export const taskManager = TaskManager.getInstance();
