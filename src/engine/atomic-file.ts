/**
 * Spec 3.4 A2 — governed atomic/exclusive file mutation.
 *
 * `file_write_atomic` writes a same-directory temporary file, flushes it
 * (FlushFileBuffers), and commits with the accepted native exact atomic
 * replacement (MoveFileExW with MOVEFILE_REPLACE_EXISTING |
 * MOVEFILE_WRITE_THROUGH) so the target is always old-complete or
 * new-complete. `file_create_exclusive` enforces Win32 CREATE_NEW: an
 * existing target can never be overwritten.
 *
 * Reparse traversal is denied for every mutation path. Optimistic
 * preconditions re-check immediately before the native commit under the
 * per-path WinHelm serialization mutex. Provenance is recorded only after
 * the actual governed outcome.
 */
import { createReadStream, existsSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ConfigManager } from "../config/config-manager.js";
import { getNativeBoundary } from "../native/boundary.js";
import { StructuredToolError } from "../errors/tool-error.js";
import { appendFileProvenanceRecord } from "../approval/file-provenance.js";

export type AtomicEncoding = "utf8" | "base64" | "ascii";
export type AtomicNewline = "lf" | "crlf" | "preserve";

export interface FileWriteAtomicInput {
  path: string;
  content: string;
  encoding?: AtomicEncoding;
  newline?: AtomicNewline;
  final_newline?: boolean;
  bom?: boolean;
  expected_absent?: boolean;
  expected_current_sha256?: string | null;
  flush?: boolean;
  create_parents?: boolean;
}

export interface FileCreateExclusiveInput {
  path: string;
  content: string;
  encoding?: AtomicEncoding;
  newline?: AtomicNewline;
  final_newline?: boolean;
  bom?: boolean;
  create_parents?: boolean;
}

export interface FileMutationResult {
  success: true;
  path: string;
  created: boolean;
  overwritten: boolean;
  bytes_written: number;
  sha256: string;
  cr_count: number;
  ends_with_newline: boolean;
  flushed: true;
  timestamp_utc: string;
}

const BOM = "\uFEFF";

interface PathLock {
  tail: Promise<unknown>;
}

const pathLocks = new Map<string, PathLock>();

function lockKeyFor(resolvedPath: string): string {
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

/** Serialize mutations per canonical target path (WinHelm-vs-WinHelm races). */
async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const lock = pathLocks.get(key) ?? { tail: Promise.resolve() };
  const gate = Promise.resolve(lock.tail).catch(() => {});
  let release!: () => void;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = { tail: gate.then(() => ticket) };
  pathLocks.set(key, next);
  await gate;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === next) {
      pathLocks.delete(key);
    }
  }
}

function fail(
  code: string,
  message: string,
  userAction?: string,
  details?: Record<string, unknown>
): never {
  throw new StructuredToolError(code, message, userAction, details);
}

function toStructuredNativeError(err: unknown): StructuredToolError {
  if (err instanceof StructuredToolError) return err;
  const native = err as { code?: unknown; nativeCode?: unknown; message?: unknown };
  const code = typeof native?.code === "string" && native.code ? native.code : "MUTATION_FAILED";
  const message =
    typeof native?.message === "string" && native.message ? native.message : String(err);
  return new StructuredToolError(
    code,
    message,
    "Verify the target location and retry the governed mutation.",
    typeof native?.nativeCode === "number" ? { nativeCode: native.nativeCode } : undefined
  );
}

/**
 * Strict mutation reparse denial: any symlink/junction/reparse component on
 * the target chain is rejected with the exact frozen structured error.
 */
export function assertNoReparseTraversal(resolvedPath: string): void {
  const parsed = path.parse(resolvedPath);
  const relative = path.relative(parsed.root, resolvedPath);
  const segments = relative.split(path.sep).filter(Boolean);

  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let lstat;
    try {
      lstat = lstatSync(current, { throwIfNoEntry: false });
    } catch {
      lstat = undefined;
    }
    if (lstat && lstat.isSymbolicLink()) {
      fail(
        "REPARSE_TRAVERSAL_DENIED",
        `Mutation through a symlink/junction/reparse path is not permitted: ${current}`,
        "Use the real canonical physical path; never mutate through reparse points.",
        { reparsePath: current }
      );
    }
    if (!lstat) break;
  }
}

function authorizeMutationTarget(resolvedPath: string): void {
  const manager = ConfigManager.getInstance();
  if (manager.isReadOnly()) {
    fail(
      "READ_ONLY_MODE",
      "File mutation is blocked because WinHelm is operating in read-only mode.",
      "Disable read-only mode to mutate files."
    );
  }
  const check = manager.checkPathAccess(resolvedPath, "write", {
    denyRootMutation: true,
    rejectReparseMutation: true,
  });
  if (!check.allowed) {
    fail(
      check.code === "FOLDER_REPARSE_MUTATION"
        ? "REPARSE_TRAVERSAL_DENIED"
        : check.code ?? "FOLDER_ACCESS_DENIED",
      check.reason ?? `Path is not authorized for mutation: ${resolvedPath}`,
      check.code === "FOLDER_READ_ONLY"
        ? "Configure the folder as readwrite before mutating files in it."
        : "Use a path inside an allowed readwrite WinHelm folder."
    );
  }
}

function prepareContentBytes(
  content: string,
  encoding: AtomicEncoding,
  newline: AtomicNewline,
  finalNewline: boolean,
  bom: boolean
): Buffer {
  if (encoding === "base64") {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(content, "base64");
    } catch (err) {
      fail("CONTENT_INVALID", `base64 content could not be decoded: ${(err as Error).message}`);
    }
    return decoded;
  }

  let text = content;
  if (newline === "lf") {
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  } else if (newline === "crlf") {
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
  }

  if (finalNewline && text.length > 0) {
    if (newline === "crlf") {
      if (!text.endsWith("\r\n")) {
        text = text.replace(/\n$/, "") + "\r\n";
      }
    } else if (!text.endsWith("\n")) {
      text += "\n";
    }
  }

  if (!bom && text.startsWith(BOM)) {
    text = text.slice(BOM.length);
  }
  if (bom && !text.startsWith(BOM)) {
    text = BOM + text;
  }

  return Buffer.from(text, encoding === "ascii" ? "ascii" : "utf8");
}

async function hashFileStreaming(filePath: string): Promise<string> {
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

interface PreconditionView {
  exists: boolean;
  currentSha256: string | null;
}

async function currentTargetState(resolvedPath: string): Promise<PreconditionView> {
  if (!existsSync(resolvedPath)) {
    return { exists: false, currentSha256: null };
  }
  return { exists: true, currentSha256: await hashFileStreaming(resolvedPath) };
}

function checkPreconditions(
  input: { expected_absent?: boolean; expected_current_sha256?: string | null },
  state: PreconditionView
): void {
  if (input.expected_absent && state.exists) {
    fail(
      "PRECONDITION_FAILED",
      "expected_absent precondition failed: the target file already exists.",
      "Inspect the target with file_inspect_batch and choose an exclusive-create or overwrite strategy explicitly.",
      {
        reason: "TARGET_EXISTS",
      }
    );
  }
  if (
    input.expected_current_sha256 !== undefined &&
    input.expected_current_sha256 !== null
  ) {
    const expected = input.expected_current_sha256.toLowerCase();
    if (!state.exists) {
      fail(
        "PRECONDITION_FAILED",
        "Optimistic precondition failed: the target file no longer exists on disk.",
        "Re-inspect the target with file_inspect_batch before retrying.",
        {
          reason: "TARGET_CHANGED",
          expected_sha256: expected,
          actual_sha256: null,
        }
      );
    }
    if (state.currentSha256 !== expected) {
      fail(
        "PRECONDITION_FAILED",
        "Optimistic precondition failed: the target changed outside this mutation.",
        "Re-inspect the target with file_inspect_batch and redo the change on top of the current content.",
        {
          reason: "TARGET_CHANGED",
          expected_sha256: expected,
          actual_sha256: state.currentSha256,
        }
      );
    }
  }
}

async function ensureParentDirectory(resolvedPath: string, createParents: boolean): Promise<void> {
  const parent = path.dirname(resolvedPath);
  if (existsSync(parent)) return;
  if (!createParents) {
    fail(
      "PATH_NOT_FOUND",
      `Parent directory does not exist and create_parents is false: ${parent}`,
      "Create the parent directory or pass create_parents=true."
    );
  }
}

async function recordMutationProvenance(options: {
  sessionId: string;
  tool: string;
  action: "create" | "modify";
  resolvedPath: string;
  beforeSha256: string | null;
  afterSha256: string;
}): Promise<void> {
  try {
    await appendFileProvenanceRecord({
      session_id: options.sessionId,
      tool: options.tool,
      action: options.action,
      path: options.resolvedPath,
      before_sha256: options.beforeSha256,
      after_sha256: options.afterSha256,
      operator: "AI_AGENT",
    });
  } catch (err) {
    // The governed outcome already happened; a journal-write failure must
    // never misreport the mutation result. The gap is surfaced server-side.
    console.error(
      `[WinHelm] File provenance journal write failed for ${options.resolvedPath}:`,
      (err as Error).message
    );
  }
}

export async function writeFileAtomic(
  input: FileWriteAtomicInput,
  sessionId: string
): Promise<FileMutationResult> {
  if (typeof input.content !== "string") {
    fail("CONTENT_INVALID", "content must be a string.");
  }
  const encoding = input.encoding ?? "utf8";
  const newline = input.newline ?? "lf";
  const finalNewline = input.final_newline ?? true;
  const bom = input.bom ?? false;
  const createParents = input.create_parents ?? false;

  const resolved = path.resolve(input.path.normalize("NFKC").trim());

  return withPathLock(lockKeyFor(resolved), async () => {
    authorizeMutationTarget(resolved);
    assertNoReparseTraversal(resolved);
    await ensureParentDirectory(resolved, createParents);

    const entryState = await currentTargetState(resolved);
    checkPreconditions(input, entryState);

    // Race-safe exclusive path: expected_absent routes through the native
    // CREATE_NEW primitive so an external writer that wins the race is
    // rejected atomically instead of being overwritten.
    if (input.expected_absent && !entryState.exists) {
      return exclusiveCreate(
        {
          path: input.path,
          content: input.content,
          encoding,
          newline,
          final_newline: finalNewline,
          bom,
          create_parents: createParents,
        },
        sessionId,
        "file_write_atomic"
      );
    }

    const buffer = prepareContentBytes(
      input.content,
      encoding,
      newline,
      finalNewline,
      bom
    );
    const afterSha256 = createHash("sha256").update(buffer).digest("hex");

    // External-writer re-check immediately before the native commit.
    const preCommitState = await currentTargetState(resolved);
    checkPreconditions(input, preCommitState);

    let nativeResult;
    try {
      nativeResult = getNativeBoundary().atomicReplace(resolved, buffer);
    } catch (err) {
      throw toStructuredNativeError(err);
    }

    await recordMutationProvenance({
      sessionId,
      tool: "file_write_atomic",
      action: entryState.exists ? "modify" : "create",
      resolvedPath: resolved,
      beforeSha256: entryState.exists ? preCommitState.currentSha256 : null,
      afterSha256,
    });

    const finalBytes = buffer;
    return {
      success: true,
      path: resolved,
      created: !entryState.exists,
      overwritten: entryState.exists,
      bytes_written: nativeResult.bytesWritten,
      sha256: afterSha256,
      cr_count: countCr(finalBytes),
      ends_with_newline: endsWithLf(finalBytes),
      flushed: nativeResult.flushed,
      timestamp_utc: new Date().toISOString(),
    };
  });
}

export async function createFileExclusive(
  input: FileCreateExclusiveInput,
  sessionId: string
): Promise<FileMutationResult> {
  if (typeof input.content !== "string") {
    fail("CONTENT_INVALID", "content must be a string.");
  }
  const encoding = input.encoding ?? "utf8";
  const newline = input.newline ?? "lf";
  const finalNewline = input.final_newline ?? true;
  const bom = input.bom ?? false;
  const createParents = input.create_parents ?? false;

  const resolved = path.resolve(input.path.normalize("NFKC").trim());

  return withPathLock(lockKeyFor(resolved), async () => {
    authorizeMutationTarget(resolved);
    assertNoReparseTraversal(resolved);
    await ensureParentDirectory(resolved, createParents);

    return exclusiveCreate(
      {
        path: input.path,
        content: input.content,
        encoding,
        newline,
        final_newline: finalNewline,
        bom,
        create_parents: createParents,
      },
      sessionId,
      "file_create_exclusive"
    );
  });
}

async function exclusiveCreate(
  input: {
    path: string;
    content: string;
    encoding: AtomicEncoding;
    newline: AtomicNewline;
    final_newline: boolean;
    bom: boolean;
    create_parents: boolean;
  },
  sessionId: string,
  tool: string
): Promise<FileMutationResult> {
  const resolved = path.resolve(input.path.normalize("NFKC").trim());
  const buffer = prepareContentBytes(
    input.content,
    input.encoding,
    input.newline,
    input.final_newline,
    input.bom
  );
  const afterSha256 = createHash("sha256").update(buffer).digest("hex");

  let nativeResult;
  try {
    // Exact Win32 CREATE_NEW: never overwrites an existing target.
    nativeResult = getNativeBoundary().createExclusive(resolved, buffer);
  } catch (err) {
    throw toStructuredNativeError(err);
  }

  await recordMutationProvenance({
    sessionId,
    tool,
    action: "create",
    resolvedPath: resolved,
    beforeSha256: null,
    afterSha256,
  });

  return {
    success: true,
    path: resolved,
    created: true,
    overwritten: false,
    bytes_written: nativeResult.bytesWritten,
    sha256: afterSha256,
    cr_count: countCr(buffer),
    ends_with_newline: endsWithLf(buffer),
    flushed: nativeResult.flushed,
    timestamp_utc: new Date().toISOString(),
  };
}

function countCr(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0x0d) count += 1;
  }
  return count;
}

function endsWithLf(buffer: Buffer): boolean {
  return buffer.length > 0 && buffer[buffer.length - 1] === 0x0a;
}
