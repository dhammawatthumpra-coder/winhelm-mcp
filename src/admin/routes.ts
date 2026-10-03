import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { ConfigManager } from "../config/config-manager.js";
import { getApprovalEngine } from "../approval/runtime.js";
import { getAdminAuthManager } from "./runtime.js";
import {
  isLoopbackOrigin,
  validateAdminLocality,
} from "./loopback.js";

const ADMIN_COOKIE = "winhelm_admin_session";
const CSRF_HEADER = "x-winhelm-csrf";

function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  const match = raw.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}

function adminCookie(
  sessionId: string,
  maxAgeSeconds: number,
  secure: boolean
): string {
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearAdminCookie(): string {
  return [
    `${ADMIN_COOKIE}=`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; ");
}

function structuredError(
  res: Response,
  status: number,
  code: string,
  message: string
): Response {
  return res.status(status).json({
    error: { code, message },
  });
}

function routeParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireLocality(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const locality = validateAdminLocality(req);
  if (!locality.allowed) {
    structuredError(
      res,
      403,
      locality.code ?? "ADMIN_LOCALITY_REQUIRED",
      locality.reason ?? "Admin plane is local-only."
    );
    return;
  }
  next();
}

function requireMutationOrigin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.get("origin");
  const effectivePort =
    ConfigManager.getInstance().getRuntimeEffectivePort();

  if (!origin || !isLoopbackOrigin(origin, effectivePort)) {
    structuredError(
      res,
      403,
      "ADMIN_ORIGIN_BLOCKED",
      "Admin mutations require a same-port loopback Origin header."
    );
    return;
  }
  next();
}

function requireAdminSession(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const auth = getAdminAuthManager();
  const sessionId = cookieValue(req, ADMIN_COOKIE);

  if (!sessionId) {
    structuredError(
      res,
      401,
      "ADMIN_UNAUTHORIZED",
      "Admin session cookie is required."
    );
    return;
  }

  const session = auth.validateSession(sessionId);
  if (!session) {
    res.setHeader("Set-Cookie", clearAdminCookie());
    structuredError(
      res,
      401,
      "ADMIN_SESSION_EXPIRED",
      "Admin session is invalid or expired."
    );
    return;
  }

  const secure =
    req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    adminCookie(session.id, auth.idleTimeoutSeconds, secure)
  );
  res.locals.adminSessionId = session.id;
  next();
}

function requireCsrf(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const sessionId = res.locals.adminSessionId as string | undefined;
  const token = req.get(CSRF_HEADER);

  if (
    !sessionId ||
    !token ||
    !getAdminAuthManager().validateCsrf(sessionId, token)
  ) {
    structuredError(
      res,
      403,
      "ADMIN_CSRF_INVALID",
      "A valid admin CSRF token is required."
    );
    return;
  }

  next();
}

export function registerAdminRoutes(app: Express): void {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));
  router.use(requireLocality);

  router.post(
    "/auth/exchange",
    requireMutationOrigin,
    (req: Request, res: Response) => {
      const code = req.body?.code;
      if (typeof code !== "string" || !code) {
        structuredError(
          res,
          400,
          "INVALID_ARGUMENT",
          "Admin code is required."
        );
        return;
      }

      const auth = getAdminAuthManager();
      const session = auth.exchangeCode(code);
      if (!session) {
        structuredError(
          res,
          401,
          "ADMIN_CODE_INVALID",
          "Admin code is invalid, expired, or already used."
        );
        return;
      }

      const secure =
        req.secure || req.headers["x-forwarded-proto"] === "https";
      res.setHeader(
        "Set-Cookie",
        adminCookie(
          session.id,
          auth.idleTimeoutSeconds,
          secure
        )
      );
      res.json({
        success: true,
        csrfToken: session.csrfToken,
        idleExpiresInSeconds: auth.idleTimeoutSeconds,
        absoluteExpiresAt: session.absoluteExpiresAt,
      });
    }
  );

  router.get(
    "/status",
    requireAdminSession,
    (_req: Request, res: Response) => {
      const configManager = ConfigManager.getInstance();
      res.json({
        authenticated: true,
        schemaMode: configManager.getConfigMode(),
        pendingApprovals: getApprovalEngine()
          .list()
          .filter(
            (job) =>
              job.state === "awaiting_approval" ||
              job.state === "approved" ||
              job.state === "running"
          ).length,
      });
    }
  );

  router.get(
    "/approvals",
    requireAdminSession,
    (_req: Request, res: Response) => {
      res.json({
        jobs: getApprovalEngine().list(),
      });
    }
  );

  router.post(
    "/approvals/:jobId/approve",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    (req: Request, res: Response) => {
      const jobId = routeParam(req.params.jobId);
      if (!jobId) {
        structuredError(res, 400, "INVALID_ARGUMENT", "A valid jobId is required.");
        return;
      }
      const outcome = getApprovalEngine().approve(jobId);
      if (!outcome.ok) {
        structuredError(
          res,
          outcome.status,
          outcome.code,
          outcome.code === "NOT_FOUND"
            ? "Approval job not found."
            : "Approval job is no longer awaiting approval."
        );
        return;
      }
      res.json({ success: true, job: outcome.job });
    }
  );

  router.post(
    "/approvals/:jobId/deny",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    (req: Request, res: Response) => {
      const jobId = routeParam(req.params.jobId);
      if (!jobId) {
        structuredError(res, 400, "INVALID_ARGUMENT", "A valid jobId is required.");
        return;
      }
      const outcome = getApprovalEngine().deny(jobId);
      if (!outcome.ok) {
        structuredError(
          res,
          outcome.status,
          outcome.code,
          outcome.code === "NOT_FOUND"
            ? "Approval job not found."
            : "Approval job is no longer awaiting approval."
        );
        return;
      }
      res.json({ success: true, job: outcome.job });
    }
  );

  router.post(
    "/auth/logout",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    (_req: Request, res: Response) => {
      const sessionId = res.locals.adminSessionId as string;
      getAdminAuthManager().revokeSession(sessionId);
      res.setHeader("Set-Cookie", clearAdminCookie());
      res.json({ success: true });
    }
  );

  // Never fall through to the MCP Bearer/session middleware. Unknown admin
  // routes remain inside the isolated admin security plane.
  router.use((_req: Request, res: Response) => {
    structuredError(
      res,
      404,
      "NOT_FOUND",
      "Admin endpoint not found."
    );
  });

  app.use("/admin", router);
}
