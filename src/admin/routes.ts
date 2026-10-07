import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { ConfigManager } from "../config/config-manager.js";
import {
  applyApprovalMode,
  applyLegacyMigrationApplication,
  applyProfilePreset,
  getProfileStatus,
  previewApprovalModeApplication,
  previewLegacyMigrationApplication,
  previewProfileApplication,
  ProfileServiceError,
  type ApprovalModeApplyInput,
  type LegacyMigrationInput,
  type ProfileApplyInput,
} from "../config/profile-service.js";
import { getApprovalEngine, getCrossProcessApprovalSurface } from "../approval/runtime.js";
import type { CrossProcessRequestRecord } from "../approval/cross-process.js";
import { getProvenanceTracker } from "../approval/provenance.js";
import { auditLogger, hashSessionId } from "../utils/audit-logger.js";
import { sanitizeObject } from "../utils/sanitizer.js";
import {
  getDesktopDataDisclosure,
  getToolRiskPresentation,
} from "../permissions/risk.js";
import { getSessionClientInfo, listSessionClients } from "../gateway/session-context.js";
import { rotateAuthToken } from "../config/auth-token-rotation.js";
import { describeRequestFolderAccess } from "../permissions/tool-access.js";
import {
  adminMutationRequiresMandatoryConfirmation,
  isValidLocalConfirmation,
} from "../permissions/admin-confirmation.js";
import {
  applyClientConnection,
  previewClientConnection,
  ClientConnectionError,
  type SupportedMcpClient,
} from "../config/client-connect.js";
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
  message: string,
  details?: Record<string, unknown>
): Response {
  return res.status(status).json({
    error: details ? { code, message, details } : { code, message },
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

const APPROVAL_MODES = new Set(["manual", "smart", "trusted"]);

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

function parseApprovalModeBody(body: unknown): ApprovalModeApplyInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProfileServiceError(
      "INVALID_ARGUMENT",
      "Approval Mode request body must be an object."
    );
  }

  const raw = body as Record<string, unknown>;
  if (
    typeof raw.mode !== "string" ||
    !APPROVAL_MODES.has(raw.mode)
  ) {
    throw new ProfileServiceError(
      "INVALID_ARGUMENT",
      "mode must be one of manual, smart, trusted."
    );
  }

  return {
    mode: raw.mode as ApprovalModeApplyInput["mode"],
    ...(typeof raw.confirmation === "string"
      ? { confirmation: raw.confirmation }
      : {}),
  };
}

function parseMigrationBody(body: unknown): LegacyMigrationInput {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ProfileServiceError(
      "INVALID_ARGUMENT",
      "Migration request body must be an object."
    );
  }

  const raw = body as Record<string, unknown>;
  if (raw.folders === undefined) return {};
  if (!Array.isArray(raw.folders)) {
    throw new ProfileServiceError(
      "INVALID_ARGUMENT",
      "folders must be an array when provided."
    );
  }

  const folders = raw.folders.map((item, index) => {
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
      (typeof folder.alias !== "string" ||
        !folder.alias.trim())
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

  return { folders };
}

function profileErrorStatus(err: ProfileServiceError): number {
  if (err.code === "CONFIG_PERSIST_FAILED") return 500;
  if (
    err.code === "TYPED_CONFIRMATION_REQUIRED" ||
    err.code === "FOLDER_SELECTION_REQUIRED" ||
    err.code === "MIGRATION_NOT_AVAILABLE" ||
    err.code === "APPROVAL_MODE_REQUIRES_SCHEMA_V2"
  ) {
    return 409;
  }
  return 400;
}

function parseClientName(
  value: string | string[] | undefined
): SupportedMcpClient {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";
  if (normalized === "claude" || normalized === "cursor") {
    return normalized;
  }
  throw new ClientConnectionError(
    "INVALID_CLIENT",
    "client must be claude or cursor."
  );
}

function clientConnectionErrorStatus(
  err: ClientConnectionError
): number {
  if (
    err.code === "CLIENT_CONFIG_INVALID_JSON" ||
    err.code === "CLIENT_CONFIG_INVALID_MCP_SERVERS" ||
    err.code === "NODE_EXECUTABLE_NOT_FOUND" ||
    err.code === "WINHELM_ENTRYPOINT_NOT_FOUND" ||
    err.code === "CLAUDE_CONFIG_AMBIGUOUS" ||
    err.code === "CLAUDE_CONFIG_UNRESOLVED"
  ) {
    return 409;
  }
  if (err.code === "INVALID_CLIENT") return 400;
  return 500;
}

function clientConnectionErrorDetails(
  err: ClientConnectionError
): Record<string, unknown> | undefined {
  return err.candidates.length > 0
    ? { candidates: err.candidates }
    : undefined;
}

/**
 * Route an approval decision to a job owned by another WinHelm instance.
 * Returns true when the response was sent; false when no cross-process
 * surface is available (caller falls back to NOT_FOUND).
 */
async function decideCrossProcess(
  jobId: string,
  decision: "approved" | "denied",
  res: Response
): Promise<boolean> {
  const surface = getCrossProcessApprovalSurface();
  if (!surface) return false;
  const outcome = await surface.decideRemote(jobId, decision, "dashboard");
  if (outcome.kind === "applied") {
    res.json({ success: true, job: outcome.job, source: "remote" });
    return true;
  }
  if (outcome.kind === "pending") {
    res.json({ success: true, pending: true, jobId: outcome.jobId, source: "remote" });
    return true;
  }
  if (outcome.kind === "unavailable") {
    structuredError(
      res,
      503,
      outcome.code,
      "The shared approval journal could not be trusted; the decision was not recorded and the action was not run."
    );
    return true;
  }
  const message =
    outcome.code === "ALREADY_DECIDED"
      ? "This approval job was already decided."
      : outcome.code === "OWNER_UNAVAILABLE"
        ? "The WinHelm instance that owns this job is no longer running; the job cannot be executed and will expire."
        : "Approval job is no longer awaiting approval.";
  structuredError(res, 409, outcome.code, message);
  return true;
}

function adminApprovalView(job: any): Record<string, unknown> {
  return {
    id: job.id,
    state: job.state,
    tool: job.tool,
    args: sanitizeObject(job.args ?? {}),
    // 4.4: the approval dialog shows the folder and its permission for every
    // path argument, resolved by the same logic the policy gate enforces.
    folderAccess: describeRequestFolderAccess(
      job.tool,
      job.args ?? {},
      ConfigManager.getInstance().getConfig().folders
    ),
    sessionId: hashSessionId(job.sessionId),
    clientInfo: getSessionClientInfo(job.sessionId) ?? null,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    updatedAt: job.updatedAt,
    executionCount: job.executionCount,
    risk: getToolRiskPresentation(job.tool),
    dataDisclosure: getDesktopDataDisclosure(job.tool),
    provenance: getProvenanceTracker().getRecent(job.sessionId, 3),
  };
}

function foreignApprovalView(
  record: CrossProcessRequestRecord
): Record<string, unknown> {
  const job = record.job;
  const display = record.display ?? {};
  return {
    id: job.id,
    state: job.state,
    tool: job.tool,
    args: sanitizeObject(job.args ?? {}),
    // Computed by the owning process against its own permission config, so
    // the dialog reflects the folder semantics the policy gate will enforce.
    folderAccess: display.folderAccess ?? null,
    sessionId: hashSessionId(job.sessionId),
    clientInfo: display.clientInfo ?? null,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    updatedAt: job.updatedAt,
    executionCount: job.executionCount,
    risk: display.risk ?? getToolRiskPresentation(job.tool),
    dataDisclosure: display.dataDisclosure ?? getDesktopDataDisclosure(job.tool),
    provenance: display.provenance ?? null,
    source: "remote",
    ownerInstanceId: record.instanceId,
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

  router.post(
    "/auth/token/rotate",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    async (req: Request, res: Response) => {
      const manager = ConfigManager.getInstance();
      if (!manager.getRuntimeAuthToken()) {
        structuredError(
          res,
          409,
          "AUTH_TOKEN_NOT_CONFIGURED",
          "No MCP auth token is configured, so there is nothing to rotate. Set authToken or --auth first."
        );
        return;
      }
      if (
        adminMutationRequiresMandatoryConfirmation(
          "credential-security-mutation"
        ) &&
        !isValidLocalConfirmation(
          (req.body as Record<string, unknown> | undefined)?.confirmation
        )
      ) {
        structuredError(
          res,
          409,
          "MANDATORY_CONFIRMATION_REQUIRED",
          'Token rotation requires an explicit local confirmation ("confirm" or "ยืนยัน").'
        );
        return;
      }

      try {
        const rotated = await rotateAuthToken({ manager });
        auditLogger.log({
          event: "MCP_AUTH_TOKEN_ROTATED",
          severity: "WARN",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: "POST /admin/auth/token/rotate",
          resource: rotated.storePath,
          outcome: "ALLOWED",
          details: "Master MCP token replaced; previous token is invalid",
        });

        res.json({
          success: true,
          token: rotated.token,
          storePath: rotated.storePath,
        });
      } catch (err) {
        structuredError(
          res,
          500,
          "AUTH_TOKEN_ROTATION_FAILED",
          (err as Error).message || "Token rotation failed."
        );
      }
    }
  );

  router.get(
    "/sessions",
    requireAdminSession,
    (_req: Request, res: Response) => {
      const pendingBySession = new Map<string, number>();
      for (const job of getApprovalEngine().list()) {
        if (
          job.state === "awaiting_approval" ||
          job.state === "approved" ||
          job.state === "running"
        ) {
          pendingBySession.set(
            job.sessionId,
            (pendingBySession.get(job.sessionId) ?? 0) + 1
          );
        }
      }

      res.json({
        sessions: listSessionClients().map((session) => ({
          sessionId: hashSessionId(session.sessionId) ?? null,
          clientInfo: session.clientInfo,
          pendingApprovals: pendingBySession.get(session.sessionId) ?? 0,
        })),
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
    "/approval-mode/preview",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    (req: Request, res: Response) => {
      try {
        const input = parseApprovalModeBody(req.body);
        const preview = previewApprovalModeApplication(
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
          (err as Error).message || "Approval Mode preview failed."
        );
      }
    }
  );

  router.post(
    "/approval-mode/apply",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    async (req: Request, res: Response) => {
      const manager = ConfigManager.getInstance();
      const before = getProfileStatus(manager);

      try {
        const input = parseApprovalModeBody(req.body);
        const result = await applyApprovalMode(input, manager);

        auditLogger.log({
          event: "APPROVAL_MODE_APPLIED",
          severity:
            result.status.approvalMode === "trusted" ? "WARN" : "INFO",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: "POST /admin/approval-mode/apply",
          resource: result.status.approvalMode ?? "legacy",
          outcome: "ALLOWED",
          details: {
            channel: "dashboard",
            fromMode: before.approvalMode,
            fromBehavior: before.approvalBehavior,
            toMode: result.status.approvalMode,
            warnings: result.preview.warnings,
            backupCreated: Boolean(result.backupPath),
          },
        });

        res.json({
          success: true,
          backupPath: result.backupPath,
          preview: result.preview,
          profile: result.status,
        });
      } catch (err) {
        if (err instanceof ProfileServiceError) {
          auditLogger.log({
            event: "APPROVAL_MODE_APPLY_REJECTED",
            severity: "WARN",
            actor: {
              ip: req.ip,
              authType: "session_cookie",
              sessionId: res.locals.adminSessionId as string,
            },
            action: "POST /admin/approval-mode/apply",
            outcome: "DENIED",
            details: {
              code: err.code,
              fromMode: before.approvalMode,
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
          event: "APPROVAL_MODE_APPLY_ERROR",
          severity: "CRITICAL",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: "POST /admin/approval-mode/apply",
          outcome: "ERROR",
          details: (err as Error).message || String(err),
        });
        structuredError(
          res,
          500,
          "INTERNAL_ERROR",
          (err as Error).message || "Approval Mode apply failed."
        );
      }
    }
  );

  router.get(
    "/migration",
    requireAdminSession,
    (_req: Request, res: Response) => {
      try {
        const migration = previewLegacyMigrationApplication(
          {},
          ConfigManager.getInstance()
        );
        res.json({ migration });
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
          (err as Error).message || "Migration preview failed."
        );
      }
    }
  );

  router.post(
    "/migration/preview",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    (req: Request, res: Response) => {
      try {
        const input = parseMigrationBody(req.body);
        const migration = previewLegacyMigrationApplication(
          input,
          ConfigManager.getInstance()
        );
        res.json({ migration });
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
          (err as Error).message || "Migration preview failed."
        );
      }
    }
  );

  router.post(
    "/migration/apply",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    async (req: Request, res: Response) => {
      const manager = ConfigManager.getInstance();
      const before = getProfileStatus(manager);

      try {
        const input = parseMigrationBody(req.body);
        const previewBefore = previewLegacyMigrationApplication(
          input,
          manager
        );
        const result = await applyLegacyMigrationApplication(
          input,
          manager
        );

        auditLogger.log({
          event: "LEGACY_MIGRATION_APPLIED",
          severity: "WARN",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: "POST /admin/migration/apply",
          resource:
            previewBefore.sourceProfile ?? "legacy",
          outcome: "ALLOWED",
          details: {
            channel: "dashboard",
            from: {
              schemaMode: before.schemaMode,
            },
            to: {
              schemaMode: result.status.schemaMode,
              preset: result.status.preset,
              terminalMode: result.status.terminalMode,
              approvalMode: result.status.approvalMode,
              approvalBehavior: result.status.approvalBehavior,
              modified: result.status.modified,
            },
            folderCount: result.status.folders.length,
            warnings: previewBefore.warnings,
            backupCreated: Boolean(result.backupPath),
          },
        });

        res.json({
          success: true,
          backupPath: result.backupPath,
          migration: result.proposal,
          profile: result.status,
        });
      } catch (err) {
        if (err instanceof ProfileServiceError) {
          auditLogger.log({
            event: "LEGACY_MIGRATION_REJECTED",
            severity: "WARN",
            actor: {
              ip: req.ip,
              authType: "session_cookie",
              sessionId: res.locals.adminSessionId as string,
            },
            action: "POST /admin/migration/apply",
            outcome: "DENIED",
            details: {
              code: err.code,
              fromSchemaMode: before.schemaMode,
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
          event: "LEGACY_MIGRATION_ERROR",
          severity: "CRITICAL",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: "POST /admin/migration/apply",
          outcome: "ERROR",
          details: (err as Error).message || String(err),
        });
        structuredError(
          res,
          500,
          "INTERNAL_ERROR",
          (err as Error).message || "Migration apply failed."
        );
      }
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
            channel: "dashboard",
            from: {
              schemaMode: before.schemaMode,
              preset: before.preset,
              terminalMode: before.terminalMode,
              approvalMode: before.approvalMode,
              approvalBehavior: before.approvalBehavior,
              modified: before.modified,
            },
            to: {
              schemaMode: result.status.schemaMode,
              preset: result.status.preset,
              terminalMode: result.status.terminalMode,
              approvalMode: result.status.approvalMode,
              approvalBehavior: result.status.approvalBehavior,
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

  router.post(
    "/clients/:client/preview",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    async (req: Request, res: Response) => {
      try {
        const client = parseClientName(req.params.client);
        const manager = ConfigManager.getInstance();
        const preview = await previewClientConnection(
          client,
          manager.getConfigFilePath()
        );
        res.json({ preview });
      } catch (err) {
        if (err instanceof ClientConnectionError) {
          structuredError(
            res,
            clientConnectionErrorStatus(err),
            err.code,
            err.message,
            clientConnectionErrorDetails(err)
          );
          return;
        }
        structuredError(
          res,
          500,
          "INTERNAL_ERROR",
          (err as Error).message || "Client connection preview failed."
        );
      }
    }
  );

  router.post(
    "/clients/:client/apply",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    async (req: Request, res: Response) => {
      try {
        const client = parseClientName(req.params.client);
        const manager = ConfigManager.getInstance();
        const result = await applyClientConnection(
          client,
          manager.getConfigFilePath()
        );

        auditLogger.log({
          event: "MCP_CLIENT_CONFIG_APPLIED",
          severity: "INFO",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: `POST /admin/clients/${client}/apply`,
          resource: client,
          outcome: "ALLOWED",
          details: {
            changed: result.preview.changed,
            configFileExisted:
              result.preview.target.configFileExists,
            backupCreated: Boolean(result.backupPath),
          },
        });

        res.json({
          success: true,
          backupPath: result.backupPath,
          bytesWritten: result.bytesWritten,
          preview: result.preview,
        });
      } catch (err) {
        if (err instanceof ClientConnectionError) {
          auditLogger.log({
            event: "MCP_CLIENT_CONFIG_REJECTED",
            severity: "WARN",
            actor: {
              ip: req.ip,
              authType: "session_cookie",
              sessionId: res.locals.adminSessionId as string,
            },
            action: "POST /admin/clients/:client/apply",
            outcome: "DENIED",
            details: { code: err.code },
          });
          structuredError(
            res,
            clientConnectionErrorStatus(err),
            err.code,
            err.message
          );
          return;
        }

        auditLogger.log({
          event: "MCP_CLIENT_CONFIG_ERROR",
          severity: "CRITICAL",
          actor: {
            ip: req.ip,
            authType: "session_cookie",
            sessionId: res.locals.adminSessionId as string,
          },
          action: "POST /admin/clients/:client/apply",
          outcome: "ERROR",
          details: (err as Error).message || String(err),
        });
        structuredError(
          res,
          500,
          "INTERNAL_ERROR",
          (err as Error).message || "Client connection apply failed."
        );
      }
    }
  );

  // M3A Phase 1: read-only onboarding projection. Derives each supported
  // client's configuration status from the same preview semantics the apply
  // path uses; it never mutates client configuration and never exposes
  // config file contents.
  const CLIENT_STATUS_DISPLAY_NAMES: Record<SupportedMcpClient, string> = {
    claude: "Claude Desktop",
    cursor: "Cursor",
  };

  router.get(
    "/clients/status",
    requireAdminSession,
    async (_req: Request, res: Response) => {
      const manager = ConfigManager.getInstance();
      const clients: SupportedMcpClient[] = ["claude", "cursor"];
      const statuses = await Promise.all(
        clients.map(async (client) => {
          try {
            const preview = await previewClientConnection(
              client,
              manager.getConfigFilePath()
            );
            return {
              client,
              displayName: preview.target.displayName,
              status: preview.changed
                ? ("needs_configuration" as const)
                : ("configured" as const),
              configPath: preview.target.configPath,
              configFileExists: preview.target.configFileExists,
              warningCount: preview.warnings.length,
            };
          } catch (err) {
            if (err instanceof ClientConnectionError) {
              return {
                client,
                displayName: CLIENT_STATUS_DISPLAY_NAMES[client],
                status: "attention" as const,
                errorCode: err.code,
              };
            }
            return {
              client,
              displayName: CLIENT_STATUS_DISPLAY_NAMES[client],
              status: "attention" as const,
              errorCode: "INTERNAL_ERROR",
            };
          }
        })
      );
      res.json({ clients: statuses });
    }
  );

  router.get(
    "/approvals",
    requireAdminSession,
    (_req: Request, res: Response) => {
      const own = getApprovalEngine().list();
      const ownIds = new Set(own.map((job) => job.id));
      // DEF-02: pending jobs created by other WinHelm instances (stdio MCP
      // clients) are visible here with owner-computed display metadata.
      const foreign = (
        getCrossProcessApprovalSurface()?.listForeignRequests() ?? []
      )
        .filter((record) => !ownIds.has(record.job.id))
        .map(foreignApprovalView);
      res.json({
        jobs: [
          ...own.map(adminApprovalView),
          ...foreign,
        ].sort((a: any, b: any) => b.createdAt - a.createdAt),
      });
    }
  );

  router.post(
    "/approvals/:jobId/approve",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    async (req: Request, res: Response) => {
      const jobId = routeParam(req.params.jobId);
      if (!jobId) {
        structuredError(res, 400, "INVALID_ARGUMENT", "A valid jobId is required.");
        return;
      }
      const localOutcome = getApprovalEngine().approve(jobId, "dashboard");
      if (!localOutcome.ok) {
        if (localOutcome.code !== "NOT_FOUND") {
          structuredError(
            res,
            localOutcome.status,
            localOutcome.code,
            localOutcome.code === "JOURNAL_UNAVAILABLE"
              ? "The approval journal could not record this decision, so the action was not run."
              : "Approval job is no longer awaiting approval."
          );
          return;
        }
        // DEF-02: the job may belong to another WinHelm instance (stdio MCP
        // client). Record the decision; the owning process stays the only
        // executor and observes it through the shared coordination state.
        const remote = await decideCrossProcess(jobId, "approved", res);
        if (remote !== undefined) {
          return;
        }
        structuredError(res, 404, "NOT_FOUND", "Approval job not found.");
        return;
      }
      res.json({ success: true, job: localOutcome.job });
    }
  );

  router.post(
    "/approvals/:jobId/deny",
    requireMutationOrigin,
    requireAdminSession,
    requireCsrf,
    async (req: Request, res: Response) => {
      const jobId = routeParam(req.params.jobId);
      if (!jobId) {
        structuredError(res, 400, "INVALID_ARGUMENT", "A valid jobId is required.");
        return;
      }
      const localOutcome = getApprovalEngine().deny(jobId, "dashboard");
      if (!localOutcome.ok) {
        if (localOutcome.code !== "NOT_FOUND") {
          structuredError(
            res,
            localOutcome.status,
            localOutcome.code,
            "Approval job is no longer awaiting approval."
          );
          return;
        }
        const remote = await decideCrossProcess(jobId, "denied", res);
        if (remote !== undefined) {
          return;
        }
        structuredError(res, 404, "NOT_FOUND", "Approval job not found.");
        return;
      }
      res.json({ success: true, job: localOutcome.job });
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
