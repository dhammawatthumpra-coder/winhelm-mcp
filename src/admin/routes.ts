import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { ConfigManager } from "../config/config-manager.js";
import {
  applyProfilePreset,
  getProfileStatus,
  previewProfileApplication,
  ProfileServiceError,
  type ProfileApplyInput,
} from "../config/profile-service.js";
import { getApprovalEngine } from "../approval/runtime.js";
import { auditLogger, hashSessionId } from "../utils/audit-logger.js";
import { sanitizeObject } from "../utils/sanitizer.js";
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

const PROFILE_PRESETS = new Set([
  "safe",
  "balanced",
  "power",
  "minimal",
  "core",
  "dev",
  "sysadmin",
  "full",
]);

function parseProfileBody(body: unknown): ProfileApplyInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProfileServiceError(
      "INVALID_ARGUMENT",
      "Profile request body must be an object."
    );
  }

  const raw = body as Record<string, unknown>;
  if (
    typeof raw.preset !== "string" ||
    !PROFILE_PRESETS.has(raw.preset)
  ) {
    throw new ProfileServiceError(
      "INVALID_ARGUMENT",
      "preset must be one of safe, balanced, power, minimal, core, dev, sysadmin, full."
    );
  }

  let folders: ProfileApplyInput["folders"];
  if (raw.folders !== undefined) {
    if (!Array.isArray(raw.folders)) {
      throw new ProfileServiceError(
        "INVALID_ARGUMENT",
        "folders must be an array when provided."
      );
    }

    folders = raw.folders.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new ProfileServiceError(
          "INVALID_ARGUMENT",
          `folders[${index}] must be an object.`
        );
      }
      const folder = item as Record<string, unknown>;
      if (typeof folder.path !== "string" || !folder.path.trim()) {
        throw new ProfileServiceError(
          "INVALID_ARGUMENT",
          `folders[${index}].path must be a non-empty string.`
        );
      }
      if (
        folder.alias !== undefined &&
        (typeof folder.alias !== "string" || !folder.alias.trim())
      ) {
        throw new ProfileServiceError(
          "INVALID_ARGUMENT",
          `folders[${index}].alias must be a non-empty string when provided.`
        );
      }

      return {
        path: folder.path,
        ...(typeof folder.alias === "string"
          ? { alias: folder.alias }
          : {}),
      };
    });
  }

  return {
    preset: raw.preset as ProfileApplyInput["preset"],
    ...(folders ? { folders } : {}),
    ...(typeof raw.confirmation === "string"
      ? { confirmation: raw.confirmation }
      : {}),
  };
}

function profileErrorStatus(err: ProfileServiceError): number {
  if (err.code === "CONFIG_PERSIST_FAILED") return 500;
  if (
    err.code === "TYPED_CONFIRMATION_REQUIRED" ||
    err.code === "FOLDER_SELECTION_REQUIRED"
  ) {
    return 409;
  }
  return 400;
}

function adminApprovalView(job: any): Record<string, unknown> {
  return {
    id: job.id,
    state: job.state,
    tool: job.tool,
    args: sanitizeObject(job.args ?? {}),
    sessionId: hashSessionId(job.sessionId),
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    updatedAt: job.updatedAt,
    executionCount: job.executionCount,
  };
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
    "/profile",
    requireAdminSession,
    (_req: Request, res: Response) => {
      const manager = ConfigManager.getInstance();
      const config = manager.getConfig();
      res.json({
        profile: getProfileStatus(manager),
        legacy:
          manager.getConfigMode() === "legacy"
            ? {
                profile: config.profile ?? "full",
                allowedDirectories: [...(config.allowedDirectories ?? [])],
                readOnly: Boolean(config.readOnly),
              }
            : null,
      });
    }
  );

  router.post(
    "/profiles/preview",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    (req: Request, res: Response) => {
      try {
        const input = parseProfileBody(req.body);
        const preview = previewProfileApplication(
          input,
          ConfigManager.getInstance()
        );
        res.json({ preview });
      } catch (err) {
        if (err instanceof ProfileServiceError) {
          structuredError(
            res,
            profileErrorStatus(err),
            err.code,
            err.message
          );
          return;
        }
        structuredError(
          res,
          500,
          "INTERNAL_ERROR",
          (err as Error).message || "Profile preview failed."
        );
      }
    }
  );

  router.post(
    "/profiles/apply",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    async (req: Request, res: Response) => {
      const manager = ConfigManager.getInstance();
      const before = getProfileStatus(manager);

      try {
        const input = parseProfileBody(req.body);
        const previewBefore = previewProfileApplication(input, manager);
        const result = await applyProfilePreset(input, manager);

        auditLogger.log({
          event: "PROFILE_PRESET_APPLIED",
          severity:
            result.status.terminalMode === "full" ? "WARN" : "INFO",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: "POST /admin/profiles/apply",
          resource: input.preset,
          outcome: "ALLOWED",
          details: {
            from: {
              schemaMode: before.schemaMode,
              preset: before.preset,
              terminalMode: before.terminalMode,
              modified: before.modified,
            },
            to: {
              schemaMode: result.status.schemaMode,
              preset: result.status.preset,
              terminalMode: result.status.terminalMode,
              modified: result.status.modified,
            },
            changedFields: previewBefore.changedFields,
            backupCreated: Boolean(result.backupPath),
          },
        });

        res.json({
          success: true,
          backupPath: result.backupPath,
          profile: result.status,
        });
      } catch (err) {
        if (err instanceof ProfileServiceError) {
          auditLogger.log({
            event: "PROFILE_PRESET_APPLY_REJECTED",
            severity: "WARN",
            actor: {
              ip: req.ip,
              authType: "session_cookie",
              sessionId: res.locals.adminSessionId as string,
            },
            action: "POST /admin/profiles/apply",
            outcome: "DENIED",
            details: {
              code: err.code,
              fromPreset: before.preset,
            },
          });
          structuredError(
            res,
            profileErrorStatus(err),
            err.code,
            err.message
          );
          return;
        }

        auditLogger.log({
          event: "PROFILE_PRESET_APPLY_ERROR",
          severity: "CRITICAL",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: "POST /admin/profiles/apply",
          outcome: "ERROR",
          details: (err as Error).message || String(err),
        });
        structuredError(
          res,
          500,
          "INTERNAL_ERROR",
          (err as Error).message || "Profile apply failed."
        );
      }
    }
  );

  router.get(
    "/approvals",
    requireAdminSession,
    (_req: Request, res: Response) => {
      res.json({
        jobs: getApprovalEngine().list().map(adminApprovalView),
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
