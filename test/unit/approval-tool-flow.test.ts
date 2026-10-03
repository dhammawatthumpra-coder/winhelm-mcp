import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalEngine } from "../../src/approval/approval-engine.js";
import {
  formatApprovalJobStatus,
  runToolWithHybridApproval,
} from "../../src/approval/tool-flow.js";

const approval = {
  channels: ["dashboard", "toast"] as const,
  blockHoldMs: 40,
  jobTtlMs: 5_000,
  maxPending: 5,
};

describe("Hybrid approval tool flow", () => {
  it("returns the original result when approved inside the hold budget", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;

    const promise = runToolWithHybridApproval({
      engine,
      tool: "http_request",
      args: { url: "https://example.com" },
      approval: approval as any,
      context: { sessionId: "session-a", requestId: 1 },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const [job] = engine.list();
    assert.ok(job);
    assert.strictEqual(engine.approve(job.id).ok, true);

    const result = await promise;
    assert.deepStrictEqual(result, {
      content: [{ type: "text", text: "ok" }],
    });
    assert.strictEqual(executions, 1);
  });

  it("returns a non-error receipt after the hold budget and executes once after later approval", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;

    const result = await runToolWithHybridApproval({
      engine,
      tool: "screen_capture",
      args: {},
      approval: {
        ...approval,
        blockHoldMs: 15,
      } as any,
      context: { sessionId: "session-a", requestId: 2 },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "captured" }] };
      },
    });

    assert.notStrictEqual(result.isError, true);
    const receipt = JSON.parse(result.content[0].text);
    assert.strictEqual(receipt.status, "awaiting_approval");
    assert.match(receipt.jobId, /^job_/);
    assert.strictEqual(executions, 0);

    assert.strictEqual(engine.approve(receipt.jobId).ok, true);
    const terminal = await engine.waitForTerminalOrReceipt(receipt.jobId, 500);
    assert.strictEqual(terminal.kind, "terminal");
    assert.strictEqual(terminal.job.state, "completed");
    assert.strictEqual(executions, 1);

    const status = formatApprovalJobStatus(
      engine.getForSession(receipt.jobId, "session-a")
    );
    const parsed = JSON.parse(status.content[0].text);
    assert.strictEqual(parsed.status, "completed");
    assert.deepStrictEqual(parsed.result, {
      content: [{ type: "text", text: "captured" }],
    });
  });

  it("returns permission denied without executing when the user denies during the hold", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;

    const promise = runToolWithHybridApproval({
      engine,
      tool: "process_kill",
      args: { pid: 123 },
      approval: approval as any,
      context: { sessionId: "session-a", requestId: 3 },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "killed" }] };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const [job] = engine.list();
    assert.strictEqual(engine.deny(job.id).ok, true);

    const result = await promise;
    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.error.code, "APPROVAL_DENIED");
    assert.strictEqual(executions, 0);
  });

  it("recovers a completed same-session retry without executing twice", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;

    const firstPromise = runToolWithHybridApproval({
      engine,
      tool: "notification_send",
      args: { title: "x", message: "y", idempotencyKey: "one" },
      approval: approval as any,
      context: { sessionId: "session-a", requestId: 4 },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "sent" }] };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const [job] = engine.list();
    engine.approve(job.id);
    const first = await firstPromise;
    assert.strictEqual(first.content[0].text, "sent");

    const retry = await runToolWithHybridApproval({
      engine,
      tool: "notification_send",
      args: { message: "y", title: "x", idempotencyKey: "changed" },
      approval: approval as any,
      context: { sessionId: "session-a", requestId: 5 },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "duplicate" }] };
      },
    });

    assert.strictEqual(retry.content[0].text, "sent");
    assert.strictEqual(executions, 1);
  });

  it("fails closed on equivalent retry from another session without exposing the existing jobId", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;

    const firstPromise = runToolWithHybridApproval({
      engine,
      tool: "http_request",
      args: { url: "https://example.com/action", method: "POST" },
      approval: approval as any,
      context: { sessionId: "session-a", requestId: 6 },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "done" }] };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const [job] = engine.list();
    engine.approve(job.id);
    await firstPromise;

    const retry = await runToolWithHybridApproval({
      engine,
      tool: "http_request",
      args: {
        method: "POST",
        url: "https://example.com/action",
        idempotencyKey: "new",
      },
      approval: approval as any,
      context: { sessionId: "session-b", requestId: 7 },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "duplicate" }] };
      },
    });

    assert.strictEqual(retry.isError, true);
    const parsed = JSON.parse(retry.content[0].text);
    assert.strictEqual(parsed.error.code, "CONFLICT");
    assert.strictEqual(parsed.error.details.state, "completed");
    assert.strictEqual(parsed.error.details.jobId, undefined);
    assert.strictEqual(executions, 1);
  });

  it("cancels the job if the originating MCP request is aborted while waiting", async () => {
    const engine = new ApprovalEngine();
    let executions = 0;
    const controller = new AbortController();

    const promise = runToolWithHybridApproval({
      engine,
      tool: "terminal_run",
      args: { command: "fixture" },
      approval: approval as any,
      context: {
        sessionId: "session-a",
        requestId: 8,
        signal: controller.signal,
      },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "ran" }] };
      },
    });

    setTimeout(() => controller.abort(), 5);
    const result = await promise;
    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.error.code, "CANCELLED");
    assert.strictEqual(executions, 0);
  });
});
