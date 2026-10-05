/**
 * Spec 3.4 A1 — file_inspect_batch engine.
 *
 * Batch physical inspection of up to 100 paths with two read-consistency
 * levels. `best_effort` records bytes/mtime before and after a streaming
 * SHA-256 read and flags observed change. `deny_writers` holds the accepted
 * native stable-read handle (FILE_SHARE_READ, no write sharing) for the whole
 * read/hash so a concurrent writer cannot interleave; it never approximates
 * the lock with timestamp polling.
 */
import { createReadStream, lstatSync, statSync, constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ConfigManager } from "../config/config-manager.js";
import { getNativeBoundary, NativeBoundaryUnavailableError } from "../native/boundary.js";
import { StructuredToolError } from "../errors/tool-error.js";

export type InspectConsistency = "best_effort" | "deny_writers";

export type InspectField =
  | "exists"
  | "type"
  | "bytes"
  | "sha256"
  | "mtime_utc"
  | "creation_time_utc"
  | "reparse_point"
  | "reparse_tag"
  | "readonly"
  | "hidden";

export const FILE_INSPECT_BATCH_MAX_PATHS = 100;

export interface FileInspectBatchInput {
  paths: string[];
  sha256?: boolean;
  consistency?: InspectConsistency;
  include?: InspectField[];
  fail_fast?: boolean;
}

export interface FileInspectItem {
  path: string;
  exists: boolean;
  type?: "file" | "directory" | "reparse_point" | "none";
  bytes?: number | null;
  sha256?: string | null;
  mtime_utc?: string | null;
  creation_time_utc?: string | null;
  reparse_point?: boolean | null;
  reparse_tag?: string | null;
  readonly?: boolean | null;
  hidden?: boolean | null;
  consistency_applied: InspectConsistency | "none";
  changed_during_inspection: boolean;
}

export interface FileInspectBatchResult {
  total_inspected: number;
  elapsed_ms: number;
  items: FileInspectItem[];
}

const FILE_ATTRIBUTE_READONLY = 0x00000001;
const FILE_ATTRIBUTE_HIDDEN = 0x00000002;

const REPARSE_TAG_NAMES: Record<number, string> = {
  0xa0000003: "IO_REPARSE_TAG_MOUNT_POINT",
  0xa000000c: "IO_REPARSE_TAG_SYMLINK",
  0xc0000004: "IO_REPARSE_TAG_NAME_SURROGATE",
  0x80000000: "IO_REPARSE_TAG_SIS",
  0x80000008: "IO_REPARSE_TAG_DEDUP",
  0x80000015: "IO_REPARSE_TAG_APPEXECLINK",
  0xa0000019: "IO_REPARSE_TAG_APPEXECLINK",
  0xc000001a: "IO_REPARSE_TAG_UNHANDLED",
  0xa0000027: "IO_REPARSE_TAG_WCI_1",
};

function reparseTagName(tag: number): string {
  return REPARSE_TAG_NAMES[tag] ?? `0x${tag.toString(16).toUpperCase().padStart(8, "0")}`;
}

function iso(value: Date | undefined): string | null {
  return value ? value.toISOString() : null;
}

function fail(code: string, message: string, userAction?: string, details?: Record<string, unknown>): never {
  throw new StructuredToolError(code, message, userAction, details);
}

interface NativeAttributeView {
  reparsePoint: boolean;
  reparseTag: number;
  readonly: boolean;
  hidden: boolean;
}

/**
 * Read authoritative Windows attributes through one transient native open.
 * Used only where the open cannot violate a consistency contract: reparse
 * points under best_effort (the open targets the link object itself, never
 * the link target) and all handles under deny_writers. Returns undefined
 * when the open cannot be taken; callers degrade to null instead of
 * fabricating attribute values. Regular files under best_effort deliberately
 * never take this open: a FILE_SHARE_READ-only handle would briefly deny
 * concurrent writers and break the non-blocking best_effort contract.
 */
function nativeAttributeView(filePath: string): NativeAttributeView | undefined {
  try {
    const metadata = getNativeBoundary().stableReadOpen(filePath).metadata();
    return {
      reparsePoint: metadata.reparsePoint,
      reparseTag: metadata.reparseTag,
      readonly: (metadata.fileAttributes & FILE_ATTRIBUTE_READONLY) !== 0,
      hidden: (metadata.fileAttributes & FILE_ATTRIBUTE_HIDDEN) !== 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Non-blocking readonly determination for best_effort regular files: libuv
 * clears S_IWRITE in st_mode for files carrying the FILE_ATTRIBUTE_READONLY
 * bit, so the mode bits answer the readonly question without opening the
 * file at all.
 */
function readonlyFromModeBits(mode: number): boolean {
  return (mode & fsConstants.W_OK) === 0;
}

function hashStream(filePath: string): Promise<string> {
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

interface StatView {
  bytes: number;
  mtimeMs: number;
  creationMs: number;
}

function statView(filePath: string): StatView {
  const stats = statSync(filePath);
  return {
    bytes: stats.size,
    mtimeMs: stats.mtimeMs,
    creationMs: stats.ctimeMs,
  };
}

function sameStat(a: StatView, b: StatView): boolean {
  return a.bytes === b.bytes && a.mtimeMs === b.mtimeMs && a.creationMs === b.creationMs;
}

function inspectMissingItem(
  requestedPath: string,
  fields: Set<InspectField>
): FileInspectItem {
  const item: FileInspectItem = {
    path: requestedPath,
    exists: false,
    consistency_applied: "none",
    changed_during_inspection: false,
  };
  if (fields.has("type")) item.type = "none";
  if (fields.has("bytes")) item.bytes = null;
  if (fields.has("sha256")) item.sha256 = null;
  if (fields.has("mtime_utc")) item.mtime_utc = null;
  if (fields.has("creation_time_utc")) item.creation_time_utc = null;
  if (fields.has("reparse_point")) item.reparse_point = false;
  if (fields.has("reparse_tag")) item.reparse_tag = null;
  if (fields.has("readonly")) item.readonly = null;
  if (fields.has("hidden")) item.hidden = null;
  return item;
}

async function streamFileSha256(
  filePath: string,
  consistency: InspectConsistency,
  wantSha256: boolean
): Promise<{ sha256: string | null; changed: boolean }> {
  if (!wantSha256 && consistency === "best_effort") {
    // No read is performed, so there is no read window to detect change in.
    return { sha256: null, changed: false };
  }

  if (consistency === "deny_writers") {
    // Normative path: hold the native stable-read handle (FILE_SHARE_READ)
    // for the whole read/hash; map native structured errors verbatim. The
    // retained handle makes concurrent writes impossible, so no stat delta
    // can occur inside the locked read window.
    let handle;
    try {
      handle = getNativeBoundary().stableReadOpen(filePath);
    } catch (err) {
      throw toStructuredNativeError(err);
    }
    try {
      const snapshot = handle.snapshot();
      return { sha256: snapshot.sha256, changed: false };
    } finally {
      handle.close();
    }
  }

  const before = statView(filePath);
  const sha256 = await hashStream(filePath);
  const after = statView(filePath);
  return {
    sha256,
    changed: !sameStat(before, after),
  };
}

function toStructuredNativeError(err: unknown): StructuredToolError {
  if (err instanceof StructuredToolError) return err;
  const native = err as { code?: unknown; nativeCode?: unknown; message?: unknown };
  const code = typeof native?.code === "string" && native.code ? native.code : "FILE_READ_FAILED";
  const message =
    typeof native?.message === "string" && native.message ? native.message : String(err);
  return new StructuredToolError(
    code,
    message,
    "Retry with consistency=best_effort, or stop the process holding the target file.",
    typeof native?.nativeCode === "number" ? { nativeCode: native.nativeCode } : undefined
  );
}

function requireNativeBoundary() {
  try {
    return getNativeBoundary();
  } catch (err) {
    if (err instanceof NativeBoundaryUnavailableError) {
      throw new StructuredToolError(
        err.code,
        err.message,
        "Build the repository-owned native addon with scripts/build-native-boundary.ps1 -BuildRoot native/build on the qualified Windows target.",
        err.details
      );
    }
    throw err;
  }
}

export async function inspectFileBatch(
  input: FileInspectBatchInput
): Promise<FileInspectBatchResult> {
  const paths = input.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    fail("PATH_INVALID", "paths must be a non-empty array of filesystem paths.");
  }
  if (paths.length > FILE_INSPECT_BATCH_MAX_PATHS) {
    fail(
      "INPUT_TOO_LARGE",
      `file_inspect_batch accepts at most ${FILE_INSPECT_BATCH_MAX_PATHS} paths per call; received ${paths.length}.`,
      "Split the inspection into smaller batches."
    );
  }

  const manager = ConfigManager.getInstance();
  const consistency: InspectConsistency = input.consistency ?? "best_effort";
  const wantSha256 = input.sha256 ?? true;
  const failFast = input.fail_fast ?? false;
  const fields = new Set<InspectField>(
    input.include ?? [
      "exists",
      "type",
      "bytes",
      "sha256",
      "mtime_utc",
      "creation_time_utc",
      "reparse_point",
      "reparse_tag",
      "readonly",
      "hidden",
    ]
  );

  if (consistency === "deny_writers") {
    // deny_writers is a normative native contract; fail closed when the
    // trusted addon is absent instead of approximating the lock in Node.
    requireNativeBoundary();
  }

  const started = Date.now();
  const items: FileInspectItem[] = [];

  for (const rawPath of paths) {
    const requestedPath = String(rawPath);
    const resolved = path.resolve(requestedPath.normalize("NFKC").trim());

    // Defense-in-depth authorization re-check; the M1 static/preapproval gate
    // already denied unapproved paths before the handler ran.
    const pathCheck = manager.checkPathAccess(resolved, "read");
    if (!pathCheck.allowed) {
      fail(
        pathCheck.code ?? "FOLDER_ACCESS_DENIED",
        pathCheck.reason ?? `Path is not authorized for read: ${requestedPath}`,
        "Use a path inside an allowed WinHelm folder."
      );
    }

    let lstat: ReturnType<typeof lstatSync>;
    try {
      lstat = lstatSync(resolved, { throwIfNoEntry: false });
    } catch {
      lstat = undefined;
    }

    if (!lstat) {
      if (failFast) {
        fail(
          "PATH_NOT_FOUND",
          `Path not found: ${requestedPath}`,
          "Verify the path exists with file_list before batching the inspection."
        );
      }
      items.push(inspectMissingItem(resolved, fields));
      continue;
    }

    const isReparse = lstat.isSymbolicLink();
    const isDirectory = !isReparse && lstat.isDirectory();

    if (isDirectory) {
      const stats = statSync(resolved);
      const item: FileInspectItem = {
        path: resolved,
        exists: true,
        consistency_applied: "none",
        changed_during_inspection: false,
      };
      if (fields.has("type")) item.type = "directory";
      if (fields.has("bytes")) item.bytes = null;
      if (fields.has("sha256")) item.sha256 = null;
      if (fields.has("mtime_utc")) item.mtime_utc = iso(stats.mtime);
      if (fields.has("creation_time_utc")) item.creation_time_utc = iso(stats.ctime);
      if (fields.has("reparse_point")) item.reparse_point = false;
      if (fields.has("reparse_tag")) item.reparse_tag = null;
      if (fields.has("readonly")) item.readonly = null;
      if (fields.has("hidden")) item.hidden = null;
      items.push(item);
      continue;
    }

    if (isReparse) {
      // Reparse points are reported, never traversed: no hash is taken
      // through the link, so no allowed-folder escape can occur.
      let item: FileInspectItem;
      if (consistency === "deny_writers") {
        let handle;
        try {
          handle = requireNativeBoundary().stableReadOpen(resolved);
        } catch (err) {
          throw toStructuredNativeError(err);
        }
        try {
          const metadata = handle.metadata();
          item = {
            path: resolved,
            exists: true,
            consistency_applied: "deny_writers",
            changed_during_inspection: false,
          };
          if (fields.has("type")) item.type = "reparse_point";
          if (fields.has("bytes")) item.bytes = lstat.size;
          if (fields.has("sha256")) item.sha256 = null;
          if (fields.has("mtime_utc")) item.mtime_utc = iso(lstat.mtime);
          if (fields.has("creation_time_utc")) item.creation_time_utc = iso(lstat.ctime);
          if (fields.has("reparse_point")) item.reparse_point = true;
          if (fields.has("reparse_tag")) item.reparse_tag = reparseTagName(metadata.reparseTag);
          if (fields.has("readonly"))
            item.readonly = (metadata.fileAttributes & FILE_ATTRIBUTE_READONLY) !== 0;
          if (fields.has("hidden"))
            item.hidden = (metadata.fileAttributes & FILE_ATTRIBUTE_HIDDEN) !== 0;
        } finally {
          handle.close();
        }
      } else {
        const attrs = nativeAttributeView(resolved);
        item = {
          path: resolved,
          exists: true,
          consistency_applied: "none",
          changed_during_inspection: false,
        };
        if (fields.has("type")) item.type = "reparse_point";
        if (fields.has("bytes")) item.bytes = lstat.size;
        if (fields.has("sha256")) item.sha256 = null;
        if (fields.has("mtime_utc")) item.mtime_utc = iso(lstat.mtime);
        if (fields.has("creation_time_utc")) item.creation_time_utc = iso(lstat.ctime);
        if (fields.has("reparse_point")) item.reparse_point = true;
        if (fields.has("reparse_tag"))
          item.reparse_tag = attrs ? reparseTagName(attrs.reparseTag) : null;
        if (fields.has("readonly"))
          item.readonly = attrs
            ? attrs.readonly
            : readonlyFromModeBits(lstat.mode);
        if (fields.has("hidden")) item.hidden = attrs ? attrs.hidden : null;
      }
      items.push(item);
      continue;
    }

    // Regular file: all metadata comes from the single lstat above (libuv
    // clears S_IWRITE for FILE_ATTRIBUTE_READONLY). deny_writers holds the
    // native stable-read handle for the whole read/hash and reports exact
    // attribute bits from that handle; best_effort never takes a handle that
    // could deny a concurrent writer.
    if (consistency === "deny_writers") {
      let handle;
      try {
        handle = requireNativeBoundary().stableReadOpen(resolved);
      } catch (err) {
        throw toStructuredNativeError(err);
      }
      try {
        const metadata = handle.metadata();
        const snapshot = handle.snapshot();
        const item: FileInspectItem = {
          path: resolved,
          exists: true,
          consistency_applied: "deny_writers",
          changed_during_inspection: false,
        };
        if (fields.has("type")) item.type = "file";
        if (fields.has("bytes")) item.bytes = snapshot.bytes;
        if (fields.has("sha256")) item.sha256 = snapshot.sha256;
        if (fields.has("mtime_utc")) item.mtime_utc = iso(lstat.mtime);
        if (fields.has("creation_time_utc")) item.creation_time_utc = iso(lstat.ctime);
        if (fields.has("reparse_point")) item.reparse_point = false;
        if (fields.has("reparse_tag")) item.reparse_tag = null;
        if (fields.has("readonly"))
          item.readonly = (metadata.fileAttributes & FILE_ATTRIBUTE_READONLY) !== 0;
        if (fields.has("hidden"))
          item.hidden = (metadata.fileAttributes & FILE_ATTRIBUTE_HIDDEN) !== 0;
        items.push(item);
      } finally {
        handle.close();
      }
      continue;
    }

    let sha256: string | null;
    let changed: boolean;
    try {
      const streamResult = await streamFileSha256(resolved, consistency, wantSha256);
      sha256 = streamResult.sha256;
      changed = streamResult.changed;
    } catch (err) {
      if (err instanceof StructuredToolError) throw err;
      throw new StructuredToolError(
        "FILE_READ_FAILED",
        (err as Error).message || String(err)
      );
    }

    const item: FileInspectItem = {
      path: resolved,
      exists: true,
      consistency_applied: consistency,
      changed_during_inspection: changed,
    };
    if (fields.has("type")) item.type = "file";
    if (fields.has("bytes")) item.bytes = lstat.size;
    if (fields.has("sha256")) item.sha256 = sha256;
    if (fields.has("mtime_utc")) item.mtime_utc = iso(lstat.mtime);
    if (fields.has("creation_time_utc")) item.creation_time_utc = iso(lstat.ctime);
    if (fields.has("reparse_point")) item.reparse_point = false;
    if (fields.has("reparse_tag")) item.reparse_tag = null;
    if (fields.has("readonly")) item.readonly = readonlyFromModeBits(lstat.mode);
    // Windows hidden attribute is not exposed non-blockingly by Node and
    // best_effort must not take a denying handle just for attributes.
    if (fields.has("hidden")) item.hidden = null;
    items.push(item);
  }

  return {
    total_inspected: items.length,
    elapsed_ms: Date.now() - started,
    items,
  };
}
