import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProvenanceTracker,
  summarizeProvenanceTarget,
} from "../../src/approval/provenance.js";

describe("Approval provenance tracker", () => {
  it("keeps the latest entries session-local and newest-first", () => {
    const tracker = new ProvenanceTracker();

    tracker.recordResult(
      "session-a",
      "file_read",
      { path: "D:\\one.txt" },
      { content: [{ type: "text", text: "one" }] },
      "completed",
      100
    );
    tracker.recordResult(
      "session-a",
      "file_hash",
      { path: "D:\\two.txt" },
      { content: [{ type: "text", text: "two" }] },
      "completed",
      200
    );
    tracker.recordResult(
      "session-b",
      "system_info",
      {},
      { content: [{ type: "text", text: "other" }] },
      "completed",
      300
    );

    assert.deepStrictEqual(
      tracker.getRecent("session-a", 3).map((entry) => entry.tool),
      ["file_hash", "file_read"]
    );
    assert.deepStrictEqual(
      tracker.getRecent("session-b", 3).map((entry) => entry.tool),
      ["system_info"]
    );
    assert.deepStrictEqual(tracker.getRecent("missing", 3), []);
  });

  it("redacts secrets and caps text preview at 200 characters plus ellipsis", () => {
    const tracker = new ProvenanceTracker();
    const secret = "sk-abcdef1234567890abcdef123456";
    const longText =
      "Authorization: Bearer secret-token-xyz-123456 " +
      secret +
      " " +
      "<script>alert(1)</script> " +
      "https://example.com/" +
      "x".repeat(300);

    const entry = tracker.recordResult(
      "session",
      "file_read",
      { path: "D:\\note.txt" },
      { content: [{ type: "text", text: longText }] }
    );

    assert.ok(entry.preview);
    assert.ok(!entry.preview!.includes(secret));
    assert.ok(!entry.preview!.includes("secret-token-xyz-123456"));
    assert.ok(entry.preview!.length <= 201);
    assert.match(entry.preview!, /<script>/);
    assert.strictEqual(entry.metadata.bytes, Buffer.byteLength(longText));
    assert.strictEqual(entry.metadata.contentType, "text");
  });

  it("sanitizes target fields and limits target detail", () => {
    const target = summarizeProvenanceTarget("http_request", {
      url: "https://example.com/?token=sk-abcdef1234567890abcdef123456",
      cwd: "D:\\Work",
      command: "echo hello",
      destination: "D:\\Out",
      extra: "ignored",
    });

    assert.ok(!target.includes("sk-abcdef1234567890abcdef123456"));
    assert.match(target, /destination=/);
    assert.match(target, /url=/);
    assert.match(target, /cwd=/);
    assert.ok(!target.includes("command="));
    assert.ok(!target.includes("extra="));
  });

  it("records thrown errors as redacted error provenance", () => {
    const tracker = new ProvenanceTracker();
    tracker.recordThrownError(
      "session",
      "command_run",
      { command: "npm", cwd: "D:\\Work" },
      new Error("Bearer very-secret-token")
    );

    const [entry] = tracker.getRecent("session");
    assert.strictEqual(entry.status, "error");
    assert.strictEqual(entry.tool, "command_run");
    assert.ok(entry.preview);
    assert.ok(!entry.preview!.includes("very-secret-token"));
  });

  it("clears only the requested session", () => {
    const tracker = new ProvenanceTracker();
    tracker.recordResult(
      "a",
      "system_info",
      {},
      { content: [{ type: "text", text: "a" }] }
    );
    tracker.recordResult(
      "b",
      "system_info",
      {},
      { content: [{ type: "text", text: "b" }] }
    );

    tracker.clearSession("a");
    assert.deepStrictEqual(tracker.getRecent("a"), []);
    assert.strictEqual(tracker.getRecent("b").length, 1);
  });
});
