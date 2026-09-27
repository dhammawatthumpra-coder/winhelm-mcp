import type { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config/config-manager.js";

interface ClientRecord {
  count: number;
  resetTime: number;
}

export class RateLimiter {
  private clients = new Map<string, ClientRecord>();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    // Prune stale records every minute
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.clients.entries()) {
        if (now > record.resetTime) {
          this.clients.delete(key);
        }
      }
    }, 60000);
    this.cleanupTimer.unref();
  }

  public middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Exclude internal monitor & health endpoints from rate limiting
      if (
        req.path === "/health" ||
        req.path === "/" ||
        req.path === "/dashboard" ||
        req.path.startsWith("/api/monitor")
      ) {
        return next();
      }

      const config = ConfigManager.getInstance().getConfig();
      const limit = config.rateLimitPerMinute || 120;
      const key = req.ip || req.socket.remoteAddress || "global";
      const now = Date.now();

      let record = this.clients.get(key);
      if (!record || now > record.resetTime) {
        record = { count: 1, resetTime: now + 60000 };
        this.clients.set(key, record);
        return next();
      }

      record.count++;
      if (record.count > limit) {
        logger.security(`Rate limit exceeded (${record.count}/${limit} req/min)`, `IP: ${key}`);
        res.status(429).json({
          error: "Too Many Requests",
          message: `Rate limit of ${limit} requests per minute exceeded. Please slow down.`,
          retryAfterSeconds: Math.ceil((record.resetTime - now) / 1000),
        });
        return;
      }

      next();
    };
  }
}
