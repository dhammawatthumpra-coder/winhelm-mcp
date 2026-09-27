import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { LogEntry } from "./logger.js";
import { sanitizeText } from "./sanitizer.js";

export class FileLogger {
  private static instance: FileLogger | null = null;
  private logDir: string;
  private maxRetentionDays = 7;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor() {
    this.logDir = path.resolve(process.cwd(), "logs");
  }

  public static getInstance(): FileLogger {
    if (!FileLogger.instance) {
      FileLogger.instance = new FileLogger();
    }
    return FileLogger.instance;
  }

  private getTodayLogFileName(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `winhelm-${yyyy}-${mm}-${dd}.log`;
  }

  /**
   * Append log entry to persistent log file asynchronously
   */
  public log(entry: LogEntry): void {
    // Chain writes to guarantee sequential, non-corrupting file writes
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!existsSync(this.logDir)) {
          await fs.mkdir(this.logDir, { recursive: true });
        }

        const fileName = this.getTodayLogFileName();
        const filePath = path.join(this.logDir, fileName);

        const sanitizedTitle = sanitizeText(entry.title);
        const sanitizedDetail = entry.detail ? sanitizeText(entry.detail) : "";
        const sanitizedEntry = {
          ...entry,
          title: sanitizedTitle,
          detail: sanitizedDetail,
        };

        const line = JSON.stringify(sanitizedEntry) + "\n";
        await fs.appendFile(filePath, line, "utf-8");

        // Check if rotation or cleanup needed occasionally
        if (Math.random() < 0.05) {
          await this.cleanOldLogs();
        }
      })
      .catch((err) => {
        // Never throw from file logger to prevent crashing the server
        console.error("[FileLogger] Error writing log file:", err.message);
      });
  }

  /**
   * Remove log files older than maxRetentionDays
   */
  public async cleanOldLogs(): Promise<void> {
    try {
      if (!existsSync(this.logDir)) return;
      const files = await fs.readdir(this.logDir);
      const now = Date.now();
      const maxAgeMs = this.maxRetentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.endsWith(".log")) {
          const fullPath = path.join(this.logDir, file);
          const stat = await fs.stat(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.unlink(fullPath);
          }
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  /**
   * Export audit logs in JSON or CSV format
   */
  public async exportLogs(format: "json" | "csv" = "json"): Promise<string> {
    const todayFile = path.join(this.logDir, this.getTodayLogFileName());
    let rawContent = "";
    if (existsSync(todayFile)) {
      rawContent = await fs.readFile(todayFile, "utf-8");
    }

    const lines = rawContent.split(/\r?\n/).filter(Boolean);
    const entries: LogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // ignore parse error on bad line
      }
    }

    if (format === "csv") {
      const headers = ["Timestamp", "Type", "Level", "Title", "Status", "DurationMs", "Detail"];
      const rows = entries.map((e) => [
        `"${e.timestamp}"`,
        `"${e.type}"`,
        `"${e.level}"`,
        `"${(e.title || "").replace(/"/g, '""')}"`,
        `"${e.status ?? ""}"`,
        e.durationMs ?? 0,
        `"${(e.detail || "").replace(/"/g, '""')}"`,
      ]);
      return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    }

    return JSON.stringify(entries, null, 2);
  }
}

export const fileLogger = FileLogger.getInstance();
