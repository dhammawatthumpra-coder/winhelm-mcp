import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import type { Server } from "node:http";
import { ConfigManager } from "../config/config-manager.js";
import { SseGateway } from "./sse-gateway.js";
import { StreamableGateway } from "./streamable-gateway.js";
import { logger } from "../utils/logger.js";
import { fileLogger } from "../utils/file-logger.js";
import { taskManager } from "../engine/task-manager.js";
import { RateLimiter } from "./rate-limiter.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { getFilePreviewHtml } from "./preview-html.js";
import { getGpuInfo, getSystemInfo } from "../engine/system.js";
import type { GpuInfoResult, SystemInfo } from "../types/index.js";

export interface ServerOptions {
  port: number;
  host: string;
  authToken?: string | null;
}

export function createServer(options: ServerOptions): {
  app: Express;
  start: () => Promise<Server>;
  stop: (server: Server) => Promise<void>;
} {
  const app = express();
  const configManager = ConfigManager.getInstance();
  const config = configManager.getConfig();
  const authToken = options.authToken ?? config.authToken;

  const sseGateway = new SseGateway();
  const streamableGateway = new StreamableGateway();
  const rateLimiter = new RateLimiter();

  // Cache system info for 2.5s to avoid PowerShell overhead during continuous polling
  let cachedSystemInfo: SystemInfo | null = null;
  let lastSystemInfoFetch = 0;

  async function getCachedSystemInfo(): Promise<SystemInfo> {
    const now = Date.now();
    if (!cachedSystemInfo || now - lastSystemInfoFetch > 2500) {
      try {
        cachedSystemInfo = await getSystemInfo();
        lastSystemInfoFetch = now;
      } catch {
        // Fallback to previous cache if exists
      }
    }
    return cachedSystemInfo || {};
  }

  // Cache GPU info for 5s
  let cachedGpuInfo: GpuInfoResult | null = null;
  let lastGpuInfoFetch = 0;

  async function getCachedGpuInfo(): Promise<GpuInfoResult | null> {
    const now = Date.now();
    if (!cachedGpuInfo || now - lastGpuInfoFetch > 5000) {
      try {
        cachedGpuInfo = await getGpuInfo();
        lastGpuInfoFetch = now;
      } catch {
        // Fallback
      }
    }
    return cachedGpuInfo;
  }

  // CORS configuration: restrict external web origins by default to prevent DNS-rebinding
  const corsOption = config.corsOrigins;
  if (corsOption === true || corsOption === "*") {
    app.use(cors({ origin: "*" }));
  } else if (Array.isArray(corsOption) || typeof corsOption === "string") {
    app.use(cors({ origin: corsOption }));
  } else {
    // Default: permit local requests and loopback origins, preventing external DNS-rebinding attacks
    app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            return callback(null, true);
          }
          return callback(new Error("CORS origin not allowed by WinHelm security policy"));
        },
      })
    );
  }

  // Detailed Request Logger Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const isInternalPolling =
        req.path === "/health" ||
        req.path.startsWith("/api/monitor/") ||
        req.path === "/" ||
        req.path === "/dashboard" ||
        req.path === "/preview";

      // Only print terminal logs for MCP protocol and external actions, keeping terminal clean & stable
      if (!isInternalPolling) {
        const sessionId = (req.headers["mcp-session-id"] || req.query.sessionId) as string | undefined;
        const clientIp = req.ip || req.socket.remoteAddress || "-";
        logger.req(req.method, req.originalUrl, res.statusCode, duration, clientIp, sessionId);
      }
    });
    next();
  });

  // Rate Limiting Guard
  app.use(rateLimiter.middleware());

  // Bearer Authentication Guard
  if (authToken) {
    logger.security("Bearer authentication guard is ACTIVE");
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Allow only lightweight public endpoints: health check and basic dashboard shell
      if (req.path === "/health" || req.path === "/" || req.path === "/dashboard") {
        return next();
      }

      // 1. Check standard Authorization header
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader === `Bearer ${authToken}`) {
        return next();
      }

      // 2. Fallback for browser dashboard & preview: read token from query param (?token=... or ?auth=...) or cookie
      const queryToken = (req.query.token || req.query.auth) as string | undefined;
      const cookieHeader = req.headers.cookie;
      let cookieToken: string | undefined;
      if (cookieHeader) {
        const match = cookieHeader.match(/(?:^|;\s*)(?:authToken|token|auth)=([^;]+)/);
        if (match) {
          cookieToken = decodeURIComponent(match[1]);
        }
      }

      const browserToken = queryToken || cookieToken;
      if (browserToken && browserToken === authToken) {
        return next();
      }

      logger.security("Unauthorized request blocked", `Path: ${req.path} | IP: ${req.ip}`);
      res.status(401).json({ error: "Unauthorized: Invalid or missing Bearer token" });
    });
  } else {
    logger.info("Public network mode active (No auth token set)");
  }

  // Web Monitor Dashboard
  app.get(["/", "/dashboard"], (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const activeProfile = configManager.getConfig().profile || "full";
    res.send(getDashboardHtml(activeProfile));
  });

  // Interactive File & Markdown Previewer
  app.get("/preview", async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).send("Missing ?path= parameter");
      return;
    }
    const html = await getFilePreviewHtml(filePath);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      server: "winhelm-mcp",
      version: "1.0.0",
      activeSessions: {
        sse: sseGateway.getActiveSessionCount(),
        streamableHttp: streamableGateway.getActiveSessionCount(),
      },
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Monitor Stats API
  app.get("/api/monitor/stats", async (_req: Request, res: Response) => {
    const sys = await getCachedSystemInfo();
    const gpu = await getCachedGpuInfo();
    res.json({
      server: "winhelm-mcp",
      version: "1.0.0",
      port: options.port,
      host: options.host,
      readOnly: configManager.isReadOnly(),
      uptimeSeconds: Math.floor(process.uptime()),
      activeSessions: {
        sse: sseGateway.getActiveSessionCount(),
        streamableHttp: streamableGateway.getActiveSessionCount(),
      },
      backgroundTasks: taskManager.listTasks().length,
      system: sys,
      gpu: gpu,
    });
  });

  // Monitor Logs API
  app.get("/api/monitor/logs", (_req: Request, res: Response) => {
    res.json({
      logs: logger.getRecentLogs(100),
    });
  });

  app.delete("/api/monitor/logs", (_req: Request, res: Response) => {
    logger.clearLogs();
    res.json({ success: true, message: "Logs cleared" });
  });

  // Audit Logs Export API (JSON or CSV)
  app.get("/api/monitor/export", async (req: Request, res: Response) => {
    const format = req.query.format === "csv" ? "csv" : "json";
    const data = await fileLogger.exportLogs(format);
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="winhelm-audit.csv"');
    } else {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", 'attachment; filename="winhelm-audit.json"');
    }
    res.send(data);
  });

  // Streamable HTTP Endpoint (/mcp)
  app.all("/mcp", (req: Request, res: Response) => streamableGateway.handleRequest(req, res));

  // SSE Endpoints (/sse & /message)
  app.get("/sse", (req: Request, res: Response) => sseGateway.handleSseConnect(req, res));
  app.post("/message", (req: Request, res: Response) => sseGateway.handlePostMessage(req, res));

  const start = (): Promise<Server> => {
    return new Promise((resolve) => {
      const server = app.listen(options.port, options.host, () => {
        console.log(`\n======================================================`);
        console.log(`  🚀 WinHelm MCP Server is running!`);
        console.log(`======================================================`);
        console.log(`  - Web Monitor:     http://localhost:${options.port}/`);
        console.log(`  - Streamable HTTP: http://${options.host}:${options.port}/mcp`);
        console.log(`  - SSE Endpoint:    http://${options.host}:${options.port}/sse`);
        console.log(`  - SSE Message:     http://${options.host}:${options.port}/message`);
        console.log(`  - Health Check:    http://${options.host}:${options.port}/health`);
        console.log(`======================================================\n`);
        resolve(server);
      });
    });
  };

  const stop = async (server: Server): Promise<void> => {
    // 1. Kill any active background tasks
    taskManager.killAll();

    // 2. Close MCP Sessions
    await Promise.all([
      sseGateway.closeAll().catch(() => {}),
      streamableGateway.closeAll().catch(() => {}),
    ]);

    // 3. Close network sockets
    return new Promise((resolve) => {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }

      server.close(() => {
        resolve();
      });

      const safetyTimer = setTimeout(() => {
        resolve();
      }, 800);
      safetyTimer.unref();
    });
  };

  return { app, start, stop };
}
