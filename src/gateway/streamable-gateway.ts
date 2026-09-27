import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "../tools/index.js";

interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

export class StreamableGateway {
  private sessions = new Map<string, StreamableSession>();

  private createMcpServerInstance(): McpServer {
    const server = new McpServer({
      name: "winhelm-mcp",
      version: "1.0.0",
    });
    registerAllTools(server);
    return server;
  }

  /**
   * Handle ALL /mcp - Streamable HTTP transport
   */
  public async handleRequest(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // If an existing session ID is provided and active, use it
      if (sessionId && this.sessions.has(sessionId)) {
        const { transport } = this.sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // Create a new session for initialize requests
      const mcpServer = this.createMcpServerInstance();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await mcpServer.connect(transport);

      transport.onclose = () => {
        if (transport.sessionId) {
          this.sessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        this.sessions.set(transport.sessionId, { transport, mcpServer });
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
