/**
 * Spec 3.4 Tier B targeted tests — deterministic JSON contract.
 *
 * Covers the Work Order §11 items 1–14: strict duplicate-key rejection,
 * text/path/value sources, exclude_paths selection, the 10 pinned
 * python-sorted-json-v1 fixtures, the frozen negative suite, negative-zero
 * preservation, arbitrary-precision integers, Unicode Code Point ordering
 * divergence, ASCII escaping, JCS/RFC 8785 vectors, and malformed JSON
 * structured errors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalizeText,
  canonicalizeValue,
  applyExcludePaths,
  compareCodePointOrder,
} from "../../src/engine/canonical-json.js";
import {
  parseStrictJsonText,
  JsonStrictParseError,
  StrictFloat,
} from "../../src/engine/json-strict.js";

const CORPUS_PATH =
  "D:/mcp/spike/fixtures/python-sorted-json-v1-conformance.jsonl";
const CORPUS_SHA256 =
  "9f61189b84a4698dab095cc4de073233b62fb7d8c08a1f8872313ed5cc87606c";

/** Extract the raw_input JSON text exactly as pinned in the JSONL line. */
function extractRawInput(line: string): string {
  const marker = '"raw_input": ';
  const start = line.indexOf(marker) + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return line.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced raw_input in corpus line");
}

async function withTempFile(
  body: string,
  fn: (filePath: string) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-json-"));
  const filePath = path.join(dir, "source.json");
  await fs.writeFile(filePath, body, "utf8");
  try {
    await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("Tier B deterministic JSON contract", async (t) => {
  await t.test("pinned corpus file is byte-identical to the frozen hash", async () => {
    const bytes = await fs.readFile(CORPUS_PATH);
    const { createHash } = await import("node:crypto");
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      CORPUS_SHA256
    );
  });

  await t.test("passes all 10 pinned python-sorted-json-v1 fixtures exactly", async () => {
    const lines = (await fs.readFile(CORPUS_PATH, "utf8")).trim().split("\n");
    assert.equal(lines.length, 10);
    for (const line of lines) {
      const fixture = JSON.parse(line) as {
        fixture: string;
        canonical_sha256: string;
        exclude_paths?: string[];
      };
      const rawText = extractRawInput(line);
      const result = canonicalizeText(
        rawText,
        "python-sorted-json-v1",
        fixture.exclude_paths ?? []
      );
      assert.equal(
        result.canonical_sha256,
        fixture.canonical_sha256,
        `fixture ${fixture.fixture} canonical SHA mismatch`
      );
    }
  });

  await t.test("rejects NaN with CANONICAL_JSON_ERROR (text and value sources)", () => {
    assert.throws(
      () => canonicalizeText('{"val": NaN}', "python-sorted-json-v1"),
      (err: unknown) =>
        (err as { code?: string }).code === "CANONICAL_JSON_ERROR"
    );
    assert.throws(
      () => canonicalizeValue({ val: NaN }, "python-sorted-json-v1"),
      (err: unknown) =>
        (err as { code?: string }).code === "CANONICAL_JSON_ERROR"
    );
  });

  await t.test("rejects Infinity with CANONICAL_JSON_ERROR", () => {
    assert.throws(
      () => canonicalizeText('{"val": Infinity}', "python-sorted-json-v1"),
      (err: unknown) =>
        (err as { code?: string }).code === "CANONICAL_JSON_ERROR"
    );
    assert.throws(
      () => canonicalizeValue({ val: Infinity }, "python-sorted-json-v1"),
      (err: unknown) =>
        (err as { code?: string }).code === "CANONICAL_JSON_ERROR"
    );
  });

  await t.test("rejects -Infinity with CANONICAL_JSON_ERROR", () => {
    assert.throws(
      () => canonicalizeText('{"val": -Infinity}', "python-sorted-json-v1"),
      (err: unknown) =>
        (err as { code?: string }).code === "CANONICAL_JSON_ERROR"
    );
    assert.throws(
      () => canonicalizeValue({ val: -Infinity }, "python-sorted-json-v1"),
      (err: unknown) =>
        (err as { code?: string }).code === "CANONICAL_JSON_ERROR"
    );
  });

  await t.test("rejects raw duplicate keys instead of overwriting", () => {
    assert.throws(
      () => canonicalizeText('{"gate_id": 1, "gate_id": 2}', "python-sorted-json-v1"),
      (err: unknown) => err instanceof JsonStrictParseError
    );
  });

  await t.test("preserves negative zero in the python scheme", () => {
    const textResult = canonicalizeText(
      '{"neg_zero": -0.0}',
      "python-sorted-json-v1"
    );
    assert.equal(textResult.canonical_json, '{"neg_zero":-0.0}\n');
    const valueResult = canonicalizeValue(
      { neg_zero: -0.0 },
      "python-sorted-json-v1"
    );
    assert.equal(valueResult.canonical_json, '{"neg_zero":-0.0}\n');
  });

  await t.test("preserves arbitrary-precision integers beyond MAX_SAFE_INTEGER", () => {
    const result = canonicalizeText(
      '{"bigint": 9007199254740993}',
      "python-sorted-json-v1"
    );
    assert.equal(result.canonical_json, '{"bigint":9007199254740993}\n');
  });

  await t.test("sorts keys by Unicode Code Point order, not UTF-16 order", () => {
    // The pinned divergence fixture: "a" < "\uE000" < "😀".
    const result = canonicalizeText(
      '{"a": 3, "\uE000": 2, "\u{1F600}": 1}',
      "python-sorted-json-v1"
    );
    assert.equal(
      result.canonical_json,
      '{"a":3,"\\ue000":2,"\\ud83d\\ude00":1}\n'
    );
    // The comparator itself diverges from the naive JS default order.
    assert.ok(compareCodePointOrder("\uE000", "😀") < 0);
    assert.ok("😀" < "\uE000"); // UTF-16 unit order is the opposite
  });

  await t.test("applies ensure_ascii escaping behavior", () => {
    const result = canonicalizeText(
      '{"non_ascii": "สวัสดี", "accents": "café", "ctrl": "line1\\nline2\\ttab\\r\\b\\f"}',
      "python-sorted-json-v1"
    );
    assert.equal(
      result.canonical_json,
      '{"accents":"caf\\u00e9","ctrl":"line1\\nline2\\ttab\\r\\b\\f","non_ascii":"\\u0e2a\\u0e27\\u0e31\\u0e2a\\u0e14\\u0e35"}\n'
    );
    // DEL (0x7f) is escaped by ensure_ascii as well.
    const del = canonicalizeText('{"d": "\\u007f"}', "python-sorted-json-v1");
    assert.equal(del.canonical_json, '{"d":"\\u007f"}\n');
  });

  await t.test("selects exclude_paths and refuses invalid or non-resolving ones", () => {
    const fixture = canonicalizeText(
      '{"gate_id": "GATE-101", "signature": "sig_xyz", "data": {"metric": 42}}',
      "python-sorted-json-v1",
      ["/gate_id", "/signature"]
    );
    assert.equal(fixture.canonical_json, '{"data":{"metric":42}}\n');

    // Nested JSON Pointer exclusion.
    const nested = canonicalizeText(
      '{"data": {"metric": 42, "keep": true}}',
      "python-sorted-json-v1",
      ["/data/metric"]
    );
    assert.equal(nested.canonical_json, '{"data":{"keep":true}}\n');

    // Bare top-level key form.
    const bare = canonicalizeText(
      '{"gate_id": "GATE-101", "data": {"metric": 42}}',
      "python-sorted-json-v1",
      ["gate_id"]
    );
    assert.equal(bare.canonical_json, '{"data":{"metric":42}}\n');

    // Invalid pointer form and non-resolving targets are structured rejections.
    assert.throws(
      () => applyExcludePaths({ a: 1 }, ["a/b"]),
      (err: unknown) =>
        (err as { code?: string }).code === "CANONICAL_JSON_ERROR"
    );
    assert.throws(
      () => applyExcludePaths({ a: 1 }, ["/missing"]),
      (err: unknown) =>
        (err as { code?: string }).code === "CANONICAL_JSON_ERROR"
    );
  });

  await t.test("handles text, path, and value sources for hashing", async () => {
    const text = '{"a": 1, "b": [true, null]}';
    const fromText = canonicalizeText(text, "python-sorted-json-v1");
    const fromValue = canonicalizeValue(
      { a: 1, b: [true, null] },
      "python-sorted-json-v1"
    );
    assert.equal(fromText.canonical_json, '{"a":1,"b":[true,null]}\n');
    assert.equal(fromValue.canonical_sha256, fromText.canonical_sha256);

    await withTempFile(text, async (filePath) => {
      const fromPath = canonicalizeText(
        await fs.readFile(filePath, "utf8"),
        "python-sorted-json-v1"
      );
      assert.equal(fromPath.canonical_sha256, fromText.canonical_sha256);
    });
  });

  await t.test("rejects malformed JSON with structured details", () => {
    try {
      parseStrictJsonText('{"a": 1, "b": }');
      assert.fail("expected parse failure");
    } catch (err) {
      assert.ok(err instanceof JsonStrictParseError);
      const parseErr = err as JsonStrictParseError;
      assert.ok(parseErr.line >= 1);
      assert.ok(parseErr.column > 1);
      assert.ok(parseErr.reason.length > 0);
    }
    assert.throws(() => parseStrictJsonText("{"));
    assert.throws(() => parseStrictJsonText('{"a": 01}'));
    assert.throws(() => parseStrictJsonText('{"a": "unterminated}'));
  });

  await t.test("implements JCS/RFC 8785 independently with known vectors", () => {
    // RFC 8785 section 3.2.3 example semantics: number serialization and
    // UTF-16 code unit key ordering, no trailing newline.
    const source =
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], ' +
      '"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\n": "Newline", "1": "One", ' +
      '"\\u00f6": "Latin Small Letter O With Diaeresis", "\\u6c34": "Water", ' +
      '"\\ud834\\udd1e": "Musical Symbol G Clef", "\\ud83d\\ude00": "Emoji: Grinning Face", " ": "Space"}';
    const result = canonicalizeText(source, "jcs-rfc8785");
    assert.equal(
      result.canonical_json,
      '{"\\n":"Newline","\\r":"Carriage Return"," ":"Space","1":"One",' +
        '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",' +
        '"水":"Water","𝄞":"Musical Symbol G Clef",' +
        '"😀":"Emoji: Grinning Face"}'
    );
    assert.equal(result.trailing_newline, false);

    // JCS serializes -0 as 0 (unlike the python scheme) and keeps strings
    // un-escaped when printable.
    assert.equal(
      canonicalizeValue({ z: -0.0, s: "ä" }, "jcs-rfc8785").canonical_json,
      '{"s":"ä","z":0}'
    );
  });

  await t.test("strict parser reports structure statistics deterministically", () => {
    const parsed = parseStrictJsonText('{"a": [1, {"b": null}], "c": "x"}');
    assert.equal(parsed.stats.depth, 3);
    assert.equal(parsed.stats.objects, 2);
    assert.equal(parsed.stats.arrays, 1);
    assert.equal(parsed.stats.integers, 1);
    assert.equal(parsed.stats.nulls, 1);
  });

  await t.test("float tokens keep float semantics distinct from integers", () => {
    const parsed = parseStrictJsonText('{"i": 2, "f": 2.0, "e": 1e-05}');
    const value = parsed.value as Record<string, unknown>;
    assert.equal(typeof value.i, "bigint");
    assert.ok(value.f instanceof StrictFloat);
    assert.ok(value.e instanceof StrictFloat);
    const serialized = canonicalizeText(
      '{"i": 2, "f": 2.0, "e": 1e-05}',
      "python-sorted-json-v1"
    );
    assert.equal(serialized.canonical_json, '{"e":1e-05,"f":2.0,"i":2}\n');
  });

  await t.test("top-level __proto__ member is preserved as an own data property", () => {
    const parsed = parseStrictJsonText('{"__proto__": 1, "after": 2}');
    const value = parsed.value as Record<string, unknown>;
    assert.equal(
      Object.prototype.hasOwnProperty.call(value, "__proto__"),
      true,
      "__proto__ must materialize as an own property"
    );
    assert.equal(value["__proto__"], 1n);
    assert.equal(value["after"], 2n);
    assert.deepEqual(Object.getOwnPropertyNames(value), ["__proto__", "after"]);
    // Key/value/depth statistics must match the materialized structure.
    assert.equal(parsed.stats.keys, 2);
    assert.equal(parsed.stats.integers, 2);
    assert.equal(parsed.stats.objects, 1);
    // The parsed object's prototype must not be replaced as a side effect.
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
  });

  await t.test("nested __proto__ members are preserved", () => {
    const parsed = parseStrictJsonText('{"outer": {"__proto__": {"x": 1}}}');
    const outer = (parsed.value as Record<string, unknown>).outer as Record<
      string,
      unknown
    >;
    assert.equal(Object.prototype.hasOwnProperty.call(outer, "__proto__"), true);
    const inner = outer["__proto__"] as Record<string, unknown>;
    assert.equal(inner["x"], 1n);
    assert.equal(Object.getPrototypeOf(outer), Object.prototype);
    assert.equal(Object.getPrototypeOf(inner), Object.prototype);
    assert.equal(parsed.stats.objects, 3);
    assert.equal(parsed.stats.keys, 3);
    assert.equal(parsed.stats.depth, 3);
  });

  await t.test("duplicate __proto__ keys are still rejected", () => {
    assert.throws(
      () => parseStrictJsonText('{"__proto__": 1, "__proto__": 2}'),
      (err: unknown) => err instanceof JsonStrictParseError
    );
  });

  await t.test("ordinary exotic keys keep their own-property semantics", () => {
    const parsed = parseStrictJsonText(
      '{"constructor": 1, "prototype": 2, "toString": 3}'
    );
    const value = parsed.value as Record<string, unknown>;
    assert.equal(value["constructor"], 1n);
    assert.equal(value["prototype"], 2n);
    assert.equal(value["toString"], 3n);
    assert.equal(parsed.stats.keys, 3);
  });

  await t.test("__proto__ vector matches the exact CPython canonical bytes", () => {
    // CPython 3.13 reference:
    // json.dumps(json.loads('{"__proto__": {"x": 1}, "after": 2}'),
    //            ensure_ascii=True, sort_keys=True, separators=(",", ":"),
    //            allow_nan=False) + "\n"
    const result = canonicalizeText(
      '{"__proto__":{"x":1},"after":2}',
      "python-sorted-json-v1"
    );
    assert.equal(result.canonical_json, '{"__proto__":{"x":1},"after":2}\n');
    assert.equal(
      result.canonical_sha256,
      "6f521579d70e5fd7eadbec0e7083f58998b19549ecbd2cba955cf81d92a16b18"
    );
  });

  await t.test("path source with a __proto__ member produces the same canonical hash", async () => {
    await withTempFile('{"__proto__":{"x":1},"after":2}', async (filePath) => {
      const fromPath = canonicalizeText(
        await fs.readFile(filePath, "utf8"),
        "python-sorted-json-v1"
      );
      const fromText = canonicalizeText(
        '{"__proto__":{"x":1},"after":2}',
        "python-sorted-json-v1"
      );
      assert.equal(fromPath.canonical_sha256, fromText.canonical_sha256);
      assert.equal(
        fromPath.canonical_sha256,
        "6f521579d70e5fd7eadbec0e7083f58998b19549ecbd2cba955cf81d92a16b18"
      );
    });
  });

  await t.test("JCS preserves the __proto__ member instead of dropping it", () => {
    const result = canonicalizeText(
      '{"__proto__": "p", "after": "a"}',
      "jcs-rfc8785"
    );
    assert.equal(result.canonical_json, '{"__proto__":"p","after":"a"}');
  });
});
