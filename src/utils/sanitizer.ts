/**
 * Secret & Credential Redaction Utility for WinCommander
 * Automatically detects and masks sensitive keys, tokens, and credentials in logs and outputs.
 */

/**
 * Mask sensitive credentials within a text string
 */
export function sanitizeText(text: string): string {
  if (!text || typeof text !== "string") return text;

  return text
    // Bearer tokens
    .replace(/(bearer\s+)([a-zA-Z0-9_\-\.]{8,})/gi, (_m, p, s) => `${p}${"*".repeat(Math.min(s.length, 12))}`)
    // AWS Access Key ID (AKIA...)
    .replace(/\b(AKIA)([0-9A-Z]{16})\b/g, (_m, p, s) => `${p}${"*".repeat(Math.min(s.length, 12))}`)
    // API keys (sk-..., ghp_...)
    .replace(/(sk-[a-zA-Z0-9_\-]{4})([a-zA-Z0-9_\-]+)/gi, (_m, p) => `${p}${"*".repeat(12)}`)
    .replace(/(gh[pousr]_[a-zA-Z0-9]{4})([a-zA-Z0-9]+)/gi, (_m, p) => `${p}${"*".repeat(12)}`)
    // JSON quoted keys like "authToken": "...", "password": "...", "x-api-key": "..."
    .replace(
      /((\\")|["'])([\w\-]*?(?:token|password|passwd|secret|api[_-]?key|auth(?!(?:or|ors)\b))[\w\-]*?)\1(\s*:\s*)((\\")|["'])([^"'\r\n]+?)\5/gi,
      (_m, q1, _g2, k, colon, q2, _g5, v) => `${q1}${k}${q1}${colon}${q2}${"*".repeat(Math.min(v.length, 12))}${q2}`
    )
    // Query/unquoted fields like password=xyz, token=xyz
    .replace(/((?:token|api[_-]?key|secret|password|passwd|auth(?!(?:or|ors)\b))\s*[:=]\s*["']?)([^"'&\s]{4,})(["']?)/gi, (_m, p, s, suf) => `${p}${"*".repeat(Math.min(s.length, 12))}${suf}`)
    // CLI flags e.g. --auth xyz
    .replace(/(--(?:auth|token|password|secret)\s+)([^\s]{4,})/gi, (_m, p, s) => `${p}${"*".repeat(Math.min(s.length, 12))}`)
    // Basic Auth in URLs
    .replace(/(https?:\/\/[^:]+:)([^@]+)(@)/gi, (_m, p, _s, at) => `${p}********${at}`);
}

/**
 * Deep-sanitize objects, payloads, or argument maps
 */
export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return sanitizeText(obj) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as unknown as T;
  }

  if (typeof obj === "object") {
    const cleanObj: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("password") ||
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        (lowerKey.includes("auth") && !lowerKey.includes("author")) ||
        (lowerKey.includes("key") && !lowerKey.includes("keyboard"))
      ) {
        if (typeof val === "string") {
          cleanObj[key] = "************";
          continue;
        }
      }
      cleanObj[key] = sanitizeObject(val);
    }
    return cleanObj as T;
  }

  return obj;
}
