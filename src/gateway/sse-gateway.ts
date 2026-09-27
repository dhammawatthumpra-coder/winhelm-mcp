import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerAllTools } from "../tools/index.js";

interface SseSession {
  transport: SSEServerTransport;
  mcpServer: McpServer;
  lastActivityAt: number;
}

export class SseGateway {
  private sessions = new Map<string, SseSession>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private maxSessions: number;

  constructor(idleTimeoutMs = 45 * 60 * 1000, maxSessions = 100) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxSessions = maxSessions;

    const intervalMs = Math.min(60000, Math.max(1000, Math.floor(this.idleTimeoutMs / 2)));
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleSessions();
    }, intervalMs);
    if (this.cleanupTimer && this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private createMcpServerInstance(): McpServer {
    const server = new McpServer({
      name: "winhelm-mcp",
      version: "1.0.0",
    });
    registerAllTools(server);
    return server;
  }

  /**
   * Evict least recently used session if capacity is reached
   */
  private evictOldestIfNeeded(): void {
    while (this.sessions.size >= this.maxSessions) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      for (const [key, session] of this.sessions.entries()) {
        if (session.lastActivityAt < oldestTime) {
          oldestTime = session.lastActivityAt;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        const session = this.sessions.get(oldestKey);
        this.sessions.delete(oldestKey);
        if (session) {
          session.mcpServer.close().catch(() => {});
        }
      } else {
        break;
      }
    }
  }

  /**
   * Cleanup sessions that have been idle longer than idleTimeoutMs
   */
  public cleanupIdleSessions(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt > this.idleTimeoutMs) {
        this.sessions.delete(key);
        session.mcpServer.close().catch(() => {});
        count++;
      }
    }
    return count;
  }

  /**
   * Handle GET /sse - Client initializes SSE stream
   */
  public async handleSseConnect(req: Request, res: Response): Promise<void> {
    console.log(`[SSE] New SSE client connecting from ${req.ip}`);
    try {
      this.evictOldestIfNeeded();

      const mcpServer = this.createMcpServerInstance();
      const transport = new SSEServerTransport("/message", res);
      await mcpServer.connect(transport);

      const sessionId = transport.sessionId;
      this.sessions.set(sessionId, {
        transport,
        mcpServer,
        lastActivityAt: Date.now(),
      });
      console.log(`[SSE] Session initialized: ${sessionId}`);

      req.on("close", () => {
        console.log(`[SSE] Client disconnected (session: ${sessionId})`);
        this.sessions.delete(sessionId);
        mcpServer.close().catch(() => {});
      });
    } catch (err) {
      console.error("[SSE] Failed to establish SSE connection:", err);
      if (!res.headersSent) {
        res.status(500).send("Failed to initialize SSE connection");
      }
    }
  }

  /**
   * Handle POST /message - Client sends JSON-RPC message for SSE session
   */
  public async handlePostMessage(req: Request, res: Response): Promise<void> {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).send("Missing sessionId parameter");
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).send(`Active session not found for ID: ${sessionId}`);
      return;
    }

    session.lastActivityAt = Date.now();

    try {
      await session.transport.handlePostMessage(req, res);
    } catch (err) {
      console.error(`[SSE] Error processing POST message for session ${sessionId}:`, err);
      if (!res.headersSent) {
        res.status(500).send("Error handling message");
      }
    }
  }

  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  public getSession(sessionId: string): SseSession | undefined {
    return this.sessions.get(sessionId);
  }

  public setSessionLastActivity(sessionId: string, timestamp: number): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = timestamp;
      return true;
    }
    return false;
  }

  public registerSessionForTest(
    sessionId: string,
    session: { transport?: any; mcpServer?: any; lastActivityAt?: number } = {}
  ): void {
    this.evictOldestIfNeeded();
    this.sessions.set(sessionId, {
      transport: session.transport || ({} as any),
      mcpServer: session.mcpServer || ({ close: async () => {} } as any),
      lastActivityAt: session.lastActivityAt ?? Date.now(),
    });
  }

  public async closeAll(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const session of this.sessions.values()) {
      try {
        await session.mcpServer.close();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }
}
