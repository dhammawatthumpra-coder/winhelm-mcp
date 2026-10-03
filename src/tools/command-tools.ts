import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runCommandNoShell } from "../engine/command-runner.js";
import { registerTracedTool } from "./tool-wrapper.js";
import { SCHEMA_V2_TOOL_NAMES } from "./registry.js";
import { translate as t } from "../i18n/messages.js";

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
        .describe("Execution timeout in milliseconds."),
    },
    async ({ command, args, cwd, timeoutMs }, extra) => {
      try {
        const result = await runCommandNoShell({
          command,
          args,
          cwd,
          timeoutMs,
          signal: extra?.signal,
        });

        return {
          isError: result.exitCode !== 0 || result.timedOut || result.aborted,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  durationMs: result.durationMs,
                  timedOut: result.timedOut,
                  aborted: result.aborted,
                  command: result.command,
                  resolvedExecutable: result.resolvedExecutable,
                  cwd: result.cwd,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "COMMAND_RUN_REJECTED",
                  message: (err as Error).message || String(err),
                  userAction: t("action.command.allowed"),
                },
              }),
            },
          ],
        };
      }
    }
  );
}
