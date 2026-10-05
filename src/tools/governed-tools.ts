import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inspectFileBatch } from "../engine/file-inspect.js";
import { toStructuredToolErrorResult } from "../errors/tool-error.js";
import { registerTracedTool } from "./tool-wrapper.js";

/**
 * Spec 3.4 Tier A governed primitives (adopted per capability group).
 * Every tool here passes through the accepted M1 authorization wrapper and
 * emits the frozen structured-error contract on failure.
 */
export function registerGovernedTools(server: McpServer): void {
  // A1 — Batch Inspection
  registerTracedTool(
    server,
    "file_inspect_batch",
    {
      paths: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe(
          "Absolute or relative paths to inspect in input order (maximum 100 per call)."
        ),
      sha256: z
        .boolean()
        .optional()
        .describe("Compute streaming SHA-256 for each file (default: true)."),
      consistency: z
        .enum(["best_effort", "deny_writers"])
        .optional()
        .describe(
          "Read consistency: best_effort re-stats around the read; deny_writers holds a native FILE_SHARE_READ handle (default: best_effort)."
        ),
      include: z
        .array(
          z.enum([
            "exists",
            "type",
            "bytes",
            "sha256",
            "mtime_utc",
            "creation_time_utc",
            "reparse_point",
            "reparse_tag",
            "readonly",
            "hidden",
          ])
        )
        .optional()
        .describe("Metadata fields to return; defaults to all fields."),
      fail_fast: z
        .boolean()
        .optional()
        .describe(
          "Fail the whole call when a path cannot be inspected instead of returning exists=false for it (default: false)."
        ),
    },
    async ({ paths, sha256, consistency, include, fail_fast }) => {
      try {
        const result = await inspectFileBatch({
          paths,
          sha256,
          consistency,
          include,
          fail_fast,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "FILE_INSPECT_FAILED");
      }
    }
  );
}
