import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inspectFileBatch } from "../engine/file-inspect.js";
import {
  createFileExclusive,
  writeFileAtomic,
} from "../engine/atomic-file.js";
import {
  describeCurrentSession,
  lookupFileProvenanceStatus,
  searchCurrentSessionAudit,
} from "../engine/session-governance.js";
import { approvalSessionKey } from "../approval/provenance.js";
import { toStructuredToolErrorResult } from "../errors/tool-error.js";
import { registerTracedTool } from "./tool-wrapper.js";

const MUTATION_TEXT_FIELD_CONTRACT =
  "Text transforms apply to utf8/ascii content; base64 content is written verbatim after decoding.";

function fileTextFields() {
  return {
    encoding: z
      .enum(["utf8", "base64", "ascii"])
      .optional()
      .describe(`Content encoding (default: utf8). ${MUTATION_TEXT_FIELD_CONTRACT}`),
    newline: z
      .enum(["lf", "crlf", "preserve"])
      .optional()
      .describe(
        `Line-ending normalization for text content (default: lf). ${MUTATION_TEXT_FIELD_CONTRACT}`
      ),
    final_newline: z
      .boolean()
      .optional()
      .describe(
        `Ensure non-empty text content ends with a newline (default: true). ${MUTATION_TEXT_FIELD_CONTRACT}`
      ),
    bom: z
      .boolean()
      .optional()
      .describe(
        `Control the UTF-8 BOM on text content: false strips it, true prepends it (default: false). ${MUTATION_TEXT_FIELD_CONTRACT}`
      ),
    create_parents: z
      .boolean()
      .optional()
      .describe("Create the parent directory when it does not exist (default: false)."),
  } as const;
}

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

  // A2 — Mutation Integrity
  registerTracedTool(
    server,
    "file_write_atomic",
    {
      path: z.string().describe("Target file path inside an allowed readwrite folder."),
      content: z.string().describe("File content (text, or base64 when encoding is base64)."),
      ...fileTextFields(),
      expected_absent: z
        .boolean()
        .optional()
        .describe(
          "Safety precondition: the target must not exist; the commit then uses native CREATE_NEW so a racing external writer can never be overwritten (default: false)."
        ),
      expected_current_sha256: z
        .string()
        .optional()
        .describe(
          "Optimistic precondition checksum of the current target content; a mismatch cancels the write with PRECONDITION_FAILED/TARGET_CHANGED."
        ),
      flush: z
        .boolean()
        .optional()
        .describe(
          "Request FlushFileBuffers on the temporary file before the rename; the WinHelm native boundary always performs this flush (default: true)."
        ),
    },
    async (args, extra) => {
      try {
        const result = await writeFileAtomic(args, approvalSessionKey(extra?.sessionId));
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "FILE_MUTATION_FAILED");
      }
    }
  );

  registerTracedTool(
    server,
    "file_create_exclusive",
    {
      path: z.string().describe("Target file path inside an allowed readwrite folder."),
      content: z.string().describe("File content (text, or base64 when encoding is base64)."),
      ...fileTextFields(),
    },
    async (args, extra) => {
      try {
        const result = await createFileExclusive(
          args,
          approvalSessionKey(extra?.sessionId)
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "FILE_MUTATION_FAILED");
      }
    }
  );

  // A3 — Governance and Provenance
  registerTracedTool(
    server,
    "session_current",
    {
      // No inputs; the session identity comes from the transport context.
    },
    async (_args, extra) => {
      try {
        const result = describeCurrentSession(extra?.sessionId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "SESSION_CONTEXT_FAILED");
      }
    }
  );

  registerTracedTool(
    server,
    "session_audit_search",
    {
      path: z
        .string()
        .optional()
        .describe("Filter events to targets containing this filesystem path."),
      actions: z
        .array(z.enum(["create", "modify", "delete", "approve", "deny", "execute"]))
        .optional()
        .describe("Filter by action types."),
      since_utc: z
        .string()
        .optional()
        .describe("Inclusive ISO 8601 UTC lower time bound."),
      until_utc: z
        .string()
        .optional()
        .describe("Inclusive ISO 8601 UTC upper time bound."),
      limit: z
        .number()
        .int()
        .min(0)
        .max(500)
        .optional()
        .describe("Maximum events to return, newest first (default: 50)."),
    },
    async (args, extra) => {
      try {
        const result = searchCurrentSessionAudit(args, extra?.sessionId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "SESSION_AUDIT_SEARCH_FAILED");
      }
    }
  );

  registerTracedTool(
    server,
    "file_provenance_lookup",
    {
      path: z
        .string()
        .describe(
          "Target path whose WinHelm mutation attribution is requested; must be read-authorized."
        ),
      actions: z
        .array(z.enum(["create", "modify", "delete"]))
        .optional()
        .describe("Attribution actions of interest (default: all recorded actions)."),
      limit: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe("Maximum history entries to return, oldest first (default: 10)."),
    },
    async (args, extra) => {
      try {
        const result = await lookupFileProvenanceStatus(args, extra?.sessionId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "PROVENANCE_LOOKUP_FAILED");
      }
    }
  );
}
