import { randomUUID } from "node:crypto";
import { sanitizeText } from "./sanitizer.js";
import { fileLogger } from "./file-logger.js";

export interface LogEntry {
  id: string;
  timestamp: string;
  type: "tool" | "req" | "security" | "system" | "error";
  level: "info" | "warn" | "error" | "success";
  title: string;
  detail?: string;
  durationMs?: number;
  status?: string | number;
}

// ANSI Escape Codes for Terminal Colors
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
};

export class Logger {
  private static instance: Logger | null = null;
  private logs: LogEntry[] = [];
  private readonly maxLogs = 200;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private getFormattedTime(): string {
    const d = new Date();
    const pad = (n: number, s = 2) => String(n).padStart(s, "0");
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    const ms = pad(d.getMilliseconds(), 3);
    return `${h}:${m}:${s}.${ms}`;
  }

  private addLog(entry: Omit<LogEntry, "id" | "timestamp">): void {
    const cleanTitle = sanitizeText(entry.title);
    const cleanDetail = entry.detail ? sanitizeText(entry.detail) : undefined;

    const fullEntry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
      title: cleanTitle,
      detail: cleanDetail,
    };

    this.logs.unshift(fullEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }

    // Persist to rotating disk log
    fileLogger.log(fullEntry);
  }

  public getRecentLogs(limit = 100): LogEntry[] {
    return this.logs.slice(0, limit);
  }

  public clearLogs(): void {
    this.logs = [];
  }

  /**
   * Log incoming & completed HTTP requests
   */
  public req(
    method: string,
    url: string,
    statusCode: number,
    durationMs: number,
    ip = "-",
    sessionId?: string
  ): void {
    const time = this.getFormattedTime();
    let statusColor = C.green;
    let level: LogEntry["level"] = "info";

    if (statusCode >= 500) {
      statusColor = C.red;
      level = "error";
    } else if (statusCode >= 400) {
      statusColor = C.yellow;
      level = "warn";
    }

    const sessTag = sessionId ? `${C.gray}[sess:${sessionId.slice(0, 8)}]${C.reset} ` : "";
    const cleanUrl = sanitizeText(url);
    const line = `${C.gray}[${time}]${C.reset} ${C.cyan}[HTTP]${C.reset} ${C.bold}${method}${C.reset} ${cleanUrl} ${statusColor}${statusCode}${C.reset} ${C.dim}(${durationMs}ms)${C.reset} ${sessTag}${C.gray}${ip}${C.reset}`;
    console.log(line);

    this.addLog({
      type: "req",
      level,
      title: `${method} ${url}`,
      detail: `IP: ${ip}${sessionId ? ` | Session: ${sessionId}` : ""}`,
      durationMs,
      status: statusCode,
    });
  }

  /**
   * Log tool invocation start
   */
  public toolStart(name: string, args: Record<string, any>): void {
    const time = this.getFormattedTime();
    // Sanitize parameters so long content/base64 doesn't spam console
    const cleanArgs: Record<string, any> = {};
    for (const [key, val] of Object.entries(args || {})) {
      if (typeof val === "string" && val.length > 80) {
        cleanArgs[key] = val.slice(0, 77) + "...";
      } else {
        cleanArgs[key] = val;
      }
    }

    const preview = sanitizeText(JSON.stringify(cleanArgs));
    console.log(
      `${C.gray}[${time}]${C.reset} ${C.magenta}[TOOL-START]${C.reset} ${C.bold}${name}${C.reset} ${C.dim}${preview}${C.reset}`
    );

    this.addLog({
      type: "tool",
      level: "info",
      title: `tool_call: ${name}`,
      detail: preview,
      status: "RUNNING",
    });
  }

  /**
   * Log tool invocation success
   */
  public toolDone(name: string, durationMs: number, summary?: string): void {
    const time = this.getFormattedTime();
    const cleanSummary = summary ? sanitizeText(summary) : undefined;
    const sum = cleanSummary ? ` ${C.dim}-> ${cleanSummary.slice(0, 90)}${cleanSummary.length > 90 ? "..." : ""}${C.reset}` : "";
    console.log(
      `${C.gray}[${time}]${C.reset} ${C.green}[TOOL-DONE]${C.reset}  ${C.bold}${name}${C.reset} ${C.green}✔ OK${C.reset} ${C.dim}(${durationMs}ms)${C.reset}${sum}`
    );

    this.addLog({
      type: "tool",
      level: "success",
      title: `tool_done: ${name}`,
      detail: cleanSummary ? cleanSummary.slice(0, 150) : "Success",
      durationMs,
      status: "SUCCESS",
    });
  }

  /**
   * Log tool invocation failure
   */
  public toolFail(name: string, durationMs: number, error: string): void {
    const time = this.getFormattedTime();
    console.log(
      `${C.gray}[${time}]${C.reset} ${C.red}[TOOL-FAIL]${C.reset}  ${C.bold}${name}${C.reset} ${C.red}✖ ERROR${C.reset} ${C.dim}(${durationMs}ms)${C.reset} ${C.red}${error}${C.reset}`
    );

    this.addLog({
      type: "tool",
      level: "error",
      title: `tool_fail: ${name}`,
      detail: error,
      durationMs,
      status: "FAILED",
    });
  }

  /**
   * Log security events (e.g. command blocked, path denied, unauthorized)
   */
  public security(message: string, detail?: string): void {
    const time = this.getFormattedTime();
    console.warn(
      `${C.gray}[${time}]${C.reset} ${C.yellow}${C.bold}[SECURITY]${C.reset} ${C.yellow}⚠️  ${message}${C.reset}${detail ? ` ${C.dim}(${detail})${C.reset}` : ""}`
    );

    this.addLog({
      type: "security",
      level: "warn",
      title: message,
      detail,
      status: "BLOCKED",
    });
  }

  /**
   * General info message
   */
  public info(message: string, detail?: string): void {
    const time = this.getFormattedTime();
    console.log(
      `${C.gray}[${time}]${C.reset} ${C.blue}[INFO]${C.reset} ${message}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`
    );

    this.addLog({
      type: "system",
      level: "info",
      title: message,
      detail,
    });
  }

  /**
   * Error message
   */
  public error(message: string, detail?: string): void {
    const time = this.getFormattedTime();
    console.error(
      `${C.gray}[${time}]${C.reset} ${C.red}[ERROR]${C.reset} ${C.bold}${message}${C.reset}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`
    );

    this.addLog({
      type: "error",
      level: "error",
      title: message,
      detail,
    });
  }
}

export const logger = Logger.getInstance();
