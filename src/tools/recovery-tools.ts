import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigManager } from "../config/config-manager.js";
import { getApprovalEngine } from "../approval/runtime.js";
import { formatApprovalJobStatus } from "../approval/tool-flow.js";
import { getPackageVersion } from "../utils/version.js";
import { registerTracedTool } from "./tool-wrapper.js";
import { SCHEMA_V2_TOOL_NAMES } from "./registry.js";
import { translate as t } from "../i18n/messages.js";

function policySummary(policy: Record<string, unknown> | undefined): {
  auto: number;
  ask: number;
  off: number;
  unknown: number;
} {
  const summary = { auto: 0, ask: 0, off: 0, unknown: 0 };
  for (const value of Object.values(policy ?? {})) {
    if (value === "auto") summary.auto += 1;
    else if (value === "ask") summary.ask += 1;
    else if (value === "off") summary.off += 1;
    else summary.unknown += 1;
  }
  return summary;
}

function localSessionId(extra: any): string {
  return extra?.sessionId ?? `local-process-${process.pid}`;
}

export function registerRecoveryTools(server: McpServer): void {
  registerTracedTool(
    server,
    SCHEMA_V2_TOOL_NAMES.WINHELM_STATUS,
    {},
    async () => {
      const manager = ConfigManager.getInstance();
      const config = manager.getConfig();
      const mode = manager.getConfigMode();
      const jobs = getApprovalEngine().list();
      const pendingJobs = jobs.filter(
        (job) =>
          job.state === "awaiting_approval" ||
          job.state === "approved" ||
          job.state === "running"
      ).length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                version: getPackageVersion(),
                schemaMode: mode,
                profilePreset: config.profilePreset ?? null,
                folders: (config.folders ?? []).map((folder) => ({
                  path: folder.path,
                  alias: folder.alias ?? null,
                  permission: folder.permission,
                })),
                terminalMode: config.terminal?.mode ?? null,
                toolPolicySummary: policySummary(config.toolPolicy),
                approval: {
                  blockHoldMs: config.approval?.blockHoldMs ?? null,
                  jobTtlMs: config.approval?.jobTtlMs ?? null,
                  maxPending: config.approval?.maxPending ?? null,
                  pendingJobs,
                },
                config: {
                  valid: mode !== "invalid",
                  validationErrors: [...manager.getConfigValidationErrors()],
                  userAction:
                    mode === "invalid"
                      ? t("action.config.repair")
                      : null,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  registerTracedTool(
    server,
    SCHEMA_V2_TOOL_NAMES.WINHELM_JOB_STATUS,
    {
      jobId: z.string().optional().describe("Approval job ID returned by WinHelm"),
      idempotencyKey: z
        .string()
        .optional()
        .describe("Optional client idempotency key used by the original action"),
    },
    async ({ jobId, idempotencyKey }, extra) => {
      if (!jobId && !idempotencyKey) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "INVALID_ARGUMENT",
                  message: "Provide jobId or idempotencyKey.",
                  userAction: t("action.job.check_id"),
                },
              }),
            },
          ],
        };
      }

      const engine = getApprovalEngine();
      const sessionId = localSessionId(extra);
      const job = jobId
        ? engine.getForSession(jobId, sessionId)
        : engine.findForSessionByIdempotencyKey(idempotencyKey!, sessionId);

      return formatApprovalJobStatus(job);
    }
  );
}
