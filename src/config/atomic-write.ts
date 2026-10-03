import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteResult {
  path: string;
  bytesWritten: number;
}

export interface RenameRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  platform?: NodeJS.Platform;
  rename?: (source: string, destination: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
]);

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

export async function renameWithTransientRetry(
  source: string,
  destination: string,
  options: RenameRetryOptions = {}
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 8);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 10);
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? fs.rename;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (err) {
      const transient =
        platform === "win32" &&
        WINDOWS_TRANSIENT_RENAME_ERRORS.has(
          errorCode(err) ?? ""
        );
      if (!transient || attempt === attempts - 1) {
        throw err;
      }

      const delay = Math.min(
        160,
        baseDelayMs * 2 ** Math.min(attempt, 4)
      );
      await sleep(delay);
    }
  }
}

function tempFilePath(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return path.join(
    dir,
    `.${base}.winhelm-${process.pid}-${randomUUID()}.tmp`
  );
}

/**
 * Atomically replace a UTF-8 text file.
 *
 * The temporary file is created in the same directory as the destination so
 * the final rename stays on the same filesystem. The temp file is fsync'd
 * before rename and removed on every failure path.
 */
export async function atomicWriteUtf8(
  targetPath: string,
  content: string
): Promise<AtomicWriteResult> {
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });

  const temporary = tempFilePath(resolved);
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(temporary, "wx");
    await handle.writeFile(content, {
      encoding: "utf8",
    });
    await handle.sync();
    await handle.close();
    handle = undefined;

    await renameWithTransientRetry(temporary, resolved);

    return {
      path: resolved,
      bytesWritten: Buffer.byteLength(content, "utf8"),
    };
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(temporary).catch(() => {});
    throw err;
  }
}
