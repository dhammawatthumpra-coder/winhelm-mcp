import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { ConfigManager } from "../config/config-manager.js";
import { SseGateway } from "./sse-gateway.js";
import { StreamableGateway } from "./streamable-gateway.js";
import { logger } from "../utils/logger.js";
import { fileLogger } from "../utils/file-logger.js";
import { taskManager } from "../engine/task-manager.js";
import { RateLimiter } from "./rate-limiter.js";
import { SessionManager } from "./session-manager.js";
import { auditLogger } from "../utils/audit-logger.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { getFilePreviewHtml } from "./preview-html.js";
import { getGpuInfo, getSystemInfo } from "../engine/system.js";
import type { GpuInfoResult, SystemInfo } from "../types/index.js";

export interface ServerOptions {
  port: number;
  host: string;
  authToken?: string | null;
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate Host header against loopback, bound interface, and allowed hosts whitelist (DNS Rebinding protection)
 */
export function isHostAllowed(
  hostHeader?: string,
  allowedHosts: string[] = ["localhost", "127.0.0.1", "[::1]", "*.ts.net"],
  bindHost = "127.0.0.1"
): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  const cleanHeader = hostHeader.trim().toLowerCase();

  // Handle IPv6 literal with brackets [::1]:port or naked ::1
  if (cleanHeader.startsWith("[")) {
    const endBracket = cleanHeader.indexOf("]");
    hostname = endBracket !== -1 ? cleanHeader.slice(1, endBracket) : cleanHeader;
  } else if (cleanHeader === "::1" || cleanHeader.startsWith("::1:")) {
    hostname = "::1";
  } else {
    hostname = cleanHeader.split(":")[0];
  }

  // Always permit loopback interfaces
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return true;
  }

  // Permit explicitly configured bind host interface
  if (bindHost && hostname === bindHost.toLowerCase()) {
    return true;
  }

  // Permit Tailscale CGNAT IP range (100.64.0.0/10: 100.64.0.0 - 100.127.255.255)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }

  // Check allowed hosts whitelist (supports wildcard prefixes like *.ts.net, *.example.com)
  return allowedHosts.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (p === "*") return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1);
      return hostname.endsWith(suffix) || hostname === p.slice(2);
    }
    return hostname === p;
  });
}

/**
 * Validate Origin header for Cross-Origin Resource Sharing (CORS)
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedHosts: string[] = ["localhost", "127.0.0.1", "[::1]", "*.ts.net"],
  bindHost = "127.0.0.1"
): boolean {
  if (!origin) return true; // Non-browser clients (curl, stdio, native apps) do not send Origin header

  // 1. Allow browser extensions & IDE webview origins (Chrome, Edge, Firefox, Safari, VS Code/Cursor)
  if (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("safari-web-extension://") ||
    origin.startsWith("vscode-webview://")
  ) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    const hostWithPort = parsed.host;
    const hostname = parsed.hostname;

    // 2. Matches host validation (loopback, bindHost, *.ts.net, Tailscale CGNAT, custom allowedHosts)
    if (isHostAllowed(hostWithPort, allowedHosts, bindHost)) {
      return true;
    }

    // 2. Allow Tailscale CGNAT IP origins directly
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true;
    }

    // 3. Allow standard remote Web MCP client origins (Claude.ai, ChatGPT)
    if (
      hostname === "claude.ai" ||
      hostname.endsWith(".claude.ai") ||
      hostname === "chatgpt.com" ||
      hostname.endsWith(".chatgpt.com")
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function createServer(options: ServerOptions): {
  app: Express;
  start: () => Promise<Server>;
  stop: (server: Server) => Promise<void>;
  sessionManager: SessionManager;
} {
  const app = express();
  // Trust proxy for loopback reverse proxies (Tailscale Funnel, local tunnel clients)
  app.set("trust proxy", "loopback");
  const configManager = ConfigManager.getInstance();
  const config = configManager.getConfig();
  const authToken = options.authToken ?? config.authToken;

  // 1. Global Security Headers (Prevent MIME sniffing and Clickjacking)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // 2. Host Header Validation Guard (Mitigates DNS Rebinding attacks)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const hostHeader = req.get("host") || "";
    const allowed = config.allowedHosts || ["localhost", "127.0.0.1", "[::1]", "*.ts.net"];
    if (!isHostAllowed(hostHeader, allowed, options.host)) {
      logger.security(
        "Blocked request with unauthorized Host header (DNS Rebinding protection)",
        `Host: ${hostHeader} | IP: ${req.ip}`
      );
      res.status(403).json({
        error: "Forbidden: Host header not permitted by WinHelm security policy",
      });
      return;
    }
    next();
  });

  // 3. Remote Proxy / Tunnel Security Guard (Fail-closed when no auth token is configured)
  if (!authToken) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.headers["x-forwarded-for"] || req.headers["forwarded"]) {
        logger.security(
          "Blocked unauthenticated remote proxy/tunnel request",
          `Path: ${req.path} | IP: ${req.ip} | X-Forwarded-For: ${req.headers["x-forwarded-for"]}`
        );
        res.status(403).json({
          error: "Forbidden: Remote proxy/tunnel access is strictly blocked when no authentication token is configured. Set an authToken or --auth.",
        });
        return;
      }
      next();
    });
  }

  const sseGateway = new SseGateway(config.sessionIdleTimeoutMs, config.maxConcurrentSessions);
  const streamableGateway = new StreamableGateway(config.sessionIdleTimeoutMs, config.maxConcurrentSessions);
  const rateLimiter = new RateLimiter();
  const sessionManager = new SessionManager(15);

  // Dedicated body parsers for /auth and /api endpoints (leaving /mcp, /sse, /message raw streams untouched)
  app.use("/auth", express.json());
  app.use("/api", express.json());

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

  // 4. CORS configuration: restricts web browser cross-origin requests
  // Must expose Mcp-Session-Id so browser extensions/web clients can read session ID from initialization response
  const exposedHeaders = [
    "Mcp-Session-Id",
    "mcp-session-id",
    "Mcp-Protocol-Version",
    "mcp-protocol-version",
    "Last-Event-ID",
  ];
  const corsOption = config.corsOrigins;
  if (corsOption === true || corsOption === "*") {
    // Dynamic origin reflection to comply with W3C CORS spec when credentials: true
    app.use(
      cors({
        origin: (_origin, callback) => callback(null, true),
        credentials: true,
        exposedHeaders,
      })
    );
  } else if (Array.isArray(corsOption) || typeof corsOption === "string") {
    app.use(cors({ origin: corsOption, credentials: true, exposedHeaders }));
  } else {
    const allowed = config.allowedHosts || ["localhost", "127.0.0.1", "[::1]", "*.ts.net"];
    app.use(
      cors({
        origin: (origin, callback) => {
          if (isOriginAllowed(origin, allowed, options.host)) {
            return callback(null, true);
          }
          // Gracefully omit Access-Control-Allow-Origin header without crashing Express with an unhandled error
          return callback(null, false);
        },
        credentials: true,
        exposedHeaders,
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
        req.path === "/dashboard";

      // Only print terminal logs for MCP protocol and external actions, keeping terminal clean & stable
      if (!isInternalPolling) {
        const sessionId = (req.headers["mcp-session-id"] || req.query.sessionId) as string | undefined;
        const clientIp = req.ip || req.socket.remoteAddress || "-";
        // Sanitize URL to strip sensitive tokens/secrets from terminal and persistent disk logs
        const safeUrl = req.originalUrl.replace(/([?&])(token|auth|exchange)=[^&]*/gi, "$1$2=[REDACTED]");
        logger.req(req.method, safeUrl, res.statusCode, duration, clientIp, sessionId);
      }
    });
    next();
  });

  // Rate Limiting Guard
  app.use(rateLimiter.middleware());

  // 1-Time / Ephemeral Token Exchange Endpoint
  app.post("/auth/exchange", (req: Request, res: Response) => {
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";

    // 1. Origin Header Validation Guard (defense-in-depth against unauthorized web clients)
    const origin = req.get("origin");
    const allowed = config.allowedHosts || ["localhost", "127.0.0.1", "[::1]", "*.ts.net"];
    if (origin && !isOriginAllowed(origin, allowed, options.host)) {
      logger.security("Blocked /auth/exchange request from unauthorized origin", `Origin: ${origin} | IP: ${req.ip}`);
      return res.status(403).json({ error: "Forbidden: Origin not permitted by WinHelm security policy" });
    }

    if (!authToken) {
      const sessionId = sessionManager.createSession({ ip: req.ip, userAgent: req.get("user-agent") });
      res.setHeader(
        "Set-Cookie",
        `winhelm_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${isSecure ? "; Secure" : ""}`
      );
      return res.json({ success: true, sessionId, expiresIn: 900 });
    }

    const providedToken = req.body?.token;
    if (!providedToken || typeof providedToken !== "string") {
      logger.security("Token exchange failed: Missing token in body", `IP: ${req.ip}`);
      return res.status(401).json({ error: "Unauthorized: Missing token in request payload" });
    }

    // Accept either a single-use exchange token (invalidates immediately) or the master authToken
    const isOneTimeValid = sessionManager.consumeExchangeToken(providedToken);
    const isMasterValid = safeCompare(providedToken, authToken);

    if (!isOneTimeValid && !isMasterValid) {
      logger.security("Token exchange failed: Invalid or expired token", `IP: ${req.ip}`);
      auditLogger.log({
        event: "AUTH_EXCHANGE_FAILURE",
        severity: "WARN",
        actor: { ip: req.ip, authType: "none" },
        action: "POST /auth/exchange",
        outcome: "DENIED",
        details: "Invalid or already consumed token in exchange payload",
      });
      return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
    }

    const sessionId = sessionManager.createSession({ ip: req.ip, userAgent: req.get("user-agent") });
    res.setHeader(
      "Set-Cookie",
      `winhelm_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${isSecure ? "; Secure" : ""}`
    );

    auditLogger.log({
      event: "AUTH_EXCHANGE_SUCCESS",
      severity: "INFO",
      actor: { ip: req.ip, authType: "session_cookie", sessionId },
      action: "POST /auth/exchange",
      outcome: "ALLOWED",
      details: isOneTimeValid
        ? "Exchanged one-time token for ephemeral session cookie"
        : "Exchanged master authToken for ephemeral session cookie",
    });

    return res.json({ success: true, sessionId, expiresIn: 900 });
  });

  // Ephemeral Session Logout Endpoint
  app.post("/auth/logout", (req: Request, res: Response) => {
    const cookieHeader = req.headers.cookie;
    let sessionId: string | undefined;
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)winhelm_session=([^;]+)/);
      if (match) sessionId = decodeURIComponent(match[1]);
    }
    if (sessionId) {
      sessionManager.revokeSession(sessionId);
    }
    res.setHeader(
      "Set-Cookie",
      "winhelm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    );
    res.json({ success: true, message: "Logged out" });
  });

  // Bearer & Ephemeral Session Authentication Guard
  if (authToken) {
    logger.security("Bearer & Ephemeral Session authentication guard is ACTIVE");
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Allow only lightweight public endpoints: health check, auth exchange, logout, and security.txt
      if (
        req.path === "/health" ||
        req.path === "/auth/exchange" ||
        req.path === "/auth/logout" ||
        req.path === "/.well-known/security.txt" ||
        req.path === "/security.txt"
      ) {
        return next();
      }

      // 1. Check standard Authorization header (timing-safe comparison)
      const authHeader = req.headers.authorization;
      if (authHeader && safeCompare(authHeader, `Bearer ${authToken}`)) {
        return next();
      }

      // 2. Check ephemeral session cookie (winhelm_session) with sliding 15-minute expiration
      const cookieHeader = req.headers.cookie;
      let sessionCookieId: string | undefined;
      if (cookieHeader) {
        const match = cookieHeader.match(/(?:^|;\s*)winhelm_session=([^;]+)/);
        if (match) {
          sessionCookieId = decodeURIComponent(match[1]);
        }
      }

      if (sessionCookieId) {
        if (sessionManager.validateSession(sessionCookieId)) {
          // Sliding window: refresh cookie Max-Age only after 50% of TTL elapsed to prevent header churn
          if (sessionManager.shouldRefreshCookie(sessionCookieId)) {
            const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
            res.setHeader(
              "Set-Cookie",
              `winhelm_session=${encodeURIComponent(sessionCookieId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${isSecure ? "; Secure" : ""}`
            );
            sessionManager.markCookieRefreshed(sessionCookieId);
          }
          return next();
        } else {
          // Invalidate stale or non-existent session cookie immediately on client
          res.setHeader(
            "Set-Cookie",
            "winhelm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
          );
        }
      }

      // 3. Fallback for URL query parameter (?exchange=..., ?token=..., ?auth=...)
      const queryToken = (req.query.exchange || req.query.token || req.query.auth) as string | undefined;
      if (queryToken) {
        const isBrowserNav = req.path === "/" || req.path === "/dashboard" || req.path === "/preview";
        const isMcpProtocol = req.path === "/mcp" || req.path === "/sse" || req.path === "/message";
        const acceptHeader = req.headers["accept"] || "";

        // Check if queryToken is a one-time exchange token (single-use) or master authToken
        const isOneTimeValid = sessionManager.consumeExchangeToken(queryToken);
        const isMasterValid = safeCompare(queryToken, authToken);

        if (isOneTimeValid || isMasterValid) {
          // For MCP protocol endpoints (/mcp, /sse, /message), permit with query token
          // WITHOUT creating a session or sending Set-Cookie headers
          if (isMcpProtocol) {
            logger.security(
              "Authenticated MCP protocol request via URL query token (prefer Authorization: Bearer header)",
              `Path: ${req.path} | IP: ${req.ip}`
            );
            return next();
          }

          // For dashboard and other endpoints, establish ephemeral session and Set-Cookie
          const sessionId = sessionManager.createSession({ ip: req.ip, userAgent: req.get("user-agent") });
          const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
          res.setHeader(
            "Set-Cookie",
            `winhelm_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${isSecure ? "; Secure" : ""}`
          );

          // For browser page navigation with HTML accept header, redirect to strip token from URL & browser history
          if (isBrowserNav && acceptHeader.includes("text/html")) {
            const cleanQuery = { ...req.query };
            delete cleanQuery.exchange;
            delete cleanQuery.token;
            delete cleanQuery.auth;
            const searchParams = new URLSearchParams(cleanQuery as Record<string, string>).toString();
            const cleanUrl = searchParams ? `${req.path}?${searchParams}` : req.path;
            return res.redirect(cleanUrl);
          }

          return next();
        }

        // If client specifically used an exchange token that was already consumed or invalid on browser endpoint
        if (req.query.exchange && isBrowserNav) {
          logger.security("One-time exchange token rejected or already consumed (Replay prevention)", `IP: ${req.ip}`);
          auditLogger.log({
            event: "EXCHANGE_TOKEN_REPLAY_REJECTED",
            severity: "WARN",
            actor: { ip: req.ip, authType: "query_token" },
            action: `${req.method} ${req.path}`,
            outcome: "DENIED",
            details: "Attempted to re-use expired or already consumed exchange token",
          });
          return res.status(401).json({ error: "Unauthorized: Exchange token is invalid or has already been used" });
        }
      }

      // 4. Deprecated legacy cookie migration (authToken=...)
      if (cookieHeader) {
        const legacyMatch = cookieHeader.match(/(?:^|;\s*)authToken=([^;]+)/);
        if (legacyMatch) {
          const legacyVal = decodeURIComponent(legacyMatch[1]);
          if (safeCompare(legacyVal, authToken)) {
            logger.security("Deprecated authToken cookie used; upgrading to ephemeral session", `IP: ${req.ip}`);
            const sessionId = sessionManager.createSession({ ip: req.ip, userAgent: req.get("user-agent") });
            const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
            res.setHeader(
              "Set-Cookie",
              `winhelm_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${isSecure ? "; Secure" : ""}`
            );
            return next();
          }
        }
      }

      // Allow unauthenticated GET / and /dashboard shell (data endpoints /api/monitor/* remain strictly guarded)
      if (req.path === "/" || req.path === "/dashboard") {
        return next();
      }

      logger.security("Unauthorized request blocked", `Path: ${req.path} | IP: ${req.ip}`);
      auditLogger.log({
        event: "UNAUTHORIZED_REQUEST_BLOCKED",
        severity: "WARN",
        actor: { ip: req.ip, authType: "none" },
        action: `${req.method} ${req.path}`,
        outcome: "DENIED",
        details: "Missing or invalid Bearer token / session cookie",
      });
      res.status(401).json({ error: "Unauthorized: Invalid or missing Bearer token / session cookie" });
    });
  } else {
    logger.info("Public network mode active (No auth token set)");
  }

  // Web Monitor Dashboard
  app.get(["/", "/dashboard"], (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'none'; base-uri 'self';"
    );
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
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none';"
    );
    res.send(html);
  });

  // RFC 9116 security.txt disclosure endpoint
  app.get(["/.well-known/security.txt", "/security.txt"], (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(
      `Contact: https://github.com/dhammawatthumpra-coder/winhelm-mcp/security/advisories\n` +
      `Expires: 2027-12-31T23:59:59.000Z\n` +
      `Preferred-Languages: en, th\n` +
      `Policy: https://github.com/dhammawatthumpra-coder/winhelm-mcp/blob/main/SECURITY.md\n` +
      `Canonical: https://raw.githubusercontent.com/dhammawatthumpra-coder/winhelm-mcp/main/public/.well-known/security.txt\n`
    );
  });

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      server: "winhelm-mcp",
      version: "1.2.0",
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
      version: "1.2.0",
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

  // Friendly browser redirect for /mcp: if human visits in a web browser (Accept: text/html), redirect to dashboard
  app.get("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/html") && !accept.includes("text/event-stream")) {
      const token = (req.query.token || req.query.auth) as string | undefined;
      const redirectUrl = token ? `/?token=${encodeURIComponent(token)}` : "/";
      return res.redirect(redirectUrl);
    }
    next();
  });

  // Streamable HTTP Endpoint (/mcp)
  app.all("/mcp", (req: Request, res: Response) => streamableGateway.handleRequest(req, res));

  // SSE Endpoints (/sse & /message)
  app.get("/sse", (req: Request, res: Response) => sseGateway.handleSseConnect(req, res));
  app.post("/message", (req: Request, res: Response) => sseGateway.handlePostMessage(req, res));

  const start = (): Promise<Server> => {
    return new Promise((resolve) => {
      const server = app.listen(options.port, options.host, () => {
        const startupToken = authToken ? sessionManager.createExchangeToken(10 * 60 * 1000) : null;
        const monitorUrl = startupToken
          ? `http://localhost:${options.port}/?exchange=${startupToken}`
          : `http://localhost:${options.port}/`;

        console.log(`\n======================================================`);
        console.log(`  🚀 WinHelm MCP Server is running!`);
        console.log(`======================================================`);
        console.log(`  - Web Monitor:     ${monitorUrl}`);
        if (startupToken) {
          console.log(`    (One-time login link valid for 10 minutes)`);
        }
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

    // 2. Close ephemeral session manager
    sessionManager.close();

    // 3. Close MCP Sessions
    await Promise.all([
      sseGateway.closeAll().catch(() => {}),
      streamableGateway.closeAll().catch(() => {}),
    ]);

    // 4. Close network sockets
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

  return { app, start, stop, sessionManager };
}
