import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process admin code store (DEF-02b).
 *
 * Admin codes must be issuable only through a local human channel, and only
 * the digest may be retained. But a code issued by one WinHelm instance (the
 * one owning the local control pipe) has to unlock the Dashboard served by a
 * DIFFERENT instance, otherwise the human approval flow is impossible when
 * Claude/Cursor/Dashboard run as separate processes.
 *
 * The store keeps just the active code's SHA-256 digest and expiry in a file
 * inside the protected `~/.winhelm` tree (same trust boundary as the auth
 * token). Issuing writes it; exchanging consumes it exactly once (atomic
 * unlink). No code material is ever stored, and no new HTTP surface is added.
 */
export interface StoredAdminCode {
  digestHex: string;
  expiresAt: number;
}

const STORE_VERSION = 1;

export function defaultAdminCodeStorePath(): string {
  const override = process.env.WINHELM_ADMIN_CODE_PATH;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), ".winhelm", "admin-code.json");
}

function digestHex(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Publish a freshly issued code's digest for cross-process verification. */
export function writeAdminCode(
  code: string,
  expiresAt: number,
  storePath: string = defaultAdminCodeStorePath()
): void {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(
    dir,
    `.${path.basename(storePath)}.${process.pid}-${crypto
      .randomUUID()
      .slice(0, 8)}.tmp`
  );
  const payload = JSON.stringify(
    { version: STORE_VERSION, digestHex: digestHex(code), expiresAt },
    null,
    2
  );
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, payload, { encoding: "utf8" });
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, storePath);
  } catch (err) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Original failure is the one worth reporting.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort.
    }
    throw err;
  }
}

/**
 * Consume the stored code if it matches and has not expired. Removal is the
 * single-use transition: a second caller finds no record.
 */
export function consumeAdminCode(
  code: string,
  now: number = Date.now(),
  storePath: string = defaultAdminCodeStorePath()
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== STORE_VERSION ||
    typeof parsed.digestHex !== "string" ||
    typeof parsed.expiresAt !== "number"
  ) {
    return false;
  }
  if (now >= parsed.expiresAt) {
    return false;
  }
  const supplied = Buffer.from(digestHex(code), "hex");
  const expected = Buffer.from(parsed.digestHex, "hex");
  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return false;
  }
  try {
    fs.unlinkSync(storePath);
  } catch {
    // Another process consumed it first; treat as consumed.
  }
  return true;
}

/** Invalidate the stored code (used by refresh). */
export function clearAdminCode(
  storePath: string = defaultAdminCodeStorePath()
): void {
  try {
    fs.unlinkSync(storePath);
  } catch {
    // Nothing to clear.
  }
}