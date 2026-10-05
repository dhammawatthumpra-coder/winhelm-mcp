/**
 * Spec 3.4 A2/A3 — durable file-mutation provenance store.
 *
 * Mutations performed by the governed mutation primitives append one JSONL
 * record AFTER the actual governed outcome. The store lives inside the
 * protected WinHelm data directory tree, is never exposed as a readable file
 * through any MCP tool, and is only ever read through the path-scoped
 * projection used by `file_provenance_lookup`: one exact normalized target
 * path per query, no enumeration of other paths, no raw store access.
 */
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProvenanceAction = "create" | "modify" | "delete";

export interface FileProvenanceRecord {
  /** Owning WinHelm session key (approvalSessionKey). */
  session_id: string;
  timestamp_utc: string;
  tool: string;
  action: ProvenanceAction;
  /** Canonical absolute path exactly as recorded at mutation time. */
  path: string;
  before_sha256: string | null;
  after_sha256: string | null;
  operator: string;
}

export function defaultFileProvenanceStorePath(): string {
  return path.join(os.homedir(), ".winhelm", "file-provenance.jsonl");
}

let storePathOverride: string | undefined;

/**
 * Test-only seam so fixtures can redirect the store away from the real
 * protected data directory. Production callers never set this.
 */
export function setFileProvenanceStoreForTesting(storePath: string | undefined): void {
  storePathOverride = storePath;
}

export function fileProvenanceStorePath(): string {
  return storePathOverride ?? defaultFileProvenanceStorePath();
}

/** Windows path identity is case-insensitive; fold for exact-path matching. */
export function normalizeProvenancePathKey(targetPath: string): string {
  const resolved = path.resolve(String(targetPath).normalize("NFKC").trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface StoreCache {
  loaded: boolean;
  records: FileProvenanceRecord[];
  writeChain: Promise<void>;
}

const cache: StoreCache = { loaded: false, records: [], writeChain: Promise.resolve() };

export function resetFileProvenanceStore(): void {
  cache.loaded = false;
  cache.records = [];
  cache.writeChain = Promise.resolve();
}

function parseRecordLine(line: string): FileProvenanceRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<FileProvenanceRecord> | null;
    if (
      value &&
      typeof value === "object" &&
      typeof value.session_id === "string" &&
      typeof value.timestamp_utc === "string" &&
      typeof value.tool === "string" &&
      typeof value.action === "string" &&
      typeof value.path === "string" &&
      typeof value.operator === "string"
    ) {
      return {
        session_id: value.session_id,
        timestamp_utc: value.timestamp_utc,
        tool: value.tool,
        action: value.action as ProvenanceAction,
        path: value.path,
        before_sha256:
          typeof value.before_sha256 === "string" ? value.before_sha256 : null,
        after_sha256:
          typeof value.after_sha256 === "string" ? value.after_sha256 : null,
        operator: value.operator,
      };
    }
  } catch {
    // A corrupted line never fabricates a record.
  }
  return undefined;
}

async function loadStore(): Promise<void> {
  if (cache.loaded) return;
  const storePath = fileProvenanceStorePath();
  const records: FileProvenanceRecord[] = [];
  if (existsSync(storePath)) {
    try {
      const raw = await fs.readFile(storePath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const record = parseRecordLine(line);
        if (record) records.push(record);
      }
    } catch {
      // An unreadable store contributes no records; lookups then report the
      // honest no-provenance status instead of guessing.
    }
  }
  cache.records = records;
  cache.loaded = true;
}

/**
 * Append one provenance record after a governed outcome. The write is
 * serialized in-process so concurrent mutations cannot interleave lines.
 */
export async function appendFileProvenanceRecord(
  record: Omit<FileProvenanceRecord, "timestamp_utc"> & { timestamp_utc?: string }
): Promise<FileProvenanceRecord> {
  const full: FileProvenanceRecord = {
    ...record,
    timestamp_utc: record.timestamp_utc ?? new Date().toISOString(),
  };
  const line = JSON.stringify(full) + "\n";

  const task = cache.writeChain.then(async () => {
    await loadStore();
    const storePath = fileProvenanceStorePath();
    mkdirSync(path.dirname(storePath), { recursive: true });
    await fs.appendFile(storePath, line, "utf8");
    cache.records.push(full);
  });
  // Keep the serialization chain alive for later writers while still
  // propagating this append's failure to its own caller.
  cache.writeChain = task.catch(() => {});
  await task;
  return { ...full };
}

/**
 * Path-scoped projection: the ONLY read path into the store. Returns the
 * records for exactly one normalized target path, oldest first. Never
 * returns records for other paths and never exposes the store location.
 */
export async function lookupFileProvenance(
  targetPath: string,
  actions?: ProvenanceAction[],
  limit?: number
): Promise<FileProvenanceRecord[]> {
  await loadStore();
  const key = normalizeProvenancePathKey(targetPath);
  const wantedActions = actions && actions.length > 0 ? new Set(actions) : null;
  const safeLimit = Math.max(0, limit ?? Number.POSITIVE_INFINITY);
  if (safeLimit === 0) return [];
  const matched = cache.records.filter(
    (record) =>
      normalizeProvenancePathKey(record.path) === key &&
      (!wantedActions || wantedActions.has(record.action))
  );
  return matched
    .slice(-safeLimit)
    .map((record) => ({ ...record }));
}
