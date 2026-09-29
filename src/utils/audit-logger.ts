import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { sanitizeObject, sanitizeText } from "./sanitizer.js";

export interface AuditEvent {
  timestamp?: string;
  event: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  actor: {
    ip?: string;
    authType?: "bearer" | "session_cookie" | "query_token" | "none";
    sessionId?: string;
  };
  action: string;
  resource?: string;
  outcome: "ALLOWED" | "DENIED" | "ERROR";
  details?: Record<string, unknown> | string;
}

/**
 * Dedicated append-only JSONL audit logger for security events.
 * Writes to logs/audit.log with automatic size-based rotation.
 */
export class AuditLogger {
  private static instance: AuditLogger | null = null;
  private readonly logDir: string;
  private readonly auditFilePath: string;
  private readonly maxFileSizeBytes = 10 * 1024 * 1024; // 10MB
  private readonly maxBackups = 5;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor() {
    this.logDir = path.resolve(process.cwd(), "logs");
    this.auditFilePath = path.join(this.logDir, "audit.log");
  }

  public static getInstance(): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger();
    }
    return AuditLogger.instance;
  }

  /**
   * Log a security audit event to the append-only JSONL audit log
   */
  public log(event: AuditEvent): void {
    const timestamp = event.timestamp || new Date().toISOString();
    const sanitizedEvent: AuditEvent = {
      timestamp,
      event: event.event,
      severity: event.severity,
      actor: {
        ip: event.actor.ip,
        authType: event.actor.authType || "none",
        sessionId: event.actor.sessionId,
      },
      action: sanitizeText(event.action),
      resource: event.resource ? sanitizeText(event.resource) : undefined,
      outcome: event.outcome,
      details: event.details ? sanitizeObject(event.details) : undefined,
    };

    const line = JSON.stringify(sanitizedEvent) + "\n";

    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!existsSync(this.logDir)) {
          await fs.mkdir(this.logDir, { recursive: true });
        }

        await this.rotateIfNeeded();
        await fs.appendFile(this.auditFilePath, line, "utf-8");
      })
      .catch((err) => {
        // Failsafe: never crash application on audit logging failure
        console.error("[AuditLogger] Error writing audit log:", err.message);
      });
  }

  /**
   * Rotate logs if audit.log exceeds maxFileSizeBytes
   */
  private async rotateIfNeeded(): Promise<void> {
    try {
      if (!existsSync(this.auditFilePath)) return;

      const stat = statSync(this.auditFilePath);
      if (stat.size < this.maxFileSizeBytes) return;

      // Rotate: audit.4.log -> audit.5.log, ..., audit.log -> audit.1.log
      for (let i = this.maxBackups - 1; i >= 1; i--) {
        const currentFile = path.join(this.logDir, `audit.${i}.log`);
        const nextFile = path.join(this.logDir, `audit.${i + 1}.log`);
        if (existsSync(currentFile)) {
          if (existsSync(nextFile)) {
            await fs.unlink(nextFile).catch(() => {});
          }
          await fs.rename(currentFile, nextFile).catch(() => {});
        }
      }

      const backupOne = path.join(this.logDir, "audit.1.log");
      if (existsSync(backupOne)) {
        await fs.unlink(backupOne).catch(() => {});
      }
      await fs.rename(this.auditFilePath, backupOne).catch(() => {});
    } catch {
      // ignore rotation errors
    }
  }

  /**
   * For testing or manual inspection
   */
  public getAuditFilePath(): string {
    return this.auditFilePath;
  }
}

export const auditLogger = AuditLogger.getInstance();
