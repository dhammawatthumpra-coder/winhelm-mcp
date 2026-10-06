/**
 * Spec 3.4 Tier B — strict deterministic JSON engine.
 *
 * The strict parser rejects duplicate keys instead of silently overwriting
 * them, and preserves the CPython-pinned value distinctions the canonical
 * contract needs:
 * - integer tokens become BigInt (arbitrary precision, no Number rounding;
 *   `9007199254740993` survives exactly);
 * - float tokens (containing `.`/`e`) become `StrictFloat`, so `2.0` keeps
 *   its float serialization even though `Number 2.0 === Number 2`;
 * - `NaN`/`Infinity`/`-Infinity` literals parse as non-finite floats exactly
 *   like CPython `json.loads`, and are rejected later by the serializer's
 *   `allow_nan=False` semantics.
 */

export const MAX_JSON_DEPTH = 512;

/** Float-token marker: preserves the int-vs-float distinction JS loses. */
export class StrictFloat {
  constructor(public readonly value: number) {}
}

export type StrictJsonValue =
  | null
  | boolean
  | string
  | bigint
  | number
  | StrictFloat
  | StrictJsonValue[]
  | { [key: string]: StrictJsonValue };

export interface StrictParseStats {
  objects: number;
  arrays: number;
  strings: number;
  integers: number;
  floats: number;
  booleans: number;
  nulls: number;
  keys: number;
  depth: number;
}

export interface StrictParseResult {
  value: StrictJsonValue;
  stats: StrictParseStats;
}

/** Structured parse failure carrying the JSON Pointer of the offence. */
export class JsonStrictParseError extends Error {
  constructor(
    public readonly reason: string,
    public readonly pointer: string,
    public readonly line: number,
    public readonly column: number
  ) {
    super(
      `Strict JSON parse failed at line ${line}, column ${column} (${pointer}): ${reason}`
    );
    this.name = "JsonStrictParseError";
  }
}

class Parser {
  private pos = 0;
  private line = 1;
  private column = 1;
  private depth = 0;
  readonly stats: StrictParseStats = {
    objects: 0,
    arrays: 0,
    strings: 0,
    integers: 0,
    floats: 0,
    booleans: 0,
    nulls: 0,
    keys: 0,
    depth: 0,
  };

  constructor(private readonly text: string) {}

  private fail(reason: string, pointer = ""): never {
    throw new JsonStrictParseError(reason, pointer, this.line, this.column);
  }

  private peek(): string {
    return this.text[this.pos] ?? "";
  }

  private advance(): string {
    const ch = this.text[this.pos++];
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  private skipWhitespace(): void {
    while (
      this.peek() === " " ||
      this.peek() === "\t" ||
      this.peek() === "\n" ||
      this.peek() === "\r"
    ) {
      this.advance();
    }
  }

  parse(): StrictParseResult {
    this.skipWhitespace();
    if (this.text.charCodeAt(0) === 0xfeff) {
      this.fail("JSON text must not begin with a UTF-8 BOM");
    }
    const value = this.parseValue("$");
    this.skipWhitespace();
    if (this.pos < this.text.length) {
      this.fail("unexpected trailing content after JSON value");
    }
    return { value, stats: this.stats };
  }

  private parseValue(pointer: string): StrictJsonValue {
    this.skipWhitespace();
    if (this.depth >= MAX_JSON_DEPTH) {
      this.fail(`structure exceeds the ${MAX_JSON_DEPTH}-depth limit`, pointer);
    }
    const ch = this.peek();
    switch (ch) {
      case "{":
        return this.parseObject(pointer);
      case "[":
        return this.parseArray(pointer);
      case '"':
        return this.parseString(pointer);
      case "t":
        this.expectLiteral("true");
        this.stats.booleans += 1;
        return true;
      case "f":
        this.expectLiteral("false");
        this.stats.booleans += 1;
        return false;
      case "n":
        this.expectLiteral("null");
        this.stats.nulls += 1;
        return null;
      case "N":
        this.expectLiteral("NaN");
        this.stats.floats += 1;
        return new StrictFloat(NaN);
      case "I":
        this.expectLiteral("Infinity");
        this.stats.floats += 1;
        return new StrictFloat(Infinity);
      default:
        if (ch === "-" && this.text.startsWith("-Infinity", this.pos)) {
          this.expectLiteral("-Infinity");
          this.stats.floats += 1;
          return new StrictFloat(-Infinity);
        }
        if (ch === "-" || (ch >= "0" && ch <= "9")) {
          return this.parseNumber(pointer);
        }
        this.fail(`unexpected character ${JSON.stringify(ch)}`, pointer);
    }
  }

  private expectLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.pos)) {
      this.fail(`expected ${literal}`);
    }
    for (let i = 0; i < literal.length; i++) this.advance();
  }

  private parseObject(pointer: string): StrictJsonValue {
    this.depth += 1;
    this.stats.objects += 1;
    this.stats.depth = Math.max(this.stats.depth, this.depth);
    this.advance(); // {
    const result: { [key: string]: StrictJsonValue } = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.advance();
      this.depth -= 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        this.fail("expected object key string", pointer);
      }
      const key = this.parseString(`pointer:${pointer}`);
      if (seen.has(key)) {
        this.fail(`duplicate object key ${JSON.stringify(key)}`, pointer);
      }
      seen.add(key);
      this.stats.keys += 1;
      this.skipWhitespace();
      if (this.advance() !== ":") {
        this.fail("expected ':' after object key", pointer);
      }
      result[key] = this.parseValue(`${pointer}/${escapePointerToken(key)}`);
      this.skipWhitespace();
      const sep = this.advance();
      if (sep === "}") break;
      if (sep !== ",") {
        this.fail("expected ',' or '}' in object", pointer);
      }
    }
    this.depth -= 1;
    return result;
  }

  private parseArray(pointer: string): StrictJsonValue {
    this.depth += 1;
    this.stats.arrays += 1;
    this.stats.depth = Math.max(this.stats.depth, this.depth);
    this.advance(); // [
    const result: StrictJsonValue[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.advance();
      this.depth -= 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue(`${pointer}/${result.length}`));
      this.skipWhitespace();
      const sep = this.advance();
      if (sep === "]") break;
      if (sep !== ",") {
        this.fail("expected ',' or ']' in array", pointer);
      }
    }
    this.depth -= 1;
    return result;
  }

  private parseNumber(pointer: string): StrictJsonValue {
    const start = this.pos;
    if (this.peek() === "-") this.advance();
    const intStart = this.pos;
    if (this.peek() === "0") {
      this.advance();
    } else if (this.peek() >= "1" && this.peek() <= "9") {
      while (this.peek() >= "0" && this.peek() <= "9") this.advance();
    } else {
      this.fail("invalid number", pointer);
    }
    const intDigits = this.text.slice(intStart, this.pos);
    let isFloat = false;
    if (this.peek() === ".") {
      isFloat = true;
      this.advance();
      if (!(this.peek() >= "0" && this.peek() <= "9")) {
        this.fail("expected digits after decimal point", pointer);
      }
      while (this.peek() >= "0" && this.peek() <= "9") this.advance();
    }
    if (this.peek() === "e" || this.peek() === "E") {
      isFloat = true;
      this.advance();
      if (this.peek() === "+" || this.peek() === "-") this.advance();
      if (!(this.peek() >= "0" && this.peek() <= "9")) {
        this.fail("expected exponent digits", pointer);
      }
      while (this.peek() >= "0" && this.peek() <= "9") this.advance();
    }
    const token = this.text.slice(start, this.pos);
    if (isFloat) {
      const parsed = Number(token);
      // Overflow (e.g. 1e999) mirrors CPython: json.loads yields inf and the
      // serializer's allow_nan=False contract rejects it.
      this.stats.floats += 1;
      return new StrictFloat(parsed);
    }
    this.stats.integers += 1;
    return BigInt(intStart === start ? intDigits : `-${intDigits}`);
  }

  private parseString(pointer: string): string {
    this.advance(); // opening quote
    let out = "";
    for (;;) {
      if (this.pos >= this.text.length) {
        this.fail("unterminated string", pointer);
      }
      const ch = this.advance();
      if (ch === '"') break;
      if (ch === "\\") {
        const esc = this.advance();
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const unit = this.parseHex4(pointer);
            if (unit >= 0xd800 && unit <= 0xdbff) {
              if (this.advance() !== "\\" || this.advance() !== "u") {
                this.fail("unpaired high surrogate", pointer);
              }
              const low = this.parseHex4(pointer);
              if (low < 0xdc00 || low > 0xdfff) {
                this.fail("invalid low surrogate", pointer);
              }
              out += String.fromCharCode(unit, low);
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              this.fail("unpaired low surrogate", pointer);
            } else {
              out += String.fromCharCode(unit);
            }
            break;
          }
          default:
            this.fail(`invalid escape \\${esc}`, pointer);
        }
        continue;
      }
      if (ch < " ") {
        this.fail("unescaped control character in string", pointer);
      }
      out += ch;
    }
    this.stats.strings += 1;
    return out;
  }

  private parseHex4(pointer: string): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const ch = this.advance();
      const digit = Number.parseInt(ch, 16);
      if (Number.isNaN(digit) || ch.trim() === "") {
        this.fail("invalid \\u escape", pointer);
      }
      value = value * 16 + digit;
    }
    return value;
  }
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** RFC 6901 JSON Pointer token split; validates the pointer form. */
export function splitJsonPointer(pointer: string): string[] {
  if (!pointer.startsWith("/")) {
    throw new Error(`invalid JSON Pointer (must start with '/'): ${pointer}`);
  }
  if (pointer === "/") {
    return [""];
  }
  return pointer
    .slice(1)
    .split("/")
    .map(unescapePointerToken);
}

export function parseStrictJsonText(text: string): StrictParseResult {
  if (typeof text !== "string") {
    throw new JsonStrictParseError("JSON source must be text", "$", 1, 1);
  }
  return new Parser(text).parse();
}

export { escapePointerToken };
