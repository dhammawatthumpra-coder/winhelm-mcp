export const AI_NOTIFICATION_PREFIX = "AI message:";
const TITLE_LIMIT = 100;
const MESSAGE_LIMIT = 500;

function stripControlCharacters(value: string): string {
  const normalized = value.normalize("NFKC");
  let output = "";
  let pendingSpace = false;

  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    const isControl =
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f);
    const isWhitespace = char.trim() === "";

    if (isControl || isWhitespace) {
      if (output.length > 0) pendingSpace = true;
      continue;
    }

    if (pendingSpace) {
      output += " ";
      pendingSpace = false;
    }
    output += char;
  }

  return output.trim();
}

export function sanitizeNotificationMessage(message: string): string {
  return stripControlCharacters(message).slice(0, MESSAGE_LIMIT);
}

/**
 * Make AI-authored notifications visually distinct from WinHelm approval UI.
 * Existing/repeated prefix spellings are normalized so the canonical prefix
 * appears exactly once.
 */
export function rewriteNotificationTitle(title: string): string {
  let cleaned = stripControlCharacters(title);
  const prefixLower = AI_NOTIFICATION_PREFIX.toLowerCase();

  while (
    cleaned.length >= AI_NOTIFICATION_PREFIX.length &&
    cleaned.slice(0, AI_NOTIFICATION_PREFIX.length).toLowerCase() === prefixLower
  ) {
    cleaned = cleaned.slice(AI_NOTIFICATION_PREFIX.length).trimStart();
  }

  const prefixWithSpace = `${AI_NOTIFICATION_PREFIX} `;
  if (!cleaned) return AI_NOTIFICATION_PREFIX;

  const available = Math.max(0, TITLE_LIMIT - prefixWithSpace.length);
  return prefixWithSpace + cleaned.slice(0, available);
}
