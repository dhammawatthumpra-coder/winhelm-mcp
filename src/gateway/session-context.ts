import { sanitizeText } from "../utils/sanitizer.js";

export interface McpClientInfo {
  name: string;
  version?: string;
}

export interface McpServerRuntimeContext {
  sessionId?: string;
  durablePrincipalId?: string;
  clientInfo?: McpClientInfo;
}

const serverContexts = new WeakMap<object, McpServerRuntimeContext>();
const clientsBySession = new Map<string, McpClientInfo>();
const MAX_CLIENT_SESSIONS = 256;

function cleanField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = sanitizeText(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength
    ? cleaned.slice(0, maxLength)
    : cleaned;
}

export function normalizeClientInfo(
  raw: unknown
): McpClientInfo | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const name = cleanField(value.name, 120);
  if (!name) return undefined;
  const version = cleanField(value.version, 80);

  return {
    name,
    ...(version ? { version } : {}),
  };
}

export function extractClientInfo(body: unknown): McpClientInfo | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const message = body as Record<string, unknown>;
  if (message.method !== "initialize") return undefined;

  const params =
    message.params && typeof message.params === "object"
      ? (message.params as Record<string, unknown>)
      : undefined;

  return normalizeClientInfo(params?.clientInfo);
}

export function setServerRuntimeContext(
  server: object,
  context: McpServerRuntimeContext
): void {
  serverContexts.set(server, context);
}

export function getServerRuntimeContext(
  server: object
): McpServerRuntimeContext | undefined {
  return serverContexts.get(server);
}

export function setSessionClientInfo(
  sessionId: string,
  clientInfo: McpClientInfo | undefined
): void {
  if (!clientInfo) return;

  if (!clientsBySession.has(sessionId) && clientsBySession.size >= MAX_CLIENT_SESSIONS) {
    const oldest = clientsBySession.keys().next().value as string | undefined;
    if (oldest) clientsBySession.delete(oldest);
  }

  clientsBySession.set(sessionId, { ...clientInfo });
}

export function getSessionClientInfo(
  sessionId: string
): McpClientInfo | undefined {
  const value = clientsBySession.get(sessionId);
  return value ? { ...value } : undefined;
}

export interface SessionClientSummary {
  sessionId: string;
  clientInfo: McpClientInfo;
}

/**
 * Snapshot of the sessions that announced clientInfo, in announce order. Used
 * by the Dashboard connection list; callers hash the session id before it
 * leaves the admin plane. clientInfo is client-supplied and must be rendered as
 * text only.
 */
export function listSessionClients(): SessionClientSummary[] {
  return [...clientsBySession.entries()].map(([sessionId, clientInfo]) => ({
    sessionId,
    clientInfo: { ...clientInfo },
  }));
}

export function clearSessionRuntimeContext(sessionId: string): void {
  clientsBySession.delete(sessionId);
}

export function resetSessionRuntimeContexts(): void {
  clientsBySession.clear();
}
