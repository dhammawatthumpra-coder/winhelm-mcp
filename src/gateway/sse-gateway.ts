import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerAllTools } from "../tools/index.js";

interface SseSession {
  transport: SSEServerTransport;
  mcpServer: McpServer;
}

export class SseGateway {
  private sessions = new Map<string, SseSession>();

  private createMcpServerInstance(): McpServer {
    const server = new McpServer({
      name: "winhelm-mcp",
      version: "1.0.0",
    });
    registerAllTools(server);
    return server;
  }

  /**
   * Handle GET /sse - Client initializes SSE stream
   */
  public async handleSseConnect(req: Request, res: Response): Promise<void> {
    console.log(`[SSE] New SSE client connecting from ${req.ip}`);
    try {
      const mcpServer = this.createMcpServerInstance();
      const transport = new SSEServerTransport("/message", res);
      await mcpServer.connect(transport);

      const sessionId = transport.sessionId;
      this.sessions.set(sessionId, { transport, mcpServer });
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

  public async closeAll(): Promise<void> {
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
