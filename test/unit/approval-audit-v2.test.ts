import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ApprovalEngine,
  type ApprovalJob,
} from "../../src/approval/approval-engine.js";
import {
  logApprovalDecision,
  type ApprovalDecision,
} from "../../src/approval/audit.js";
import {
  getApprovalEngine,
  initializeApprovalPersistence,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import { auditLogger, type AuditEvent } from "../../src/utils/audit-logger.js";

interface DecisionRecord {
  job: ApprovalJob;
  decision: ApprovalDecision;
  channel: string;
}

function createJob(engine: ApprovalEngine, sessionId = "audit-session") {
  return engine.request({
    tool: "screen_capture",
    // The marker keeps every fixture on its own retry fingerprint.
    args: { note: "arg-secret-token-value", marker: sessionId },
    sessionId,
    ttlMs: 30_000,
    maxPending: 5,
    execute: async () => ({ content: [] }),
  });
}

async function withAuditSpy<T>(
  fn: (events: AuditEvent[]) => Promise<T> | T
): Promise<T> {
  const events: AuditEvent[] = [];
  const original = auditLogger.log.bind(auditLogger);
  (auditLogger as any).log = (event: AuditEvent) => {
    events.push(event);
  };
  try {
    return await fn(events);
  } finally {
    (auditLogger as any).log = original;
  }
}

describe("Approval decision audit", () => {
  it("emits one decision per terminal outcome with the decision latency", () => {
    let now = 1_000;
    const records: DecisionRecord[] = [];
    const engine = new ApprovalEngine({
      now: () => now,
      onDecision: (job, decision, channel) =>
        records.push({ job, decision, channel }),
    });

    const approved = createJob(engine, "session-approve");
    now += 1_500;
    assert.strictEqual(
      engine.approve(approved.job.id, "dashboard").ok,
      true
    );

    const denied = createJob(engine, "session-deny");
    now += 250;
    assert.strictEqual(engine.deny(denied.job.id, "cli").ok, true);

    const expiring = createJob(engine, "session-expire");
    now += 40_000;
    assert.strictEqual(engine.get(expiring.job.id)?.state, "expired");

    const cancelled = createJob(engine, "session-cancel");
    engine.cancelSession("session-cancel");

    assert.deepStrictEqual(
      records.map((record) => [record.decision, record.channel]),
      [
        ["approved", "dashboard"],
        ["denied", "cli"],
        ["expired", "expiry"],
        ["cancelled", "session_close"],
      ]
    );

    const byId = new Map(
      records.map((record) => [record.job.id, record])
    );
    assert.strictEqual(
      byId.get(approved.job.id)!.job.updatedAt -
        byId.get(approved.job.id)!.job.createdAt,
      1_500
    );
    assert.strictEqual(
      byId.get(expiring.job.id)!.job.updatedAt -
        byId.get(expiring.job.id)!.job.createdAt,
      40_000
    );
  });

  it("does not emit for transitions that never happened", () => {
    const records: DecisionRecord[] = [];
    const engine = new ApprovalEngine({
      onDecision: (job, decision, channel) =>
        records.push({ job, decision, channel }),
    });

    const job = createJob(engine);
    assert.strictEqual(engine.deny(job.job.id).ok, true);
    // Late approval, repeat denial and a cancelled decision are conflicts.
    assert.strictEqual(engine.approve(job.job.id).ok, false);
    assert.strictEqual(engine.deny(job.job.id).ok, false);
    assert.strictEqual(engine.cancel(job.job.id).ok, false);
    // Listing re-checks expiry for every job; the decision must not repeat.
    engine.list();
    engine.get(job.job.id);

    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].decision, "denied");
  });

  it("keeps approvals working when the decision sink throws", () => {
    const engine = new ApprovalEngine({
      onDecision: () => {
        throw new Error("audit sink exploded");
      },
    });

    const job = createJob(engine);
    assert.strictEqual(engine.approve(job.job.id).ok, true);
  });

  it("records decision metadata without tool arguments", async () => {
    const job: ApprovalJob = {
      id: "job_audit",
      tool: "screen_capture",
      args: { note: "arg-secret-token-value" },
      fingerprint: "fp",
      sessionId: "raw-session-id",
      createdAt: 1_000,
      expiresAt: 60_000,
      updatedAt: 3_500,
      state: "denied",
      executionCount: 0,
    };

    await withAuditSpy((events) => {
      logApprovalDecision(job, "denied", {
        channel: "dashboard",
        ip: "127.0.0.1",
        authType: "session_cookie",
      });

      assert.strictEqual(events.length, 1);
      const event = events[0];
      assert.strictEqual(event.event, "APPROVAL_DECISION");
      assert.strictEqual(event.outcome, "DENIED");
      assert.strictEqual(event.severity, "WARN");
      assert.strictEqual(event.resource, "screen_capture");
      assert.strictEqual(event.actor.ip, "127.0.0.1");
      assert.strictEqual(event.actor.sessionId, "raw-session-id");
      assert.strictEqual(event.action, "dashboard denied");

      const details = event.details as Record<string, unknown>;
      assert.strictEqual(details.decision, "denied");
      assert.strictEqual(details.channel, "dashboard");
      assert.strictEqual(details.latencyMs, 2_500);
      assert.strictEqual(details.tool, "screen_capture");
      assert.strictEqual(details.jobId, "job_audit");
      assert.strictEqual(details.riskClass, "R3");
      assert.strictEqual(
        JSON.stringify(event).includes("arg-secret-token-value"),
        false,
        "tool arguments must never reach the audit log"
      );
    });

    await withAuditSpy((events) => {
      logApprovalDecision({ ...job, state: "approved" }, "approved", {
        channel: "cli",
      });
      assert.strictEqual(events[0].outcome, "ALLOWED");
      assert.strictEqual(events[0].severity, "INFO");
    });
  });

  it("wires the audit sink only when the production bootstrap enables it", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-audit-wiring-")
    );
    const journalPath = path.join(dir, "approval-jobs.json");
    const seen: string[] = [];

    try {
      initializeApprovalPersistence(journalPath, {
        auditDecisions: true,
        decisionSink: (_job, decision) => {
          seen.push(decision);
        },
      });
      const created = createJob(getApprovalEngine(), "wired-session");
      getApprovalEngine().deny(created.job.id, "dashboard");
      assert.deepStrictEqual(seen, ["denied"]);

      initializeApprovalPersistence(journalPath);
      seen.length = 0;
      const silent = createJob(getApprovalEngine(), "silent-session");
      getApprovalEngine().deny(silent.job.id);
      assert.deepStrictEqual(seen, []);
    } finally {
      resetApprovalEngine();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
