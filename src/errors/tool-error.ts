export interface ToolErrorPayload {
  code: string;
  message: string;
  userAction?: string;
  details?: Record<string, unknown>;
}

export interface ToolErrorResult {
  isError: true;
  content: Array<{
    type: "text";
    text: string;
  }>;
}

export function createToolErrorResult(
  code: string,
  message: string,
  userAction?: string,
  details?: Record<string, unknown>
): ToolErrorResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code,
            message,
            ...(userAction ? { userAction } : {}),
            ...(details ? { details } : {}),
          },
        }),
      },
    ],
  };
}

/**
 * Normalized in-process error for the Spec 3.4 structured-error contract
 * (`code`/`message`/`userAction`/`details`). Tool handlers throw this and
 * convert it with structuredErrorResult() so the public result always carries
 * the exact frozen error code.
 */
export class StructuredToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly userAction?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "StructuredToolError";
  }
}

export function structuredErrorResult(err: StructuredToolError): ToolErrorResult {
  return createToolErrorResult(err.code, err.message, err.userAction, err.details);
}

export function toStructuredToolErrorResult(
  err: unknown,
  fallbackCode: string,
  fallbackUserAction?: string
): ToolErrorResult {
  if (err instanceof StructuredToolError) return structuredErrorResult(err);
  const message = err instanceof Error ? err.message : String(err);
  return createToolErrorResult(fallbackCode, message, fallbackUserAction);
}

/**
 * Native addon errors arrive as Error objects carrying `code`/`nativeCode`.
 * Map them onto the structured contract without weakening the stable code.
 */
export function fromNativeError(
  err: unknown,
  fallbackCode: string,
  fallbackUserAction?: string
): StructuredToolError {
  if (err instanceof StructuredToolError) return err;
  const native = err as { code?: unknown; nativeCode?: unknown; message?: unknown };
  const message =
    typeof native?.message === "string" && native.message
      ? native.message
      : String(err);
  if (typeof native?.code === "string" && native.code.trim()) {
    return new StructuredToolError(
      native.code,
      message,
      fallbackUserAction,
      typeof native?.nativeCode === "number"
        ? { nativeCode: native.nativeCode }
        : undefined
    );
  }
  return new StructuredToolError(fallbackCode, message, fallbackUserAction);
}

export function parseToolErrorPayload(
  result: unknown
): ToolErrorPayload | undefined {
  if (!result || typeof result !== "object") return undefined;
  const value = result as any;
  if (value.isError !== true || !Array.isArray(value.content)) {
    return undefined;
  }

  const first = value.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(first.text);
    const error = parsed?.error;
    if (
      error &&
      typeof error === "object" &&
      typeof error.code === "string" &&
      error.code.trim() &&
      typeof error.message === "string"
    ) {
      return {
        code: error.code,
        message: error.message,
        ...(typeof error.userAction === "string" && error.userAction
          ? { userAction: error.userAction }
          : {}),
        ...(error.details &&
        typeof error.details === "object" &&
        !Array.isArray(error.details)
          ? { details: error.details as Record<string, unknown> }
          : {}),
      };
    }
  } catch {
    // Legacy/plain text error; caller may normalize it for schema-v2 only.
  }

  return undefined;
}

export function normalizeSchemaV2ToolErrorResult(
  result: any,
  fallbackCode = "TOOL_EXECUTION_FAILED",
  fallbackUserAction?: string
): any {
  if (!result?.isError) return result;

  // Preserve an existing structured error contract verbatim.
  if (parseToolErrorPayload(result)) return result;

  const first = Array.isArray(result.content)
    ? result.content.find(
        (item: any) =>
          item?.type === "text" && typeof item.text === "string"
      )
    : undefined;
  const message =
    first?.text?.trim() || "The WinHelm tool reported an error.";

  return createToolErrorResult(
    fallbackCode,
    message,
    fallbackUserAction
  );
}

export function extractPrefixedErrorCode(
  message: string | undefined
): { code: string; message: string } | undefined {
  if (!message) return undefined;
  const match = message.match(/^([A-Z][A-Z0-9_]{2,}):\s*(.+)$/s);
  if (!match) return undefined;
  return {
    code: match[1],
    message: match[2].trim(),
  };
}
