import { sanitizeText } from "../utils/sanitizer.js";

export type ProvenanceStatus = "completed" | "error";

export interface ProvenanceEntry {
  timestamp: number;
  tool: string;
  target: string;
  status: ProvenanceStatus;
  metadata: {
    sourceClass: string;
    bytes?: number;
    contentType?: string;
  };
  preview?: string;
}

interface SessionHistory {
  updatedAt: number;
  entries: ProvenanceEntry[];
}

const MAX_PREVIEW_CHARS = 200;
const MAX_ENTRIES_PER_SESSION = 20;
const MAX_SESSIONS = 128;

function sourceClassForTool(tool: string): string {
  if (
    tool.startsWith("file_") ||
    tool.startsWith("archive_") ||
    tool === "pdf_generate"
  ) {
    return "filesystem";
  }
  if (tool.startsWith("http_") || tool === "network_info") {
    return "network";
  }
  if (tool.startsWith("terminal_") || tool === "command_run") {
    return "terminal";
  }
  if (
    tool.startsWith("clipboard_") ||
    tool === "screen_capture" ||
    tool === "system_open" ||
    tool === "notification_send"
  ) {
    return "desktop";
  }
  if (tool.startsWith("winhelm_")) {
    return "recovery";
  }
  return "system";
}

function targetParts(args: Record<string, unknown>): string[] {
  const orderedKeys = [
    "path",
    "source",
    "destination",
    "source_dir",
    "zip_path",
    "target_dir",
    "url",
    "cwd",
    "command",
    "task_id",
    "pid",
    "service",
    "name",
  ];

  const parts: string[] = [];
  for (const key of orderedKeys) {
    const value = args[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      const clean = sanitizeText(String(value)).trim();
      if (clean) parts.push(`${key}=${clean}`);
    }
    if (parts.length >= 3) break;
  }

  return parts;
}

export function summarizeProvenanceTarget(
  tool: string,
  args: Record<string, unknown>
): string {
  const parts = targetParts(args);
  return parts.length > 0 ? parts.join(" · ") : tool;
}

function firstContentItem(result: any): any | undefined {
  if (!result || !Array.isArray(result.content)) return undefined;
  return result.content[0];
}

function resultPreview(result: any): {
  preview?: string;
  bytes?: number;
  contentType?: string;
} {
  const first = firstContentItem(result);
  if (!first) return {};

  if (first.type === "text" && typeof first.text === "string") {
    const raw = first.text;
    const clean = sanitizeText(raw)
      .replace(/\r\n/g, "\n")
      .trim();

    return {
      preview:
        clean.length > MAX_PREVIEW_CHARS
          ? clean.slice(0, MAX_PREVIEW_CHARS) + "…"
          : clean,
      bytes: Buffer.byteLength(raw, "utf8"),
      contentType: "text",
    };
  }

  if (first.type === "image") {
    return {
      contentType:
        typeof first.mimeType === "string"
          ? first.mimeType
          : "image",
    };
  }

  return {
    contentType:
      typeof first.type === "string" ? first.type : "unknown",
  };
}

export class ProvenanceTracker {
  private readonly sessions = new Map<string, SessionHistory>();

  recordResult(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    result: any,
    status: ProvenanceStatus = result?.isError ? "error" : "completed",
    now = Date.now()
  ): ProvenanceEntry {
    this.ensureCapacity(sessionId);

    const preview = resultPreview(result);
    const entry: ProvenanceEntry = {
      timestamp: now,
      tool,
      target: summarizeProvenanceTarget(tool, args),
      status,
      metadata: {
        sourceClass: sourceClassForTool(tool),
        ...(preview.bytes !== undefined
          ? { bytes: preview.bytes }
          : {}),
        ...(preview.contentType
          ? { contentType: preview.contentType }
          : {}),
      },
      ...(preview.preview ? { preview: preview.preview } : {}),
    };

    const history = this.sessions.get(sessionId) ?? {
      updatedAt: now,
      entries: [],
    };
    history.updatedAt = now;
    history.entries.push(entry);
    if (history.entries.length > MAX_ENTRIES_PER_SESSION) {
      history.entries.splice(
        0,
        history.entries.length - MAX_ENTRIES_PER_SESSION
      );
    }
    this.sessions.set(sessionId, history);
    return structuredClone(entry);
  }

  recordThrownError(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    error: unknown,
    now = Date.now()
  ): ProvenanceEntry {
    const message =
      error instanceof Error ? error.message : String(error);
    return this.recordResult(
      sessionId,
      tool,
      args,
      {
        isError: true,
        content: [{ type: "text", text: message }],
      },
      "error",
      now
    );
  }

  getRecent(
    sessionId: string,
    limit = 3
  ): ProvenanceEntry[] {
    const history = this.sessions.get(sessionId);
    if (!history) return [];

    const safeLimit = Math.max(0, Math.min(limit, MAX_ENTRIES_PER_SESSION));
    return history.entries
      .slice(-safeLimit)
      .reverse()
      .map((entry) => structuredClone(entry));
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearAll(): void {
    this.sessions.clear();
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private ensureCapacity(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    if (this.sessions.size < MAX_SESSIONS) return;

    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, history] of this.sessions) {
      if (history.updatedAt < oldestTime) {
        oldestTime = history.updatedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) this.sessions.delete(oldestKey);
  }
}

let tracker: ProvenanceTracker | null = null;

export function getProvenanceTracker(): ProvenanceTracker {
  if (!tracker) tracker = new ProvenanceTracker();
  return tracker;
}

export function resetProvenanceTracker(): void {
  tracker = new ProvenanceTracker();
}

export function approvalSessionKey(sessionId?: string): string {
  return sessionId ?? `local-process-${process.pid}`;
}
