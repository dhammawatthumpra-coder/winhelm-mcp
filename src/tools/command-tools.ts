import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CommandRunPolicyError,
  runCommandGoverned,
} from "../engine/command-runner.js";
import {
  getRunManager,
  RunNotFoundError,
  RunOwnershipError,
} from "../engine/run-manager.js";
import { validatePublicTimeoutMs } from "../engine/command-env.js";
import { approvalSessionKey } from "../approval/provenance.js";
import { registerTracedTool } from "./tool-wrapper.js";
import { SCHEMA_V2_TOOL_NAMES } from "./registry.js";
import { toStructuredToolErrorResult, createToolErrorResult } from "../errors/tool-error.js";
import { translate as t } from "../i18n/messages.js";

function commandErrorResult(err: unknown) {
  if (err instanceof RunNotFoundError) {
    return createToolErrorResult(
      "RUN_NOT_FOUND",
      err.message,
      "Check the run_id from the command_run result of this session."
    );
  }
  if (err instanceof RunOwnershipError) {
    return createToolErrorResult(
      "RUN_PERMISSION_DENIED",
      err.message,
      "command_wait only accepts run_id values launched by the current session."
    );
  }
  if (err instanceof CommandRunPolicyError) {
    return createToolErrorResult(err.code, err.message, t("action.command.allowed"));
  }
  return toStructuredToolErrorResult(err, "COMMAND_RUN_REJECTED", t("action.command.allowed"));
}

export function registerCommandTools(server: McpServer): void {
  registerTracedTool(
    server,
    SCHEMA_V2_TOOL_NAMES.COMMAND_RUN,
    {
      command: z
        .string()
        .min(1)
        .describe(
          "Executable/package-manager command. Safe mode permits only npm, pnpm, yarn, or bun."
        ),
      args: z
        .array(z.string())
        .default([])
        .describe("Argument vector passed directly without a shell."),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory. Required in Safe mode and must be a readwrite WinHelm folder."
        ),
      idempotencyKey: z
        .string()
        .optional()
        .describe(
          "Optional hint that binds this request to an existing WinHelm approval job after a dropped connection; it is not permission to re-run a side effect."
        ),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(600_000)
        .optional()
        .describe("Legacy v1.3 execution timeout in milliseconds (100..600000)."),
      timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(4_294_967_294)
        .optional()
        .describe(
          "Spec 3.4 execution timeout in milliseconds; 4294967295 and above are rejected because they collide with the internal infinite-wait sentinel."
        ),
      env_mode: z
        .enum(["sanitized", "inherit", "empty"])
        .optional()
        .describe(
          "Environment mode: sanitized (default) drops execution-semantic variables and provides the Trusted Sanitized PATH; inherit passes the exact host environment when authorized; empty starts truly empty."
        ),
      env: z
        .record(z.string())
        .optional()
        .describe(
          "Overlay environment applied after the mode policy; forbidden execution-semantic variables are rejected."
        ),
      async: z
        .boolean()
        .optional()
        .describe(
          "Launch without waiting and return a durable run_id for command_wait; the run continues across session disconnects (default: false)."
        ),
      max_capture_bytes: z
        .number()
        .int()
        .min(0)
        .max(134_217_728)
        .optional()
        .describe(
          "Memory capture limit per stream in bytes (default: 1048576); full-stream SHA-256 always covers the complete output. Values above the 128 MiB native ceiling are rejected, never clamped."
        ),
      stdout_file: z
        .string()
        .optional()
        .describe("Write the full stdout stream to this authorized file inside an allowed readwrite folder."),
      stdout_mode: z
        .enum(["create_new", "overwrite", "append"])
        .optional()
        .describe("stdout_file write mode (default: create_new)."),
      stderr_file: z
        .string()
        .optional()
        .describe("Write the full stderr stream to this authorized file inside an allowed readwrite folder."),
      stderr_mode: z
        .enum(["create_new", "overwrite", "append"])
        .optional()
        .describe("stderr_file write mode (default: create_new)."),
    },
    async (args, extra) => {
      try {
        const result = await runCommandGoverned({
          command: args.command,
          args: args.args,
          cwd: args.cwd,
          timeoutMs: args.timeoutMs,
          timeout_ms: args.timeout_ms,
          env_mode: args.env_mode,
          env: args.env,
          async: args.async,
          max_capture_bytes: args.max_capture_bytes,
          stdout_file: args.stdout_file,
          stdout_mode: args.stdout_mode,
          stderr_file: args.stderr_file,
          stderr_mode: args.stderr_mode,
          sessionId: approvalSessionKey(extra?.sessionId),
        });

        if (result.status === "running") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        return {
          isError:
            result.exit_code !== 0 ||
            result.timed_out,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return commandErrorResult(err);
      }
    }
  );

  registerTracedTool(
    server,
    "command_wait",
    {
      run_id: z
        .string()
        .min(1)
        .describe("Opaque durable run_id returned by command_run; must be owned by this session."),
      timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(4_294_967_294)
        .optional()
        .describe(
          "Maximum wait in milliseconds (default: 60000). A wait timeout returns still_running and NEVER cancels or kills the run; 4294967295 and above are rejected."
        ),
    },
    async ({ run_id, timeout_ms }, extra) => {
      try {
        const waitTimeoutMs = validatePublicTimeoutMs(timeout_ms ?? 60_000, {
          tool: "command_wait",
          field: "timeout_ms",
        });
        const manager = getRunManager();
        const sessionKey = approvalSessionKey(extra?.sessionId);
        // Ownership is enforced for live AND terminal records alike.
        const owned = manager.requireOwnedRun(run_id, sessionKey);
        const live = manager.getLive(run_id);

        if (!live) {
          const record = owned;
          const stored = manager.getStoredFinalResult(run_id);
          if (stored) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(stored, null, 2),
                },
              ],
            };
          }
          // Terminal record without retained capture (e.g. startup
          // reconciliation): report the honest terminal state, never replay.
          void record;
          const terminal = manager.getFinished(run_id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    run_id,
                    status: terminal?.state ?? "unknown",
                    started_at_utc: terminal?.started_at_utc,
                    ...(terminal?.ended_at_utc
                      ? { ended_at_utc: terminal.ended_at_utc }
                      : {}),
                    ...(terminal?.exit_code !== undefined
                      ? { exit_code: terminal.exit_code }
                      : {}),
                    timed_out: terminal?.timed_out ?? false,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const result = await manager.waitForRun(live, waitTimeoutMs);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return commandErrorResult(err);
      }
    }
  );
}
