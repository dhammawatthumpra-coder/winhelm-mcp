/**
 * Internal standards-correct canonical JSON (RFC 8785 / JCS) serialization.
 *
 * Added narrowly for the Spec 3.4 `directory_manifest` canonical hash
 * contract. This is NOT the Tier B public `json_canonical_hash` tool and must
 * stay internal: keys sort by UTF-16 code unit order, separators are "," and
 * ":" with no whitespace, and numbers/strings serialize exactly as ECMAScript
 * JSON does (which is RFC 8785 for the value domain this scope contains).
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function serializeValue(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          "Canonical JSON (RFC 8785) cannot serialize non-finite numbers."
        );
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(serializeValue).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const parts: string[] = [];
      for (const key of keys) {
        const memberValue = record[key];
        if (memberValue === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${serializeValue(memberValue)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(
        `Canonical JSON cannot serialize value of type ${typeof value}.`
      );
  }
}

export function canonicalJsonStringify(value: unknown): string {
  return serializeValue(value);
}

/**
 * UTF-8 byte lexicographic comparator for deterministic entry ordering
 * (Spec 3.4 manifest contract: binary byte code unit order).
 */
export function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
