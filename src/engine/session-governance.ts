/**
 * Spec 3.4 A3 — governance and provenance projections.
 *
 * `session_current` reports the safe identity of the calling session.
 * `session_audit_search` projects ONLY the current session's audit trail
 * (cross-session isolation is preserved by construction: nothing from any
 * other session can be returned). `file_provenance_lookup` provides the
 * path-scoped cross-session attribution projection backed by the durable
 * file-provenance journal; the protected store is never exposed or
 * enumerated, and the caller must hold read authorization on the target
 * path — for deleted targets authorization uses the normalized containing
 * allowed root without opening the missing file.
 */
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { ConfigManager } from "../config/config-manager.js";
import type { FolderPermission } from "../config/schema-v2.js";
import { canonicalizeExistingAwarePath } from "../permissions/folder-access.js";
import { getSessionClientInfo } from "../gateway/session-context.js";
import { approvalSessionKey, getProvenanceTracker } from "../approval/provenance.js";
import { getApprovalEngine } from "../approval/runtime.js";
import {
  lookupFileProvenance,
  normalizeProvenancePathKey,
  type FileProvenanceRecord,
} from "../approval/file-provenance.js";
import { StructuredToolError } from "../errors/tool-error.js";

/** Approximate server process start time (module load = server startup). */
const SERVER_STARTED_AT_UTC = new Date().toISOString();

export type SessionAuditAction =
  | "create"
  | "modify"
  | "delete"
  | "approve"
  | "deny"
  | "execute"
  | "read";

export interface SessionCurrentResult {
  session_id: string;
  client_info: {
    name: string | null;
    version: string | null;
    transport: "stdio" | "http";
  };
  process_id: number;
  started_at_utc: string;
  profile_preset: string | null;
  terminal_mode: string;
}

export function describeCurrentSession(
  rawSessionId: string | undefined
): SessionCurrentResult {
  const sessionId = approvalSessionKey(rawSessionId);
  const client = getSessionClientInfo(sessionId);
  const isStdio = sessionId.startsWith("local-process-");
  const config = ConfigManager.getInstance().getConfig() as Record<string, unknown>;
  const terminal = (config.terminal ?? {}) as { mode?: string };

  return {
    session_id: sessionId,
    client_info: {
      name: client?.name ?? null,
      version: client?.version ?? null,
      transport: isStdio ? "stdio" : "http",
    },
    process_id: process.pid,
    started_at_utc: SERVER_STARTED_AT_UTC,
    profile_preset: (config.profilePreset as string | undefined) ?? null,
    terminal_mode: terminal.mode ?? "off",
  };
}

export interface SessionAuditSearchInput {
  path?: string;
  actions?: Array<"create" | "modify" | "delete" | "approve" | "deny" | "execute">;
  since_utc?: string;
  until_utc?: string;
  limit?: number;
}

export interface SessionAuditEvent {
  timestamp_utc: string;
  session_id: string;
  action: SessionAuditAction;
  tool: string;
  target: string | null;
  status: "completed" | "error";
}

const TOOL_ACTION_MAP: Record<string, SessionAuditAction> = {
  file_create_exclusive: "create",
  file_write: "modify",
  file_write_atomic: "modify",
  file_edit: "modify",
  file_delete_safe: "delete",
  file_move: "modify",
  command_run: "execute",
  command_wait: "execute",
  terminal_run: "execute",
  terminal_task_start: "execute",
  terminal_task_send: "execute",
  terminal_task_kill: "execute",
  process_kill: "execute",
  service_control: "execute",
  system_open: "execute",
  file_read: "read",
  file_list: "read",
  file_search: "read",
  file_search_ripgrep: "read",
  file_tail: "read",
  file_hash: "read",
  file_preview: "read",
  file_inspect_batch: "read",
  file_compare: "read",
  directory_manifest: "read",
  file_provenance_lookup: "read",
  session_audit_search: "read",
};

const AUDIT_SEARCH_MAX_LIMIT = 500;

function actionForTool(tool: string): SessionAuditAction {
  return TOOL_ACTION_MAP[tool] ?? "read";
}

function isoMsToIso(value: number): string {
  return new Date(value).toISOString();
}

function parseIsoBoundary(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Current-session-only audit projection. Sources: the in-memory provenance
 * tracker (tool invocations of THIS session) and the approval engine jobs
 * owned by THIS session. Other sessions' data is filtered out before any
 * result can be built; the protected audit journal file is never read here.
 */
export function searchCurrentSessionAudit(
  input: SessionAuditSearchInput,
  rawSessionId: string | undefined
): { session_id: string; total_events: number; events: SessionAuditEvent[] } {
  const sessionId = approvalSessionKey(rawSessionId);
  const sinceMs = parseIsoBoundary(input.since_utc);
  const untilMs = parseIsoBoundary(input.until_utc);
  if (input.since_utc && sinceMs === null) {
    throw new StructuredToolError(
      "TIME_RANGE_INVALID",
      `since_utc is not a valid ISO 8601 timestamp: ${input.since_utc}`
    );
  }
  if (input.until_utc && untilMs === null) {
    throw new StructuredToolError(
      "TIME_RANGE_INVALID",
      `until_utc is not a valid ISO 8601 timestamp: ${input.until_utc}`
    );
  }
  const safeLimit = Math.max(0, Math.min(input.limit ?? 50, AUDIT_SEARCH_MAX_LIMIT));
  if (safeLimit === 0) {
    return { session_id: sessionId, total_events: 0, events: [] };
  }

  const wantedActions =
    input.actions && input.actions.length > 0 ? new Set(input.actions) : null;
  const pathNeedle = input.path
    ? normalizeProvenancePathKey(input.path).replace(/\\/g, "/")
    : null;

  const events: SessionAuditEvent[] = [];

  const tracker = getProvenanceTracker();
  for (const entry of tracker.getRecent(sessionId, 20 * AUDIT_SEARCH_MAX_LIMIT)) {
    const action = actionForTool(entry.tool);
    const target = entry.target && entry.target !== entry.tool ? entry.target : null;
    if (pathNeedle) {
      const candidate = (target ?? "").replace(/\\/g, "/").toLowerCase();
      if (!candidate.includes(pathNeedle)) continue;
    }
    if (sinceMs !== null && entry.timestamp < sinceMs) continue;
    if (untilMs !== null && entry.timestamp > untilMs) continue;
    if (wantedActions && !wantedActions.has(action as never)) continue;
    events.push({
      timestamp_utc: isoMsToIso(entry.timestamp),
      session_id: sessionId,
      action,
      tool: entry.tool,
      target,
      status: entry.status,
    });
  }

  // Approval decisions owned by this session only. Jobs from other sessions
  // are discarded before any event is constructed.
  let jobs: ReturnType<ReturnType<typeof getApprovalEngine>["list"]> = [];
  try {
    jobs = getApprovalEngine().list();
  } catch {
    jobs = [];
  }
  for (const job of jobs) {
    if (job.sessionId !== sessionId) continue;
    const decision: SessionAuditAction | null =
      job.state === "approved" || job.state === "running" || job.state === "completed"
        ? "approve"
        : job.state === "denied" || job.state === "expired" || job.state === "cancelled"
          ? "deny"
          : null;
    if (!decision) continue;
    const createdAt = job.updatedAt || job.createdAt;
    if (sinceMs !== null && createdAt < sinceMs) continue;
    if (untilMs !== null && createdAt > untilMs) continue;
    if (wantedActions && !wantedActions.has(decision)) continue;
    events.push({
      timestamp_utc: isoMsToIso(createdAt),
      session_id: sessionId,
      action: decision,
      tool: job.tool,
      target: null,
      status: "completed",
    });
  }

  events.sort((a, b) => b.timestamp_utc.localeCompare(a.timestamp_utc));

  return {
    session_id: sessionId,
    total_events: events.length,
    events: events.slice(0, safeLimit),
  };
}

export type FileProvenanceStatus =
  | "WINHELM_VERIFIED"
  | "UNATTRIBUTED_EXTERNAL_CHANGE"
  | "NO_WINHELM_PROVENANCE"
  | "FILE_DELETED";

export interface FileProvenanceLookupInput {
  path: string;
  actions?: Array<"create" | "modify" | "delete">;
  limit?: number;
}

export interface FileProvenanceAttribution {
  session_id: string;
  timestamp_utc: string;
  action: string;
  before_sha256: string | null;
  after_sha256: string | null;
}

export interface FileProvenanceLookupResult {
  path: string;
  provenance_status: FileProvenanceStatus;
  total_attributions: number;
  last_mutation: {
    session_id: string;
    timestamp_utc: string;
    action: string;
    operator: string;
    before_sha256: string | null;
    after_sha256: string | null;
  } | null;
  history: FileProvenanceAttribution[];
}

const PROVENANCE_LOOKUP_MAX_LIMIT = 200;

function hashFileStream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hasher = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hasher.update(chunk));
    stream.on("end", () => resolve(hasher.digest("hex")));
    stream.on("error", (err) => {
      stream.close();
      reject(err);
    });
  });
}

/**
 * Deleted-target authorization rule (frozen contract): when the target file
 * no longer exists, authorization compares the NORMALIZED target path with
 * the containing allowed roots instead of opening the missing file. The
 * containing root must grant read permission.
 */
function authorizeProvenanceTarget(
  resolvedPath: string,
  manager: ConfigManager
): { allowed: boolean; code?: string; reason?: string } {
  const direct = manager.checkPathAccess(resolvedPath, "read");
  if (direct.allowed) return { allowed: true };
  if (existsSync(resolvedPath)) {
    return { allowed: false, code: direct.code, reason: direct.reason };
  }

  // Deleted (or never-existing) target: containment against configured roots.
  const config = manager.getConfig() as { folders?: FolderPermission[] };
  const folders = config.folders ?? [];
  const targetKey = normalizeProvenancePathKey(resolvedPath);
  let bestRoot: { permission: FolderPermission["permission"] } | null = null;
  let bestRootKeyLength = -1;
  for (const folder of folders) {
    if (typeof folder.path !== "string" || !folder.path.trim()) continue;
    let canonicalRoot: string;
    try {
      canonicalRoot = canonicalizeExistingAwarePath(folder.path);
    } catch {
      continue;
    }
    const rootKey = normalizeProvenancePathKey(canonicalRoot);
    const rootWithSep = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep;
    if (
      (targetKey + path.sep).startsWith(rootWithSep) ||
      targetKey === rootKey
    ) {
      // Most-specific (longest) containing root wins.
      if (rootWithSep.length > bestRootKeyLength) {
        bestRootKeyLength = rootWithSep.length;
        bestRoot = { permission: folder.permission };
      }
    }
  }

  if (bestRoot && (bestRoot.permission === "read" || bestRoot.permission === "readwrite")) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: direct.code ?? "FOLDER_NOT_APPROVED",
    reason:
      direct.reason ??
      "Path is outside configured schema-v2 folders; provenance projection is read-authorized only.",
  };
}

function toAttribution(record: FileProvenanceRecord): FileProvenanceAttribution {
  return {
    session_id: record.session_id,
    timestamp_utc: record.timestamp_utc,
    action: record.action,
    before_sha256: record.before_sha256,
    after_sha256: record.after_sha256,
  };
}

export async function lookupFileProvenanceStatus(
  input: FileProvenanceLookupInput,
  rawSessionId: string | undefined
): Promise<FileProvenanceLookupResult> {
  if (typeof input.path !== "string" || !input.path.trim()) {
    throw new StructuredToolError("PATH_INVALID", "path must be a non-empty filesystem path.");
  }
  const resolved = path.resolve(input.path.normalize("NFKC").trim());

  const manager = ConfigManager.getInstance();
  const authorization = authorizeProvenanceTarget(resolved, manager);
  if (!authorization.allowed) {
    throw new StructuredToolError(
      authorization.code ?? "FOLDER_NOT_APPROVED",
      authorization.reason ?? "Provenance lookup is not authorized for this path.",
      "Request provenance for paths inside folders you are authorized to read."
    );
  }

  const allRecords = await lookupFileProvenance(resolved);
  const wantedActions =
    input.actions && input.actions.length > 0 ? input.actions : undefined;
  const safeLimit = Math.max(0, Math.min(input.limit ?? 10, PROVENANCE_LOOKUP_MAX_LIMIT));
  const filteredRecords = wantedActions
    ? allRecords.filter((record) => wantedActions.includes(record.action as never))
    : allRecords;
  const historyRecords = filteredRecords.slice(-safeLimit);

  const diskExists = existsSync(resolved);
  let provenanceStatus: FileProvenanceStatus;
  if (allRecords.length === 0) {
    provenanceStatus = "NO_WINHELM_PROVENANCE";
  } else if (!diskExists) {
    provenanceStatus = "FILE_DELETED";
  } else {
    const last = allRecords[allRecords.length - 1];
    let diskSha256: string | null = null;
    try {
      diskSha256 = await hashFileStream(resolved);
    } catch {
      diskSha256 = null;
    }
    provenanceStatus =
      last.after_sha256 !== null && diskSha256 === last.after_sha256
        ? "WINHELM_VERIFIED"
        : "UNATTRIBUTED_EXTERNAL_CHANGE";
  }

  const lastRecord =
    filteredRecords.length > 0 ? filteredRecords[filteredRecords.length - 1] : null;

  return {
    path: resolved,
    provenance_status: provenanceStatus,
    total_attributions: historyRecords.length,
    last_mutation: lastRecord
      ? {
          session_id: lastRecord.session_id,
          timestamp_utc: lastRecord.timestamp_utc,
          action: lastRecord.action,
          operator: lastRecord.operator,
          before_sha256: lastRecord.before_sha256,
          after_sha256: lastRecord.after_sha256,
        }
      : null,
    history: historyRecords.map(toAttribution),
  };
}
