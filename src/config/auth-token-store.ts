import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteUtf8 } from "./atomic-write.js";

export type AuthTokenStoreState =
  | "missing"
  | "ok"
  | "unreadable"
  | "invalid";

export interface AuthTokenStoreResult {
  state: AuthTokenStoreState;
  token?: string;
  path: string;
}

const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;

/**
 * Bearer token store. The baseline keeps authToken out of the config file and
 * in a file inside the protected WinHelm data directory, which no AI tool may
 * read or write.
 */
export function defaultAuthTokenPath(): string {
  const override = process.env.WINHELM_AUTH_TOKEN_PATH;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), ".winhelm", "auth-token");
}

export function isValidAuthToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const token = value.trim();
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    return false;
  }
  return !/[\s\u0000-\u001f\u007f]/.test(token);
}

export function generateAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Read the stored token. A missing file is "no stored token"; an unreadable or
 * malformed file must fail closed at startup rather than silently fall back to
 * a weaker credential.
 */
export function readStoredAuthToken(
  filePath: string = defaultAuthTokenPath()
): AuthTokenStoreResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", path: filePath };
    }
    return { state: "unreadable", path: filePath };
  }

  const token = raw.trim();
  if (!isValidAuthToken(token)) {
    return { state: "invalid", path: filePath };
  }

  return { state: "ok", token, path: filePath };
}

/**
 * Persist a new token atomically. Throws when the token cannot be stored, so a
 * caller never believes a rotation succeeded when it did not.
 */
export async function writeStoredAuthToken(
  token: string,
  filePath: string = defaultAuthTokenPath()
): Promise<void> {
  if (!isValidAuthToken(token)) {
    throw new Error("Refusing to store an invalid WinHelm auth token.");
  }
  await atomicWriteUtf8(filePath, `${token}\n`, { mode: 0o600 });
}

export interface StartupAuthTokenInput {
  cliToken?: string | null;
  stored: AuthTokenStoreResult;
  configToken?: string | null;
}

/**
 * Startup precedence: --auth, then the rotated secret store, then the legacy
 * authToken field in the config file. The store wins over the config field so a
 * rotation stays in effect after a restart.
 */
export function resolveStartupAuthToken(
  input: StartupAuthTokenInput
): string | undefined {
  const cli = input.cliToken?.trim();
  if (cli) return cli;
  if (input.stored.state === "ok" && input.stored.token) {
    return input.stored.token;
  }
  const config = input.configToken?.trim();
  return config ? config : undefined;
}
