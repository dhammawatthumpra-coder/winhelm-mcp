import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ApprovalEngine,
  ApprovalEngineError,
  type RecoverableApprovalJob,
} from "../../src/approval/approval-engine.js";
import { ApprovalJournal } from "../../src/approval/journal.js";
import {
  getApprovalEngine,
  initializeApprovalPersistence,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import { formatApprovalJobStatus } from "../../src/approval/tool-flow.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { defaultApprovalJournalPath } from "../../src/approval/journal.js";

async function withTempDir(
  prefix: string,
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    resetApprovalEngine();
    ConfigManager.resetInstance();
  }
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function fixtureJob(
  overrides: Partial<RecoverableApprovalJob> = {}
): RecoverableApprovalJob {
  const now = Date.now();
  return {
    id: `job_${crypto.randomUUID()}`,
    tool: "http_request",
    args: { url: "https://example.com/action" },
    fingerprint: "fixture-fingerprint",
    sessionId: "session-a",
    createdAt: now,
    expiresAt: now + 180_000,
    updatedAt: now,
    state: "awaiting_approval",
    executionCount: 0,
    ...overrides,
  };
}

describe("Approval journal persistence", () => {
  it("treats a missing journal as a clean first run", async () => {
    await withTempDir("winhelm-journal-missing-", async (dir) => {
      const journal = new ApprovalJournal(
        path.join(dir, "approval-jobs.json")
      );

      const loaded = journal.load();
      assert.deepStrictEqual(loaded.jobs, []);
      assert.strictEqual(loaded.integrityFailure, null);
      assert.strictEqual(loaded.quarantinedPath, null);
    });
  });

  it("quarantines a corrupt journal instead of assuming there were no jobs", async () => {
    await withTempDir("winhelm-journal-corrupt-", async (dir) => {
      const filePath = path.join(dir, "approval-jobs.json");
      await fsp.writeFile(filePath, "{not-json", "utf8");

      const journal = new ApprovalJournal(filePath);
      const loaded = journal.load();

      assert.strictEqual(loaded.integrityFailure, "corrupt");
      assert.deepStrictEqual(loaded.jobs, []);
      assert.ok(loaded.quarantinedPath);
      assert.strictEqual(fs.existsSync(filePath), false);
      assert.strictEqual(
        fs.readFileSync(loaded.quarantinedPath!, "utf8"),
        "{not-json"
      );
    });
  });

  it("quarantines a snapshot with an untrusted shape", async () => {
    await withTempDir("winhelm-journal-shape-", async (dir) => {
      const filePath = path.join(dir, "approval-jobs.json");
      await fsp.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          jobs: [{ id: "job_x", state: "not-a-state" }],
        }),
        "utf8"
      );

      const loaded = new ApprovalJournal(filePath).load();
      assert.strictEqual(loaded.integrityFailure, "corrupt");
      assert.ok(loaded.quarantinedPath);
    });
  });

  it("reports an unreadable journal as an integrity failure", async () => {
    await withTempDir("winhelm-journal-unreadable-", async (dir) => {
      const filePath = path.join(dir, "approval-jobs.json");
      await fsp.mkdir(filePath, { recursive: true });

      const loaded = new ApprovalJournal(filePath).load();
      assert.strictEqual(loaded.integrityFailure, "unreadable");
      assert.deepStrictEqual(loaded.jobs, []);
    });
  });

  it("refuses new approval jobs when journal integrity failed, while status stays readable", async () => {
    await withTempDir("winhelm-journal-failclosed-", async (dir) => {
      const filePath = path.join(dir, "approval-jobs.json");
      await fsp.writeFile(filePath, "corrupt", "utf8");

      const status = initializeApprovalPersistence(filePath);
      assert.strictEqual(status.integrityFailure, "corrupt");

      const engine = getApprovalEngine();
      assert.throws(
        () =>
          engine.request({
            tool: "file_write",
            args: { path: "D:\\x.txt", content: "y" },
            sessionId: "session-a",
            ttlMs: 1_000,
            maxPending: 5,
            execute: async () => "never",
          }),
        (err: any) =>
          err instanceof ApprovalEngineError &&
          err.code === "JOURNAL_INTEGRITY_FAILED"
      );
      assert.deepStrictEqual(engine.list(), []);
    });
  });

  it("never exposes or persists the raw client idempotency key, but still resolves it", async () => {
    await withTempDir("winhelm-journal-idem-", async (dir) => {
      const filePath = path.join(dir, "approval-jobs.json");
      const journal = new ApprovalJournal(filePath);
      const engine = new ApprovalEngine({
        persist: (job) => journal.persist(job),
      });

      const rawKey = "client-secret-idempotency-value";
      const created = engine.request({
        tool: "http_request",
        args: { url: "https://example.com", idempotencyKey: rawKey },
        sessionId: "session-a",
        ttlMs: 180_000,
        maxPending: 5,
        execute: async () => "done",
      });

      const visible = engine.get(created.job.id)!;
      assert.strictEqual(visible.args.idempotencyKey, undefined);
      assert.strictEqual(
        Object.keys(visible.args).some(
          (key) => key.toLowerCase() === "idempotencykey"
        ),
        false
      );
      assert.strictEqual(
        JSON.stringify(engine.list()).includes(rawKey),
        false
      );

      const onDisk = fs.readFileSync(filePath, "utf8");
      assert.strictEqual(onDisk.includes(rawKey), false);
      assert.ok(onDisk.includes(digest(rawKey)));

      assert.strictEqual(
        engine.findForSessionByIdempotencyKey(rawKey, "session-a")?.id,
        created.job.id
      );

      // The digest, not the raw key, is what makes lookups survive a restart.
      const restarted = initializeApprovalPersistence(filePath);
      assert.strictEqual(restarted.integrityFailure, null);
      assert.strictEqual(
        getApprovalEngine().findForSessionByIdempotencyKey(
          rawKey,
          "session-a"
        )?.id,
        created.job.id
      );
    });
  });

  it("restores interrupted jobs as unknown and never re-runs them", async () => {
    await withTempDir("winhelm-journal-restart-", async (dir) => {
      const filePath = path.join(dir, "approval-jobs.json");
      const journal = new ApprovalJournal(filePath);

      const awaiting = fixtureJob({
        state: "awaiting_approval",
        fingerprint: "fp-awaiting",
      });
      const approved = fixtureJob({
        state: "approved",
        fingerprint: "fp-approved",
      });
      const running = fixtureJob({
        state: "running",
        executionCount: 1,
        fingerprint: "fp-running",
      });
      const completed = fixtureJob({
        state: "completed",
        executionCount: 1,
        result: { ok: true },
        fingerprint: "fp-completed",
      });

      journal.persist(awaiting);
      journal.persist(approved);
      journal.persist(running);
      journal.persist(completed);

      const status = initializeApprovalPersistence(filePath);
      assert.strictEqual(status.recoveredJobs, 4);
      assert.strictEqual(status.unknownRecoveredJobs, 3);

      const engine = getApprovalEngine();
      for (const job of [awaiting, approved, running]) {
        const restored = engine.get(job.id)!;
        assert.strictEqual(restored.state, "unknown");
        assert.ok(restored.error);

        // A recovered job is terminal: it can never be approved into running.
        const late = engine.approve(job.id);
        assert.strictEqual(late.ok, false);
        if (!late.ok) assert.strictEqual(late.status, 409);

        const formatted = formatApprovalJobStatus(restored);
        assert.strictEqual(formatted.isError, true);
        assert.strictEqual(
          JSON.parse(formatted.content[0].text).error.code,
          "APPROVAL_UNKNOWN"
        );
      }

      const restoredCompleted = engine.get(completed.id)!;
      assert.strictEqual(restoredCompleted.state, "completed");
      assert.deepStrictEqual(restoredCompleted.result, { ok: true });
    });
  });

  it("dedupes a retry after restart instead of executing it twice", async () => {
    await withTempDir("winhelm-journal-dedupe-", async (dir) => {
      const filePath = path.join(dir, "approval-jobs.json");
      const journal = new ApprovalJournal(filePath);
      const first = new ApprovalEngine({
        persist: (job) => journal.persist(job),
      });

      let executions = 0;
      const created = first.request({
        tool: "http_request",
        args: { url: "https://example.com/action", method: "POST" },
        sessionId: "session-a",
        ttlMs: 180_000,
        maxPending: 5,
        execute: async () => {
          executions += 1;
          return "done";
        },
      });
      assert.strictEqual(first.approve(created.job.id).ok, true);
      const terminal = await first.waitForTerminalOrReceipt(
        created.job.id,
        1_000
      );
      assert.strictEqual(terminal.kind, "terminal");
      assert.strictEqual(terminal.job.state, "completed");
      assert.strictEqual(executions, 1);

      initializeApprovalPersistence(filePath);
      const restarted = getApprovalEngine();

      const retry = restarted.request({
        tool: "http_request",
        args: { method: "POST", url: "https://example.com/action" },
        sessionId: "session-a",
        ttlMs: 180_000,
        maxPending: 5,
        execute: async () => {
          executions += 1;
          return "duplicate";
        },
      });

      assert.strictEqual(retry.kind, "recent_equivalent");
      assert.strictEqual(retry.job.id, created.job.id);
      assert.strictEqual(executions, 1);

      const otherSession = restarted.request({
        tool: "http_request",
        args: { url: "https://example.com/action", method: "POST" },
        sessionId: "session-b",
        ttlMs: 180_000,
        maxPending: 5,
        execute: async () => {
          executions += 1;
          return "duplicate";
        },
      });
      assert.strictEqual(otherSession.kind, "recent_equivalent");
      assert.strictEqual(executions, 1);
    });
  });

  it("does not queue a job when the journal write fails at request time", async () => {
    await withTempDir("winhelm-journal-request-fail-", async (dir) => {
      const engine = new ApprovalEngine({
        persist: () => {
          throw new Error("journal disk unavailable");
        },
      });

      assert.throws(
        () =>
          engine.request({
            tool: "http_request",
            args: { url: "https://example.com" },
            sessionId: "session-a",
            ttlMs: 1_000,
            maxPending: 5,
            execute: async () => "never",
          }),
        (err: any) =>
          err instanceof ApprovalEngineError &&
          err.code === "JOURNAL_UNAVAILABLE"
      );
      assert.deepStrictEqual(engine.list(), []);
    });
  });

  it("refuses to execute when the pre-execution journal write fails", async () => {
    await withTempDir("winhelm-journal-execute-fail-", async (dir) => {
      let writes = 0;
      let executions = 0;
      const engine = new ApprovalEngine({
        persist: () => {
          writes += 1;
          // request + approved persist succeed; the pre-execution
          // `running` claim cannot be recorded.
          if (writes >= 3) throw new Error("journal disk unavailable");
        },
      });

      const created = engine.request({
        tool: "file_write",
        args: { path: "D:\\x.txt", content: "hello" },
        sessionId: "session-a",
        ttlMs: 180_000,
        maxPending: 5,
        execute: async () => {
          executions += 1;
          return "written";
        },
      });

      const approved = engine.approve(created.job.id);
      assert.strictEqual(approved.ok, false);
      if (!approved.ok) {
        assert.strictEqual(approved.status, 503);
        assert.strictEqual(approved.code, "JOURNAL_UNAVAILABLE");
      }

      assert.strictEqual(executions, 0);
      assert.strictEqual(engine.get(created.job.id)!.state, "unknown");
    });
  });

  it("keeps the default journal inside the protected WinHelm data path", async () => {
    await withTempDir("winhelm-journal-protected-", async (dir) => {
      const configFile = path.join(dir, "config.json");
      await fsp.writeFile(
        configFile,
        JSON.stringify({
          schemaVersion: 2,
          profilePreset: "balanced",
          folders: [],
          terminal: { mode: "ask" },
          toolPolicy: {},
        }),
        "utf8"
      );

      const manager = ConfigManager.resetInstance(configFile);
      await manager.init(configFile);

      const journalPath = defaultApprovalJournalPath();
      assert.strictEqual(
        journalPath.startsWith(path.join(os.homedir(), ".winhelm")),
        true
      );

      const write = manager.checkPathAccess(journalPath, "write");
      assert.strictEqual(write.allowed, false);
      const read = manager.checkPathAccess(journalPath, "read");
      assert.strictEqual(read.allowed, false);
    });
  });
});
