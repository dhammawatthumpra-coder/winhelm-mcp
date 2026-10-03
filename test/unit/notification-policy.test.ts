import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_NOTIFICATION_PREFIX,
  rewriteNotificationTitle,
  sanitizeNotificationMessage,
} from "../../src/utils/notification-policy.js";

describe("Notification anti-spoofing policy", () => {
  it("adds the canonical AI prefix exactly once", () => {
    assert.strictEqual(
      rewriteNotificationTitle("Task Complete"),
      "AI message: Task Complete"
    );
    assert.strictEqual(
      rewriteNotificationTitle("AI message: Task Complete"),
      "AI message: Task Complete"
    );
    assert.strictEqual(
      rewriteNotificationTitle("ai message: AI message: Task Complete"),
      "AI message: Task Complete"
    );
  });

  it("returns the canonical prefix for an empty/prefix-only title", () => {
    assert.strictEqual(rewriteNotificationTitle(""), AI_NOTIFICATION_PREFIX);
    assert.strictEqual(
      rewriteNotificationTitle("AI message:"),
      AI_NOTIFICATION_PREFIX
    );
  });

  it("removes control characters and collapses whitespace", () => {
    assert.strictEqual(
      rewriteNotificationTitle("Approve\u0000\n\tNow"),
      "AI message: Approve Now"
    );
    assert.strictEqual(
      sanitizeNotificationMessage("Line1\r\nLine2\u0007  Line3"),
      "Line1 Line2 Line3"
    );
  });

  it("limits the rewritten title and message lengths", () => {
    const title = rewriteNotificationTitle("x".repeat(500));
    const message = sanitizeNotificationMessage("y".repeat(1000));

    assert.strictEqual(title.length, 100);
    assert.ok(title.startsWith("AI message: "));
    assert.strictEqual(message.length, 500);
  });

  it("normalizes compatibility Unicode before prefix detection", () => {
    assert.strictEqual(
      rewriteNotificationTitle("ＡＩ message: Hello"),
      "AI message: Hello"
    );
  });
});
