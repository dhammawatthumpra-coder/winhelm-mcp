/**
 * Sanitizes process environment before passing to child processes
 * to prevent leaking server secrets and master authentication tokens.
 */
export function getCleanChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const cleanEnv: Record<string, string> = {};

  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;

    const upper = key.toUpperCase();
    // Explicit server token variables
    if (upper === "MCP_AUTH_TOKEN" || upper === "AUTH_TOKEN" || upper === "WINHELM_AUTH_TOKEN") {
      continue;
    }

    // Generic MCP / WinHelm token or secret patterns
    if (/^(MCP|WINHELM)_.*(TOKEN|SECRET|KEY|PASSWORD)/i.test(key)) {
      continue;
    }

    cleanEnv[key] = val;
  }

  cleanEnv.PYTHONIOENCODING = "utf-8";

  if (overrides) {
    Object.assign(cleanEnv, overrides);
  }

  return cleanEnv;
}
