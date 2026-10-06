/**
 * Spec 3.4 Tier B / Phase 2 public primitives (6 tools):
 * deterministic JSON, resource monitoring, and structured Git.
 *
 * Every tool passes through the accepted M1 authorization wrapper
 * (registerTracedTool) and emits the frozen structured-error contract.
 */
import { z } from "zod";
import fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  canonicalizeText,
  canonicalizeValue,
  type CanonicalScheme,
} from "../engine/canonical-json.js";
import { parseStrictJsonText } from "../engine/json-strict.js";
import {
  readSystemMemoryInfo,
  monitorGovernedRun,
  resourceMonitorErrorResult,
} from "../engine/resource-monitor.js";
import {
  readGitStatusStructured,
  readGitDiffStructured,
} from "../engine/git-structured.js";
import { approvalSessionKey } from "../approval/provenance.js";
import { resolveRequestPath } from "../permissions/request-paths.js";
import { ConfigManager } from "../config/config-manager.js";
import {
  StructuredToolError,
  createToolErrorResult,
  toStructuredToolErrorResult,
} from "../errors/tool-error.js";
import { registerTracedTool } from "./tool-wrapper.js";

const SOURCE_FIELD_CONTRACT =
  "Exactly one of path (read-authorized file), text (raw JSON string), or value (already-parsed JSON value).";

const jsonSourceSchema = z
  .object({
    path: z
      .string()
      .optional()
      .describe("Read the JSON source from this read-authorized file."),
    text: z
      .string()
      .optional()
      .describe("Use this raw JSON text as the source."),
    value: z
      .unknown()
      .optional()
      .describe(
        "Use this already-parsed JSON value as the source (no raw duplicate-key detection is possible at this layer)."
      ),
  })
  .describe(`JSON source selector. ${SOURCE_FIELD_CONTRACT}`);

/**
 * Re-resolve a caller path with the same resolver the authorization gate
 * used, so the path the tool executes with is exactly the authorized path.
 */
function requireResolvedAuthorizedPath(
  rawPath: string
): string {
  const config = ConfigManager.getInstance().getConfig() as unknown as {
    folders?: Parameters<typeof resolveRequestPath>[1];
  };
  const resolution = resolveRequestPath(rawPath, config.folders);
  if (!resolution.ok) {
    throw new StructuredToolError(
      resolution.code,
      resolution.reason,
      resolution.code === "AMBIGUOUS_PATH"
        ? "Disambiguate the path with a full path or an @alias prefix."
        : "Use a path inside a configured allowed folder."
    );
  }
  return resolution.path;
}

function invalidSourceError(): never {
  throw new StructuredToolError(
    "INVALID_SOURCE",
    "source must contain exactly one of path, text, or value.",
    "Provide exactly one JSON source field."
  );
}

export function registerTierBTools(server: McpServer): void {
  // B1 — Strict JSON parsing
  registerTracedTool(
    server,
    "json_parse_strict",
    {
      source: jsonSourceSchema,
    },
    async (args) => {
      try {
        const source = (args as { source?: { path?: string; text?: string; value?: unknown } })
          .source;
        if (!source || typeof source !== "object") invalidSourceError();
        const provided =
          (source.path !== undefined ? 1 : 0) +
          (source.text !== undefined ? 1 : 0) +
          (source.value !== undefined ? 1 : 0);
        if (provided !== 1) invalidSourceError();

        let text: string;
        let bytes: number;
        if (source.text !== undefined) {
          text = source.text;
          bytes = Buffer.byteLength(text, "utf8");
        } else if (source.path !== undefined) {
          const resolved = requireResolvedAuthorizedPath(source.path);
          const buffer = await fs.readFile(resolved);
          bytes = buffer.byteLength;
          text = buffer.toString("utf8");
        } else {
          invalidSourceError();
        }

        const parsed = parseStrictJsonText(text);
        const result = {
          valid: true as const,
          bytes,
          depth: parsed.stats.depth,
          keys: parsed.stats.keys,
          nodes: {
            objects: parsed.stats.objects,
            arrays: parsed.stats.arrays,
            strings: parsed.stats.strings,
            integers: parsed.stats.integers,
            floats: parsed.stats.floats,
            booleans: parsed.stats.booleans,
            nulls: parsed.stats.nulls,
          },
          duplicate_keys: [] as string[],
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (
          err instanceof Error &&
          err.name === "JsonStrictParseError"
        ) {
          const parseErr = err as Error & {
            reason: string;
            pointer: string;
            line: number;
            column: number;
          };
          return createToolErrorResult(
            "CANONICAL_JSON_ERROR",
            err.message,
            "Check the JSON source against RFC 8259.",
            {
              reason: parseErr.reason,
              pointer: parseErr.pointer,
              line: parseErr.line,
              column: parseErr.column,
            }
          );
        }
        return toStructuredToolErrorResult(err, "JSON_PARSE_FAILED");
      }
    }
  );

  // B2 — Deterministic canonical JSON hashing
  registerTracedTool(
    server,
    "json_canonical_hash",
    {
      source: jsonSourceSchema,
      scheme: z
        .enum(["jcs-rfc8785", "python-sorted-json-v1"])
        .describe(
          "Canonicalization scheme: jcs-rfc8785 (RFC 8785) or the CPython-pinned python-sorted-json-v1 byte contract."
        ),
      exclude_paths: z
        .array(z.string())
        .optional()
        .describe(
          "JSON Pointers (or top-level keys) removed before hashing; invalid or non-resolving exclusions are rejected, never silently ignored."
        ),
    },
    async (args) => {
      try {
        const { source, scheme, exclude_paths } = args as {
          source?: { path?: string; text?: string; value?: unknown };
          scheme: CanonicalScheme;
          exclude_paths?: string[];
        };
        if (!source || typeof source !== "object") invalidSourceError();
        const provided =
          (source.path !== undefined ? 1 : 0) +
          (source.text !== undefined ? 1 : 0) +
          (source.value !== undefined ? 1 : 0);
        if (provided !== 1) invalidSourceError();

        const excludePaths = exclude_paths ?? [];
        let result;
        if (source.text !== undefined) {
          result = canonicalizeText(source.text, scheme, excludePaths);
        } else if (source.path !== undefined) {
          const resolved = requireResolvedAuthorizedPath(source.path);
          const text = await fs.readFile(resolved, "utf8");
          result = canonicalizeText(text, scheme, excludePaths);
        } else {
          result = canonicalizeValue(source.value, scheme, excludePaths);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "JSON_CANONICAL_FAILED");
      }
    }
  );

  // B3 — Global memory information (native GlobalMemoryStatusEx)
  registerTracedTool(
    server,
    "memory_info",
    {
      // No inputs; the native boundary reads host counters directly.
    },
    async () => {
      try {
        const result = readSystemMemoryInfo();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "MEMORY_INFO_FAILED");
      }
    }
  );

  // B4 — Governed run resource monitor (Job Object, non-cancelling)
  registerTracedTool(
    server,
    "process_resource_monitor",
    {
      run_id: z
        .string()
        .min(1)
        .describe(
          "Opaque durable run_id returned by command_run; must be owned by the current session."
        ),
    },
    async ({ run_id }, extra) => {
      try {
        const sessionKey = approvalSessionKey(extra?.sessionId);
        const result = monitorGovernedRun(run_id, sessionKey);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const mapped = resourceMonitorErrorResult(err);
        return createToolErrorResult(
          mapped.code,
          mapped.message,
          mapped.userAction
        );
      }
    }
  );

  // B5 — Structured Git status
  registerTracedTool(
    server,
    "git_status_structured",
    {
      repo_path: z
        .string()
        .min(1)
        .describe(
          "Repository or work-tree path inside an allowed read root; the resolved work-tree toplevel must stay inside the authorized boundary."
        ),
    },
    async ({ repo_path }) => {
      try {
        const result = await readGitStatusStructured(repo_path);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "GIT_STATUS_FAILED");
      }
    }
  );

  // B6 — Structured Git diff
  registerTracedTool(
    server,
    "git_diff_structured",
    {
      repo_path: z
        .string()
        .min(1)
        .describe(
          "Repository or work-tree path inside an allowed read root; the resolved work-tree toplevel must stay inside the authorized boundary."
        ),
      scope: z
        .enum(["unstaged", "staged"])
        .optional()
        .describe(
          "Diff scope: unstaged (work tree vs index, default) or staged (index vs HEAD)."
        ),
      include_patch: z
        .boolean()
        .optional()
        .describe(
          "Include bounded per-file chunks and lines (default: true)."
        ),
      max_patch_lines: z
        .number()
        .int()
        .min(1)
        .max(2_000)
        .optional()
        .describe(
          "Maximum chunk content lines across the whole patch (default: 200); exceeding it marks the patch truncated instead of failing."
        ),
    },
    async (args) => {
      try {
        const result = await readGitDiffStructured(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toStructuredToolErrorResult(err, "GIT_DIFF_FAILED");
      }
    }
  );
}
