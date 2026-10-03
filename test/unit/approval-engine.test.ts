import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalEngine,
  ApprovalEngineError,
  approvalRequestFingerprint,
} from "../../src/approval/approval-engine.js";

describe("Approval request fingerprint", () => {
  it("is stable across object key order and ignores idempotencyKey", () => {
    const a = approvalRequestFingerprint("http_request", {
      url: "https://example.com",
      method: "POST",
      body: { b: 2, a: 1 },
      idempotencyKey: "key-a",
    });
    const b = approvalRequestFingerprint("http_request", {
      idempotencyKey: "key-b",
      body: { a: 1, b: 2 },
      method: "POST",
      url: "https://example.com",
    });

    assert.strictEqual(a, b);
  });

  it("changes when governed request content changes", () => {
    const a = approvalRequestFingerprint("file_write", {
      path: "D:\\a.txt",
      content: "one",
    });
    const b = approvalRequestFingerprint("file_write", {
      path: "D:\\a.txt",
      content: "two",
    });

    assert.notStrictEqual(a, b);
  });
});

describe("ApprovalEngine state machine", () => {
  it("dedupes the same pending request within a session", () => {
    const engine = new ApprovalEngine();
    const first = engine.request({
      tool: "http_request",
      args: { url: "https://example.com", idempotencyKey: "a" },
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => "first",
    });
    const second = engine.request({
      tool: "http_request",
      args: { idempotencyKey: "b", url: "https://example.com" },
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => "second",
    });

    assert.strictEqual(first.kind, "created");
    assert.strictEqual(second.kind, "deduped_pending");
    assert.strictEqual(second.job.id, first.job.id);
  });

  it("enforces maxPending before creating another unrelated job", () => {
    const engine = new ApprovalEngine();
    engine.request({
      tool: "screen_capture",
      args: {},
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 1,
      execute: async () => "screen",
    });

    assert.throws(
      () =>
        engine.request({
          tool: "http_request",
          args: { url: "https://example.com" },
          sessionId: "session-a",
          ttlMs: 180_000,
          maxPending: 1,
          execute: async () => "http",
        }),
      (err: any) =>
        err instanceof ApprovalEngineError && err.code === "LIMIT_EXCEEDED"
    );
  });

  it("executes an approved job exactly once and rejects late re-approval", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;

    const created = engine.request({
      tool: "file_write",
      args: { path: "D:\\x.txt", content: "hello" },
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => {
        executions += 1;
        return { ok: true };
      },
    });

    const approved = engine.approve(created.job.id);
    assert.strictEqual(approved.ok, true);

    const terminal = await engine.waitForTerminalOrReceipt(
      created.job.id,
      1_000
    );
    assert.strictEqual(terminal.kind, "terminal");
    assert.strictEqual(terminal.job.state, "completed");
    assert.strictEqual(terminal.job.executionCount, 1);
    assert.strictEqual(executions, 1);

    const secondApprove = engine.approve(created.job.id);
    assert.strictEqual(secondApprove.ok, false);
    if (!secondApprove.ok) {
      assert.strictEqual(secondApprove.status, 409);
      assert.strictEqual(secondApprove.code, "CONFLICT");
    }
    assert.strictEqual(executions, 1);
  });

  it("denies and expires without executing and rejects late approval", () => {
    let now = 1_000;
    let executions = 0;
    const engine = new ApprovalEngine({ now: () => now });

    const denied = engine.request({
      tool: "process_kill",
      args: { pid: 123 },
      sessionId: "session-a",
      ttlMs: 100,
      maxPending: 5,
      execute: async () => {
        executions += 1;
      },
    });
    assert.strictEqual(engine.deny(denied.job.id).ok, true);
    assert.strictEqual(engine.get(denied.job.id)?.state, "denied");
    assert.strictEqual(engine.approve(denied.job.id).ok, false);

    const expiring = engine.request({
      tool: "service_control",
      args: { service: "fixture", action: "restart" },
      sessionId: "session-a",
      ttlMs: 100,
      maxPending: 5,
      execute: async () => {
        executions += 1;
      },
    });
    now += 101;
    assert.strictEqual(engine.get(expiring.job.id)?.state, "expired");
    const late = engine.approve(expiring.job.id);
    assert.strictEqual(late.ok, false);
    if (!late.ok) assert.strictEqual(late.status, 409);
    assert.strictEqual(executions, 0);
  });

  it("cancels awaiting jobs when the owning session closes", () => {
    let executions = 0;
    const engine = new ApprovalEngine();
    const job = engine.request({
      tool: "screen_capture",
      args: {},
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => {
        executions += 1;
      },
    });

    const cancelled = engine.cancelSession("session-a");
    assert.strictEqual(cancelled.length, 1);
    assert.strictEqual(cancelled[0].state, "cancelled");
    assert.strictEqual(engine.approve(job.job.id).ok, false);
    assert.strictEqual(executions, 0);
  });

  it("lets the executor claim win once a job is running", async () => {
    const engine = new ApprovalEngine();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const created = engine.request({
      tool: "terminal_run",
      args: { command: "fixture" },
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => {
        await blocker;
        return "done";
      },
    });

    engine.approve(created.job.id);
    assert.strictEqual(engine.get(created.job.id)?.state, "running");
    assert.deepStrictEqual(engine.cancelSession("session-a"), []);

    release();
    const terminal = await engine.waitForTerminalOrReceipt(
      created.job.id,
      1_000
    );
    assert.strictEqual(terminal.kind, "terminal");
    assert.strictEqual(terminal.job.state, "completed");
    assert.strictEqual(terminal.job.executionCount, 1);
  });

  it("fails closed on equivalent retry from another session even when idempotencyKey changes", async () => {
    const engine = new ApprovalEngine({ retryRetentionMs: 60_000 });
    let executions = 0;

    const first = engine.request({
      tool: "http_request",
      args: {
        url: "https://example.com/action",
        method: "POST",
        idempotencyKey: "original",
      },
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => {
        executions += 1;
        return "done";
      },
    });
    engine.approve(first.job.id);
    const terminal = await engine.waitForTerminalOrReceipt(
      first.job.id,
      1_000
    );
    assert.strictEqual(terminal.kind, "terminal");
    assert.strictEqual(terminal.job.state, "completed");

    const retry = engine.request({
      tool: "http_request",
      args: {
        method: "POST",
        idempotencyKey: "new-key",
        url: "https://example.com/action",
      },
      sessionId: "session-b",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => {
        executions += 1;
        return "duplicate";
      },
    });

    assert.strictEqual(retry.kind, "recent_equivalent");
    assert.strictEqual(retry.job.id, first.job.id);
    assert.strictEqual(retry.job.state, "completed");
    assert.strictEqual(executions, 1);
  });

  it("allows a new equivalent job after retry retention expires", async () => {
    let now = 1_000;
    const engine = new ApprovalEngine({
      now: () => now,
      retryRetentionMs: 500,
    });

    const first = engine.request({
      tool: "notification_send",
      args: { title: "x", message: "y" },
      sessionId: "session-a",
      ttlMs: 5_000,
      maxPending: 5,
      execute: async () => "done",
    });
    engine.deny(first.job.id);

    now += 501;
    const second = engine.request({
      tool: "notification_send",
      args: { title: "x", message: "y" },
      sessionId: "session-a",
      ttlMs: 5_000,
      maxPending: 5,
      execute: async () => "new",
    });

    assert.strictEqual(second.kind, "created");
    assert.notStrictEqual(second.job.id, first.job.id);
  });

  it("enforces session ownership for status lookup", () => {
    const engine = new ApprovalEngine();
    const created = engine.request({
      tool: "http_request",
      args: { url: "https://example.com" },
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => "done",
    });

    assert.ok(engine.getForSession(created.job.id, "session-a"));
    assert.strictEqual(
      engine.getForSession(created.job.id, "session-b"),
      undefined
    );
  });

  it("returns a receipt after the hold budget without executing", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;
    const created = engine.request({
      tool: "screen_capture",
      args: {},
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => {
        executions += 1;
      },
    });

    const outcome = await engine.waitForTerminalOrReceipt(
      created.job.id,
      20
    );
    assert.strictEqual(outcome.kind, "receipt");
    assert.strictEqual(outcome.job.state, "awaiting_approval");
    assert.strictEqual(executions, 0);
  });

  it("cancels an awaiting job when the originating request is aborted", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;
    const created = engine.request({
      tool: "terminal_run",
      args: { command: "fixture" },
      sessionId: "session-a",
      ttlMs: 180_000,
      maxPending: 5,
      execute: async () => {
        executions += 1;
      },
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const outcome = await engine.waitForTerminalOrReceipt(
      created.job.id,
      1_000,
      controller.signal
    );

    assert.strictEqual(outcome.kind, "terminal");
    assert.strictEqual(outcome.job.state, "cancelled");
    assert.strictEqual(executions, 0);
  });
});
