/**
 * Spec 3.4 A4 — public environment policy and timeout-domain lock.
 *
 * The promoted native boundary provides the explicit Unicode environment
 * MECHANISM; this module is the POLICY layer required by the frozen Spec and
 * the accepted M1 model:
 * - terminal.mode=safe forces env_mode=sanitized (inherit is rejected);
 * - sanitized environments drop every execution-semantic variable from the
 *   normative set and equivalent dangerous overlays, plus server secrets,
 *   and provide the Trusted Sanitized PATH from the resolved executable;
 * - overlays can never reintroduce a forbidden variable in any mode;
 * - empty is actually empty.
 *
 * The public timeout domain is also locked here: 4294967295 is the internal
 * NB1 INFINITE sentinel and must never pass a public boundary.
 */
import path from "node:path";
import { StructuredToolError } from "../errors/tool-error.js";

export type EnvMode = "sanitized" | "inherit" | "empty";

/**
 * Execution-semantic variables that must never leak into a sanitized child.
 * The normative set (PATH, PATHEXT, PYTHONPATH, NODE_OPTIONS, COMSPEC,
 * LD_PRELOAD) plus equivalent dangerous overlays. Comparison is
 * case-insensitive on both platforms (Windows environment keys are
 * case-insensitive by OS identity).
 */
const FORBIDDEN_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "PYTHONPATH",
  "PYTHONHOME",
  "NODE_OPTIONS",
  "NODE_PATH",
  "COMSPEC",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "BASH_ENV",
  "ENV",
  "IFS",
  "CDPATH",
  "GEM_HOME",
  "GEM_PATH",
  "RUBYOPT",
  "PERL5LIB",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS",
  "CLASSPATH",
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_USERCONFIG",
]);

const SECRET_ENV_KEY_PATTERN = /^(MCP|WINHELM)_.*(TOKEN|SECRET|KEY|PASSWORD)/i;

export function isForbiddenEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  if (FORBIDDEN_ENV_KEYS.has(upper)) return true;
  return SECRET_ENV_KEY_PATTERN.test(name);
}

export interface GovernedEnvironmentRequest {
  envMode: EnvMode;
  overlay: Record<string, string> | undefined;
  resolvedExecutable: string;
  terminalMode: string;
}

export interface GovernedEnvironment {
  entries: Array<{ name: string; value: string }>;
  trustedSanitizedPath: string | null;
}

function rejectIllegalOverride(reason: string, details?: Record<string, unknown>): never {
  throw new StructuredToolError(
    "ILLEGAL_ENVIRONMENT_OVERRIDE",
    reason,
    "Use env_mode=sanitized and remove forbidden variables from the env overlay.",
    details
  );
}

/**
 * Build the explicit environment entries for one governed execution.
 */
export function buildGovernedEnvironment(
  request: GovernedEnvironmentRequest
): GovernedEnvironment {
  const { envMode, overlay, resolvedExecutable } = request;

  if (request.terminalMode === "safe" && envMode !== "sanitized") {
    rejectIllegalOverride(
      "Safe terminal mode permits only env_mode=sanitized for governed execution."
    );
  }

  if (overlay) {
    for (const name of Object.keys(overlay)) {
      if (isForbiddenEnvKey(name)) {
        rejectIllegalOverride(
          `The env overlay cannot reintroduce the forbidden variable "${name}".`,
          { forbiddenVariable: name }
        );
      }
    }
  }

  if (envMode === "empty") {
    const entries = overlay
      ? Object.entries(overlay).map(([name, value]) => ({ name, value }))
      : [];
    return { entries, trustedSanitizedPath: null };
  }

  // Host environments (especially MSYS/npm-spawned ones) can contain
  // case-variant duplicates; the Windows environment identity is
  // case-insensitive, so entries are merged by folded key (last wins).
  const mergeEntries = (
    base: Array<{ name: string; value: string }>,
    extra?: Record<string, string>
  ): Array<{ name: string; value: string }> => {
    const merged = new Map<string, { name: string; value: string }>();
    for (const entry of base) {
      merged.set(entry.name.toUpperCase(), entry);
    }
    if (extra) {
      for (const [name, value] of Object.entries(extra)) {
        const folded = name.toUpperCase();
        const existing = merged.get(folded);
        if (existing) existing.value = value;
        else merged.set(folded, { name, value });
      }
    }
    return [...merged.values()].map((entry) => ({ ...entry }));
  };

  if (envMode === "inherit") {
    // Exact host environment when authorized; overlays stay guarded above.
    const entries = Object.entries(process.env)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ name, value: value as string }));
    return {
      entries: mergeEntries(entries, overlay),
      trustedSanitizedPath: null,
    };
  }

  // sanitized: drop forbidden execution-semantic variables and secrets,
  // then provide the Trusted Sanitized PATH from the resolved executable.
  const trustedSanitizedPath = path.dirname(resolvedExecutable);
  const entries: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isForbiddenEnvKey(name)) continue;
    entries.push({ name, value });
  }
  entries.push({ name: "PATH", value: trustedSanitizedPath });

  return {
    entries: mergeEntries(entries, overlay),
    trustedSanitizedPath,
  };
}

/**
 * Public finite-timeout lock. 4294967295 is the NB1 internal INFINITE
 * sentinel; the public domain stops one below it.
 */
export const PUBLIC_TIMEOUT_MAX = 4_294_967_294;

export function validatePublicTimeoutMs(
  value: unknown,
  context: { tool: string; field: string }
): number {
  const label = `${context.tool}.${context.field}`;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new StructuredToolError(
      "TIMEOUT_INVALID",
      `${label} must be a finite number of milliseconds.`
    );
  }
  if (!Number.isFinite(value)) {
    throw new StructuredToolError(
      "TIMEOUT_INVALID",
      `${label} must be finite (received ${String(value)}).`
    );
  }
  if (!Number.isInteger(value)) {
    throw new StructuredToolError(
      "TIMEOUT_INVALID",
      `${label} must be an integer number of milliseconds.`
    );
  }
  if (value < 0) {
    throw new StructuredToolError(
      "TIMEOUT_INVALID",
      `${label} must be >= 0.`
    );
  }
  if (value > PUBLIC_TIMEOUT_MAX) {
    throw new StructuredToolError(
      "TIMEOUT_INVALID",
      `${label} must be <= ${PUBLIC_TIMEOUT_MAX} (4294967295 is the internal infinite-wait sentinel and is never a valid public timeout).`
    );
  }
  return value;
}
