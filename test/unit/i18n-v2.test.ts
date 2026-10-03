import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EN_MESSAGES,
  TH_MESSAGES,
  resolveLocale,
  translate,
  validateI18nCatalogs,
} from "../../src/i18n/messages.js";

describe("WinHelm i18n catalogs", () => {
  it("keeps Thai and English keys/placeholders in exact parity", () => {
    assert.deepStrictEqual(
      Object.keys(TH_MESSAGES).sort(),
      Object.keys(EN_MESSAGES).sort()
    );
    assert.deepStrictEqual(validateI18nCatalogs(), []);
  });

  it("matches the implementation-baseline examples exactly", () => {
    assert.strictEqual(
      translate("mode.full.warn", {}, "en"),
      "The AI can run any command without asking and has the same rights as your Windows account"
    );
    assert.strictEqual(
      translate("mode.full.warn", {}, "th"),
      "AI สามารถรันคำสั่งใดก็ได้โดยไม่ถาม และมีสิทธิ์เท่ากับบัญชี Windows ของคุณ"
    );

    assert.strictEqual(
      translate("approve.expiry", {}, "en"),
      "The command will not run after this expires"
    );
    assert.strictEqual(
      translate("approve.expiry", {}, "th"),
      "หมดเวลาแล้วจะไม่รันคำสั่งนี้"
    );

    assert.strictEqual(
      translate("confirm.type", {}, "en"),
      'Type "confirm" to continue'
    );
    assert.strictEqual(
      translate("confirm.type", {}, "th"),
      'พิมพ์ "ยืนยัน" เพื่อดำเนินการต่อ'
    );
  });

  it("falls back to English for unsupported locales", () => {
    assert.strictEqual(resolveLocale("fr-FR"), "en");
    assert.strictEqual(resolveLocale("ja"), "en");
    assert.strictEqual(resolveLocale(undefined), "en");
    assert.strictEqual(resolveLocale("th-TH"), "th");
    assert.strictEqual(resolveLocale("en-US"), "en");
  });

  it("provides translated user actions used by permission/approval gates", () => {
    assert.strictEqual(
      translate("action.tool.enable", {}, "en"),
      "Enable this tool in WinHelm permissions."
    );
    assert.strictEqual(
      translate("action.tool.enable", {}, "th"),
      "เปิดใช้เครื่องมือนี้ใน Permissions ของ WinHelm"
    );

    assert.strictEqual(
      translate("action.approval.cancelled", {}, "en"),
      "Do not retry automatically."
    );
    assert.strictEqual(
      translate("action.approval.cancelled", {}, "th"),
      "อย่าลองใหม่โดยอัตโนมัติ"
    );
  });
});
