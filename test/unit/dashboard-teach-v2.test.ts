import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, getDashboardHtml } from "../../src/gateway/dashboard-html.js";
import {
  setConfiguredLocale,
  translate,
} from "../../src/i18n/messages.js";

function withLocale<T>(locale: "th" | "en" | undefined, fn: () => T): T {
  const previousEnv = process.env.WINHELM_LOCALE;
  delete process.env.WINHELM_LOCALE;
  try {
    setConfiguredLocale(locale);
    return fn();
  } finally {
    setConfiguredLocale(undefined);
    if (previousEnv === undefined) {
      delete process.env.WINHELM_LOCALE;
    } else {
      process.env.WINHELM_LOCALE = previousEnv;
    }
  }
}

const SUMMARY = {
  schemaMode: "v2" as const,
  preset: "balanced",
  terminalMode: "ask",
};

describe("Dashboard wizard step 5 (test and teach the AI)", () => {
  it("renders the example prompts and copyable AI instructions", () => {
    const html = withLocale("en", () => getDashboardHtml("full", SUMMARY));

    assert.ok(html.includes('id="teachExamples"'));
    assert.ok(html.includes('id="teachInstructions"'));
    assert.ok(html.includes('id="teachCopyStatus"'));
    assert.ok(
      html.includes(escapeHtml(translate("dashboard.teach.example1", {}, "en")))
    );
    assert.ok(
      html.includes(
        escapeHtml(translate("dashboard.teach.instructionText", {}, "en"))
      )
    );
    assert.ok(html.includes("onclick=\"copyTeachBlock('teachExamples')\""));
    assert.ok(html.includes("onclick=\"copyTeachBlock('teachInstructions')\""));
  });

  it("keeps the measured n/N evidence and never overstates it", () => {
    const english = withLocale("en", () =>
      getDashboardHtml("full", SUMMARY)
    );
    assert.ok(english.includes("0 of 6"));
    assert.ok(english.includes("1 of 1"));
    assert.ok(english.includes("not a guarantee"));

    const thai = withLocale("th", () => getDashboardHtml("full", SUMMARY));
    assert.ok(thai.includes("0 จาก 6"));
    assert.ok(thai.includes("1 จาก 1"));
    assert.ok(thai.includes("ไม่ใช่การรับประกัน"));

    // The claim check targets the card copy, not page-wide CSS ("width: 100%").
    for (const locale of ["en", "th"] as const) {
      const copy = [
        "dashboard.teach.claudeTip",
        "dashboard.teach.sandboxHint",
        "dashboard.teach.instructionText",
      ]
        .map((key) => translate(key as any, {}, locale))
        .join(" ");

      assert.strictEqual(copy.includes("100%"), false, `${locale} 100% claim`);
      assert.strictEqual(
        /always works|guaranteed|ได้เสมอ|การรับประกันว่า/i.test(copy),
        false,
        `${locale} overstatement`
      );
    }
  });

  it("localizes the whole card", () => {
    const thai = withLocale("th", () => getDashboardHtml("full", SUMMARY));
    const english = withLocale("en", () => getDashboardHtml("full", SUMMARY));

    for (const key of [
      "dashboard.teach.title",
      "dashboard.teach.intro",
      "dashboard.teach.examples",
      "dashboard.teach.instructions",
      "dashboard.teach.example1",
      "dashboard.teach.example2",
      "dashboard.teach.instructionText",
      "dashboard.teach.claudeTip",
      "dashboard.teach.sandboxHint",
      "dashboard.teach.copy",
    ] as const) {
      assert.ok(
        thai.includes(escapeHtml(translate(key, {}, "th"))),
        `${key} must render in Thai`
      );
      assert.ok(
        english.includes(escapeHtml(translate(key, {}, "en"))),
        `${key} must render in English`
      );
    }
  });

  it("copies the block text without injecting markup", () => {
    const html = getDashboardHtml("full", SUMMARY);
    assert.match(html, /String\(source\.textContent \|\| ''\)\.trim\(\)/);
    assert.match(html, /navigator\.clipboard\.writeText\(text\)/);
    assert.ok(html.includes("DASHBOARD_MESSAGES.teachCopyFailed"));
    assert.strictEqual(html.includes("teachInstructions').innerHTML"), false);
  });
});
