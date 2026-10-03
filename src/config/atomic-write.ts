import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteResult {
  path: string;
  bytesWritten: number;
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

    await fs.rename(temporary, resolved);

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
