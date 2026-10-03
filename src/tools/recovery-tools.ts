import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getApprovalEngine } from "../approval/runtime.js";
import { formatApprovalJobStatus } from "../approval/tool-flow.js";
import { buildRuntimeStatusSnapshot } from "../status/runtime-status.js";
import { registerTracedTool } from "./tool-wrapper.js";
import { SCHEMA_V2_TOOL_NAMES } from "./registry.js";
import { translate as t } from "../i18n/messages.js";

function localSessionId(extra: any): string {
  return extra?.sessionId ?? `local-process-${process.pid}`;
}

export function registerRecoveryTools(server: McpServer): void {
  registerTracedTool(
    server,
    SCHEMA_V2_TOOL_NAMES.WINHELM_STATUS,
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(buildRuntimeStatusSnapshot(), null, 2),
        },
      ],
    })
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
