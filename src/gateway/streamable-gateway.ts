import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "../tools/index.js";
import { SERVER_VERSION } from "../utils/version.js";

interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  lastActivityAt: number;
}

export class StreamableGateway {
  private sessions = new Map<string, StreamableSession>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private maxSessions: number;

  constructor(idleTimeoutMs = 45 * 60 * 1000, maxSessions = 100) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxSessions = maxSessions;

    // Check periodically for idle sessions; unref timer so it doesn't prevent process exit
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
      version: SERVER_VERSION,
    });
    registerAllTools(server);
    return server;
  }

  /**
   * Evict the least recently used session if capacity is reached
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
   * Handle ALL /mcp - Streamable HTTP transport
   */
  public async handleRequest(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = (req.headers["mcp-session-id"] || req.query?.sessionId || req.query?.["mcp-session-id"]) as string | undefined;

      // If an existing session ID is provided and active, use it.
      // If provided but not found (evicted, idle timeout, or server restart),
      // return 404 with JSON-RPC error immediately according to MCP specification.
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          });
          return;
        }

        session.lastActivityAt = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }

      // Create a new session for initialize requests
      const mcpServer = this.createMcpServerInstance();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string) => {
          this.evictOldestIfNeeded();
          this.sessions.set(newSessionId, {
            transport,
            mcpServer,
            lastActivityAt: Date.now(),
          });
        },
        onsessionclosed: (closedSessionId: string) => {
          const session = this.sessions.get(closedSessionId);
          if (session) {
            this.sessions.delete(closedSessionId);
            session.mcpServer.close().catch(() => {});
          }
        },
      });

      // Set transport.onclose BEFORE mcpServer.connect(transport)
      // so Protocol.connect preserves our handler alongside Protocol._onclose
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          this.sessions.delete(sid);
        }
        mcpServer.close().catch(() => {});
      };

      await mcpServer.connect(transport);

      await transport.handleRequest(req, res);

      // If transport.sessionId is still undefined after handleRequest
      // (not an initialize request or request was rejected/invalid), clean up immediately to prevent leaks
      if (!transport.sessionId) {
        await transport.close().catch(() => {});
        await mcpServer.close().catch(() => {});
      }
    } catch (err) {
      console.error("[StreamableHTTP] Error handling /mcp request:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error", message: (err as Error).message });
      }
    }
  }

  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  public getSession(sessionId: string): StreamableSession | undefined {
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
