import crypto from "node:crypto";
import {
  clearAdminCode,
  consumeAdminCode,
  defaultAdminCodeStorePath,
  writeAdminCode,
} from "./admin-code-store.js";

export interface AdminAuthOptions {
  now?: () => number;
  codeTtlMs?: number;
  idleTimeoutMs?: number;
  absoluteLifetimeMs?: number;
  /**
   * When true (production), an issued code's digest is mirrored into the
   * protected shared store so a Dashboard process other than the one that
   * issued the code can exchange it (DEF-02b). Off in unit tests unless a
   * codeStorePath is supplied.
   */
  sharedCodeStore?: boolean;
  codeStorePath?: string;
}

export interface AdminSession {
  id: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
}

interface PendingCode {
  digest: Buffer;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function safeDigestEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Process-local admin credential manager.
 *
 * Code issuance must be exposed only through a human/local-presence channel
 * (CLI/TTY in a later layer), never through MCP or an unauthenticated HTTP
 * endpoint. Only the hash of the active code is retained.
 */
export class AdminAuthManager {
  private readonly now: () => number;
  private readonly codeTtlMs: number;
  private readonly idleTimeoutMs: number;
  private readonly absoluteLifetimeMs: number;
  private pendingCode?: PendingCode;
  private readonly sessions = new Map<string, AdminSession>();
  private readonly sharedCodeStore: boolean;
  private readonly codeStorePath: string;

  constructor(options: AdminAuthOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.absoluteLifetimeMs =
      options.absoluteLifetimeMs ?? DEFAULT_ABSOLUTE_LIFETIME_MS;
    this.codeStorePath = options.codeStorePath ?? defaultAdminCodeStorePath();
    this.sharedCodeStore =
      options.sharedCodeStore ?? options.codeStorePath !== undefined;
  }

  issueCode(): { code: string; expiresAt: number } {
    const now = this.now();
    const code = randomSecret(12);
    const expiresAt = now + this.codeTtlMs;
    this.pendingCode = {
      digest: digest(code),
      createdAt: now,
      expiresAt,
      consumed: false,
    };
    if (this.sharedCodeStore) {
      // Digest only; never the code itself.
      writeAdminCode(code, expiresAt, this.codeStorePath);
    }
    return { code, expiresAt };
  }

  refreshCode(): { code: string; expiresAt: number } {
    this.pendingCode = undefined;
    if (this.sharedCodeStore) {
      clearAdminCode(this.codeStorePath);
    }
    return this.issueCode();
  }

  exchangeCode(code: string): AdminSession | undefined {
    const pending = this.pendingCode;
    if (pending && !pending.consumed && this.now() < pending.expiresAt) {
      const supplied = digest(code);
      if (safeDigestEqual(pending.digest, supplied)) {
        pending.consumed = true;
        this.pendingCode = undefined;
        return this.createSession();
      }
      // Wrong attempt against our own code: do not consume it.
      return undefined;
    }

    this.pendingCode = undefined;
    // DEF-02b: the code may have been issued by a different WinHelm instance
    // (the one owning the local control pipe). Verify against the protected
    // shared digest store; consumption there is the single-use transition.
    if (
      this.sharedCodeStore &&
      consumeAdminCode(code, this.now(), this.codeStorePath)
    ) {
      return this.createSession();
    }
    return undefined;
  }

  private createSession(): AdminSession {
    const now = this.now();
    const session: AdminSession = {
      id: randomSecret(32),
      csrfToken: randomSecret(32),
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.absoluteLifetimeMs,
    };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  validateSession(
    sessionId: string,
    options: { touch?: boolean } = {}
  ): AdminSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const now = this.now();
    if (
      now >= session.absoluteExpiresAt ||
      now - session.lastSeenAt >= this.idleTimeoutMs
    ) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    if (options.touch !== false) {
      session.lastSeenAt = now;
    }

    return { ...session };
  }

  validateCsrf(sessionId: string, csrfToken: string): boolean {
    const session = this.validateSession(sessionId, { touch: false });
    if (!session) return false;
    return safeDigestEqual(digest(session.csrfToken), digest(csrfToken));
  }

  revokeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  revokeAll(): void {
    this.sessions.clear();
    this.pendingCode = undefined;
  }

  cleanup(): number {
    let removed = 0;
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (
        now >= session.absoluteExpiresAt ||
        now - session.lastSeenAt >= this.idleTimeoutMs
      ) {
        this.sessions.delete(id);
        removed += 1;
      }
    }

    if (this.pendingCode && now >= this.pendingCode.expiresAt) {
      this.pendingCode = undefined;
    }

    return removed;
  }

  get idleTimeoutSeconds(): number {
    return Math.floor(this.idleTimeoutMs / 1000);
  }

  get absoluteLifetimeSeconds(): number {
    return Math.floor(this.absoluteLifetimeMs / 1000);
  }
}
