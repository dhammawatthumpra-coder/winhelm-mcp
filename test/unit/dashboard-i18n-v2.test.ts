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

const FULL_MODE = {
  schemaMode: "v2" as const,
  preset: "power",
  terminalMode: "full",
};

describe("Dashboard baseline message locale", () => {
  it("serves the full-access warning from the configured locale", () => {
    const thai = withLocale("th", () =>
      getDashboardHtml("full", FULL_MODE)
    );
    assert.ok(
      thai.includes(escapeHtml(translate("mode.full.warn", {}, "th")))
    );
    assert.ok(
      thai.includes(`DASHBOARD_MESSAGES = {"fullWarn":`)
    );
    assert.ok(
      thai.includes(translate("mode.full.warn", {}, "th"))
    );

    const english = withLocale("en", () =>
      getDashboardHtml("full", FULL_MODE)
    );
    assert.ok(
      english.includes(escapeHtml(translate("mode.full.warn", {}, "en")))
    );
    assert.strictEqual(
      english.includes(translate("mode.full.warn", {}, "th")),
      false
    );
  });

  it("localizes the typed-confirmation hint and escapes the attribute", () => {
    const thai = withLocale("th", () =>
      getDashboardHtml("full", { schemaMode: "v2" })
    );
    const confirmType = translate("confirm.type", {}, "th");
    assert.ok(
      thai.includes(`placeholder="${escapeHtml(confirmType)}"`)
    );
    // The message contains quotes, so the attribute value must stay escaped.
    assert.strictEqual(
      thai.includes(`placeholder="${confirmType}"`),
      false
    );
  });

  it("ships the expiry message to the approval list in the active locale", () => {
    const thai = withLocale("th", () =>
      getDashboardHtml("full", FULL_MODE)
    );
    const expiry = translate("approve.expiry", {}, "th");
    assert.ok(thai.includes("DASHBOARD_MESSAGES.expiry"));
    assert.ok(
      thai.includes(
        `"expiry":${JSON.stringify(expiry).replace(/</g, "\\u003c")}`
      )
    );
    assert.ok(thai.includes("' · ' + DASHBOARD_MESSAGES.expiry"));
  });
});
