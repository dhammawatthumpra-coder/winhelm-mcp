import type { ProfileStatus } from "./profile-service.js";
import { auditLogger } from "../utils/audit-logger.js";

export type PermissionChangeChannel = "dashboard" | "cli";

export interface PermissionChangeAudit {
  event: "PROFILE_PRESET_APPLIED" | "LEGACY_MIGRATION_APPLIED";
  /** Local channel that performed the change. */
  channel: PermissionChangeChannel;
  action: string;
  from: ProfileStatus;
  to: ProfileStatus;
  changedFields?: readonly string[];
  backupCreated?: boolean;
  resource?: string;
  ip?: string;
  sessionId?: string;
}

/**
 * Baseline 8.3: a permission change is audited with from -> to and the channel
 * that performed it. The Dashboard admin plane and the local CLI both use this
 * shape so the audit trail reads the same regardless of channel.
 */
export function logPermissionChange(audit: PermissionChangeAudit): void {
  auditLogger.log({
    event: audit.event,
    severity: audit.to.terminalMode === "full" ? "WARN" : "INFO",
    actor: {
      ...(audit.ip ? { ip: audit.ip } : {}),
      authType: audit.sessionId ? "session_cookie" : "none",
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
    action: audit.action,
    resource: audit.resource ?? audit.to.preset ?? undefined,
    outcome: "ALLOWED",
    details: {
      channel: audit.channel,
      from: {
        schemaMode: audit.from.schemaMode,
        preset: audit.from.preset,
        terminalMode: audit.from.terminalMode,
        modified: audit.from.modified,
      },
      to: {
        schemaMode: audit.to.schemaMode,
        preset: audit.to.preset,
        terminalMode: audit.to.terminalMode,
        modified: audit.to.modified,
      },
      ...(audit.changedFields
        ? { changedFields: [...audit.changedFields] }
        : {}),
      ...(audit.backupCreated !== undefined
        ? { backupCreated: audit.backupCreated }
        : {}),
    },
  });
}
