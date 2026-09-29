import { randomBytes } from "node:crypto";

export interface SessionData {
  id: string;
  createdAt: number;
  lastAccessedAt: number;
  lastRefreshedAt: number;
  ip?: string;
  userAgent?: string;
}

export interface ExchangeTokenData {
  token: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  ip?: string;
}

/**
 * Ephemeral session & exchange token manager for web dashboard and authenticated clients.
 *
 * Security Design Decisions:
 * 1. SameSite=Strict:
 *    Enforced across all session cookies to guarantee cookies are never sent in cross-site
 *    requests (including top-level navigation from external origins). Because WinHelm controls
 *    local OS commands and filesystem mutations, strict CSRF immunity is non-negotiable.
 *
 * 2. 15-Minute Sliding Expiration Window (900 seconds):
 *    Balances operational convenience during active dashboard monitoring with a bounded exposure
 *    window if a workstation is left unattended. Every active request resets the sliding timer.
 *
 * 3. One-Time Exchange Tokens (5-minute TTL):
 *    URL-based authentication tokens (e.g. ?exchange=... or ?token=...) are single-use only.
 *    Once consumed to establish a session cookie, the token is invalidated immediately to prevent
 *    replay attacks from browser history, proxy access logs, or screen captures.
 *
 * 4. Periodic Memory Cleanup:
 *    Unreferenced background timer unref'd to allow clean process exit while purging expired
 *    sessions and exchange tokens every minute to prevent memory exhaustion.
 */
export class SessionManager {
  private sessions = new Map<string, SessionData>();
  private exchangeTokens = new Map<string, ExchangeTokenData>();
  private readonly ttlMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(ttlMinutes = 15) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    // Periodic cleanup of expired sessions and exchange tokens every minute
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000);
    if (this.cleanupTimer && this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Create a new ephemeral session with a 64-character cryptographically secure token
   */
  public createSession(metadata?: { ip?: string; userAgent?: string }): string {
    const id = randomBytes(32).toString("hex");
    const now = Date.now();
    this.sessions.set(id, {
      id,
      createdAt: now,
      lastAccessedAt: now,
      lastRefreshedAt: now,
      ip: metadata?.ip,
      userAgent: metadata?.userAgent,
    });
    return id;
  }

  /**
   * Validate session token and refresh its sliding expiration if valid
   */
  public validateSession(id?: string | null): boolean {
    if (!id || typeof id !== "string") return false;
    const session = this.sessions.get(id);
    if (!session) return false;

    const now = Date.now();
    if (now - session.lastAccessedAt > this.ttlMs) {
      this.sessions.delete(id);
      return false;
    }

    // Sliding window: refresh last accessed timestamp
    session.lastAccessedAt = now;
    return true;
  }

  /**
   * Check if Set-Cookie header needs refresh (only when > 50% of TTL elapsed)
   * Prevents Set-Cookie churn on rapid sub-second polling requests.
   */
  public shouldRefreshCookie(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    return Date.now() - session.lastRefreshedAt > this.ttlMs / 2;
  }

  /**
   * Mark cookie as refreshed to avoid repeating Set-Cookie on subsequent requests
   */
  public markCookieRefreshed(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastRefreshedAt = Date.now();
    }
  }

  /**
   * Create a short-lived, single-use exchange token (defaults to 5 minutes)
   */
  public createExchangeToken(ttlMs = 5 * 60 * 1000, ip?: string): string {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    this.exchangeTokens.set(token, {
      token,
      createdAt: now,
      expiresAt: now + ttlMs,
      consumed: false,
      ip,
    });
    return token;
  }

  /**
   * Consume an exchange token. Returns true ONLY if valid and never consumed before.
   * Immediately marks token as consumed to prevent replay attacks.
   */
  public consumeExchangeToken(token?: string | null): boolean {
    if (!token || typeof token !== "string") return false;
    const record = this.exchangeTokens.get(token);
    if (!record) return false;

    const now = Date.now();
    if (now > record.expiresAt || record.consumed) {
      this.exchangeTokens.delete(token);
      return false;
    }

    // Invalidate immediately (single-use)
    record.consumed = true;
    this.exchangeTokens.delete(token);
    return true;
  }

  /**
   * Explicitly revoke/destroy a session (e.g. logout)
   */
  public revokeSession(id?: string | null): boolean {
    if (!id) return false;
    return this.sessions.delete(id);
  }

  /**
   * Return number of currently active sessions
   */
  public getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Return number of pending unconsumed exchange tokens
   */
  public getExchangeTokenCount(): number {
    return this.exchangeTokens.size;
  }

  /**
   * Prune expired sessions and exchange tokens from in-memory stores
   */
  public cleanupExpiredSessions(): number {
    const now = Date.now();
    let count = 0;

    // Prune expired sessions
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastAccessedAt > this.ttlMs) {
        this.sessions.delete(id);
        count++;
      }
    }

    // Prune expired or consumed exchange tokens
    for (const [token, record] of this.exchangeTokens.entries()) {
      if (now > record.expiresAt || record.consumed) {
        this.exchangeTokens.delete(token);
        count++;
      }
    }

    return count;
  }

  /**
   * Clear all active sessions and exchange tokens
   */
  public clearAll(): void {
    this.sessions.clear();
    this.exchangeTokens.clear();
  }

  /**
   * Stop background cleanup timer and release resources
   */
  public close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clearAll();
  }
}
