/**
 * Spec 3.4 Tier B — deterministic canonical JSON hashing engine.
 *
 * Two frozen schemes, never merged or silently substituted:
 * - `python-sorted-json-v1` reproduces the pinned CPython byte contract:
 *   `json.dumps(obj, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
 *   allow_nan=False) + "\n"`, with Unicode Code Point key ordering (NOT
 *   JavaScript UTF-16 `.sort()` order), `-0.0` preservation, and
 *   arbitrary-precision integer output.
 * - `jcs-rfc8785` implements RFC 8785: UTF-16 code unit key ordering,
 *   ECMAScript number serialization, no trailing newline.
 *
 * Both reject NaN/Infinity/-Infinity and duplicate-key sources with
 * `CANONICAL_JSON_ERROR`.
 */
import { createHash } from "node:crypto";
import {
  parseStrictJsonText,
  splitJsonPointer,
  StrictFloat,
  StrictJsonValue,
  escapePointerToken,
} from "./json-strict.js";
import { StructuredToolError } from "../errors/tool-error.js";

export type CanonicalScheme = "jcs-rfc8785" | "python-sorted-json-v1";

export interface CanonicalHashInput {
  source: { path?: string; text?: string; value?: unknown };
  scheme: CanonicalScheme;
  exclude_paths?: string[];
}

export interface CanonicalHashResult {
  scheme: CanonicalScheme;
  canonical_sha256: string;
  canonical_json: string;
  canonical_bytes: number;
  trailing_newline: boolean;
  excluded_paths: string[];
}

function canonicalError(reason: string, details?: Record<string, unknown>): never {
  throw new StructuredToolError(
    "CANONICAL_JSON_ERROR",
    reason,
    "Check the JSON source against RFC 8259 and the frozen canonicalization contract.",
    details
  );
}

/* ------------------------------------------------------------------ */
/* Key ordering                                                        */
/* ------------------------------------------------------------------ */

function codePoints(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0) as number);
  return out;
}

/** Unicode Code Point ordering (CPython `sort_keys=True` semantics). */
export function compareCodePointOrder(a: string, b: string): number {
  const aa = codePoints(a);
  const bb = codePoints(b);
  const shared = Math.min(aa.length, bb.length);
  for (let i = 0; i < shared; i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
}

/* ------------------------------------------------------------------ */
/* CPython float repr (ensure_ascii=True, repr formatting)             */
/* ------------------------------------------------------------------ */

/**
 * Reproduce CPython `repr(float)` — the shortest round-tripping digits
 * reformatted with Python's rules: fixed notation for
 * -4 < decpt <= 16, else scientific with a signed >= 2-digit exponent.
 */
export function pythonFloatRepr(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  let s = value.toString();
  let sign = "";
  if (s.startsWith("-")) {
    sign = "-";
    s = s.slice(1);
  }
  let mantissa = s;
  let exponent = 0;
  const eIndex = s.indexOf("e");
  if (eIndex >= 0) {
    mantissa = s.slice(0, eIndex);
    exponent = Number.parseInt(s.slice(eIndex + 1), 10);
  }
  let digits: string;
  let decpt: number;
  const dot = mantissa.indexOf(".");
  if (dot >= 0) {
    digits = mantissa.slice(0, dot) + mantissa.slice(dot + 1);
    decpt = dot + exponent;
  } else {
    digits = mantissa;
    decpt = mantissa.length + exponent;
  }
  let start = 0;
  while (start < digits.length - 1 && digits[start] === "0") {
    start += 1;
    decpt -= 1;
  }
  digits = digits.slice(start);

  if (decpt <= -4 || decpt > 16) {
    const exponentValue = decpt - 1;
    const exponentText =
      (exponentValue < 0 ? "-" : "+") +
      String(Math.abs(exponentValue)).padStart(2, "0");
    return (
      sign +
      digits[0] +
      (digits.length > 1 ? "." + digits.slice(1) : "") +
      "e" +
      exponentText
    );
  }
  if (decpt <= 0) {
    return sign + "0." + "0".repeat(-decpt) + digits;
  }
  if (decpt >= digits.length) {
    return sign + digits + "0".repeat(decpt - digits.length) + ".0";
  }
  return sign + digits.slice(0, decpt) + "." + digits.slice(decpt);
}

/* ------------------------------------------------------------------ */
/* String serialization                                                */
/* ------------------------------------------------------------------ */

function pythonEscapeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    switch (unit) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        // ensure_ascii=True escapes every code unit outside 0x20..0x7e,
        // including 0x7f and both halves of astral surrogate pairs.
        if (unit < 0x20 || unit > 0x7e) {
          out += "\\u" + unit.toString(16).padStart(4, "0");
        } else {
          out += value[i];
        }
    }
  }
  return out + '"';
}

function jcsEscapeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    switch (unit) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        if (unit < 0x20) {
          out += "\\u" + unit.toString(16).padStart(4, "0");
        } else {
          out += value[i];
        }
    }
  }
  return out + '"';
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

interface SerializeOptions {
  scheme: CanonicalScheme;
  /** Cycles are impossible in JSON-parsed data; depth only bounds recursion. */
  depth: number;
}

const MAX_SERIALIZE_DEPTH = 512;

function checkFinite(scheme: CanonicalScheme, value: number, pointer: string): void {
  if (!Number.isFinite(value)) {
    canonicalError(
      `${scheme} forbids non-finite values (NaN/Infinity/-Infinity) at ${pointer}`,
      { pointer, value: String(value) }
    );
  }
}

function serializeNumberLike(
  value: number,
  options: SerializeOptions,
  pointer: string
): string {
  checkFinite(options.scheme, value, pointer);
  if (options.scheme === "jcs-rfc8785") {
    // RFC 8785 serializes -0 as 0.
    return Object.is(value, -0) ? "0" : value.toString();
  }
  return pythonFloatRepr(value);
}

function serialize(
  value: unknown,
  options: SerializeOptions,
  pointer: string
): string {
  if (options.depth > MAX_SERIALIZE_DEPTH) {
    canonicalError(`canonical structure exceeds the depth limit at ${pointer}`, {
      pointer,
    });
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") {
    if (options.scheme === "jcs-rfc8785") {
      // RFC 8785 defines serialization for IEEE 754 doubles only; a
      // beyond-double-precision integer has no JCS representation.
      canonicalError(
        `jcs-rfc8785 cannot represent the arbitrary-precision integer at ${pointer}`,
        { pointer, value: value.toString() }
      );
    }
    return value.toString();
  }
  if (value instanceof StrictFloat) {
    return serializeNumberLike(value.value, options, pointer);
  }
  if (typeof value === "number") {
    // Plain (already parsed) numbers from a `{ value }` source carry CPython
    // int semantics when integral; -0 keeps its negative-zero float form in
    // the Python scheme.
    if (options.scheme === "python-sorted-json-v1") {
      if (Object.is(value, -0)) return "-0.0";
      if (Number.isInteger(value)) return serializeBigIntLike(BigInt(value), options, pointer);
    }
    return serializeNumberLike(value, options, pointer);
  }
  if (typeof value === "string") {
    return options.scheme === "jcs-rfc8785"
      ? jcsEscapeString(value)
      : pythonEscapeString(value);
  }
  if (Array.isArray(value)) {
    options.depth += 1;
    const items = value.map((item, index) =>
      serialize(item, options, `${pointer}/${index}`)
    );
    options.depth -= 1;
    return "[" + items.join(",") + "]";
  }
  if (typeof value === "object") {
    options.depth += 1;
    const entries = Object.entries(value as Record<string, unknown>);
    if (options.scheme === "jcs-rfc8785") {
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    } else {
      entries.sort((a, b) => compareCodePointOrder(a[0], b[0]));
    }
    const members = entries.map(
      ([key, item]) =>
        serialize(key, options, pointer) +
        ":" +
        serialize(item, options, `${pointer}/${escapePointerToken(key)}`)
    );
    options.depth -= 1;
    return "{" + members.join(",") + "}";
  }
  canonicalError(`unsupported value of type ${typeof value} at ${pointer}`, {
    pointer,
  });
}

function serializeBigIntLike(
  value: bigint,
  _options: SerializeOptions,
  _pointer: string
): string {
  return value.toString();
}

/* ------------------------------------------------------------------ */
/* Exclusions                                                          */
/* ------------------------------------------------------------------ */

/**
 * Apply the frozen selection/exclusion contract. Invalid or non-resolving
 * exclusion paths are refused with a structured error; they are never
 * silently ignored (a silently dropped exclusion would change the hash).
 */
export function applyExcludePaths(
  root: unknown,
  excludePaths: string[]
): { value: unknown; applied: string[] } {
  const applied: string[] = [];
  for (const raw of excludePaths) {
    if (typeof raw !== "string" || raw.trim() === "") {
      canonicalError(`invalid exclusion path: ${JSON.stringify(raw)}`, {
        exclude_path: raw,
      });
    }
    const pointer = raw.startsWith("/") ? raw : `/${escapePointerToken(raw)}`;
    let tokens: string[];
    try {
      tokens = splitJsonPointer(pointer);
    } catch (err) {
      canonicalError((err as Error).message, { exclude_path: raw });
    }
    // Walk to the parent container.
    let container: unknown = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      const next = descend(container, tokens[i], raw);
      if (next === undefined) {
        canonicalError(`exclusion path does not resolve: ${raw}`, {
          exclude_path: raw,
        });
      }
      container = next;
    }
    const leaf = tokens[tokens.length - 1];
    if (Array.isArray(container)) {
      const index = arrayIndex(leaf);
      if (index === null || index < 0 || index >= container.length) {
        canonicalError(`exclusion path does not resolve: ${raw}`, {
          exclude_path: raw,
        });
      }
      container.splice(index, 1);
    } else if (container !== null && typeof container === "object") {
      if (!Object.prototype.hasOwnProperty.call(container, leaf)) {
        canonicalError(`exclusion path does not resolve: ${raw}`, {
          exclude_path: raw,
        });
      }
      delete (container as Record<string, unknown>)[leaf];
    } else {
      canonicalError(`exclusion path does not resolve: ${raw}`, {
        exclude_path: raw,
      });
    }
    applied.push(pointer);
  }
  return { value: root, applied };
}

function descend(container: unknown, token: string, raw: string): unknown {
  if (Array.isArray(container)) {
    const index = arrayIndex(token);
    if (index === null || index < 0 || index >= container.length) {
      canonicalError(`exclusion path does not resolve: ${raw}`, {
        exclude_path: raw,
      });
    }
    return container[index];
  }
  if (container !== null && typeof container === "object") {
    if (!Object.prototype.hasOwnProperty.call(container, token)) {
      canonicalError(`exclusion path does not resolve: ${raw}`, {
        exclude_path: raw,
      });
    }
    return (container as Record<string, unknown>)[token];
  }
  canonicalError(`exclusion path does not resolve: ${raw}`, {
    exclude_path: raw,
  });
}

function arrayIndex(token: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return null;
  return Number.parseInt(token, 10);
}

/* ------------------------------------------------------------------ */
/* Public engine entry points                                          */
/* ------------------------------------------------------------------ */

export function canonicalizeText(
  text: string,
  scheme: CanonicalScheme,
  excludePaths: string[] = []
): CanonicalHashResult {
  const parsed = parseStrictJsonText(text);
  let working: unknown = parsed.value;
  if (excludePaths.length > 0) {
    const excluded = applyExcludePaths(working, excludePaths);
    working = excluded.value;
  }
  const body = serialize(working, { scheme, depth: 0 }, "$");
  const payload = scheme === "python-sorted-json-v1" ? body + "\n" : body;
  const canonical_bytes = Buffer.byteLength(payload, "utf8");
  return {
    scheme,
    canonical_sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
    canonical_json: payload,
    canonical_bytes,
    trailing_newline: scheme === "python-sorted-json-v1",
    excluded_paths: excludePaths.map((raw) =>
      raw.startsWith("/") ? raw : `/${escapePointerToken(raw)}`
    ),
  };
}

export function canonicalizeValue(
  value: unknown,
  scheme: CanonicalScheme,
  excludePaths: string[] = []
): CanonicalHashResult {
  let working: unknown = value;
  if (excludePaths.length > 0) {
    const excluded = applyExcludePaths(value, excludePaths);
    working = excluded.value;
  }
  const body = serialize(working, { scheme, depth: 0 }, "$");
  const payload = scheme === "python-sorted-json-v1" ? body + "\n" : body;
  const canonical_bytes = Buffer.byteLength(payload, "utf8");
  return {
    scheme,
    canonical_sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
    canonical_json: payload,
    canonical_bytes,
    trailing_newline: scheme === "python-sorted-json-v1",
    excluded_paths: excludePaths.map((raw) =>
      raw.startsWith("/") ? raw : `/${escapePointerToken(raw)}`
    ),
  };
}

export type { StrictJsonValue };
