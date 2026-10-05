import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import { writeFileAtomic } from "../../src/engine/atomic-file.js";
import {
  describeCurrentSession,
  lookupFileProvenanceStatus,
  searchCurrentSessionAudit,
} from "../../src/engine/session-governance.js";
import {
  resetFileProvenanceStore,
  setFileProvenanceStoreForTesting,
} from "../../src/approval/file-provenance.js";
import {
  getProvenanceTracker,
  resetProvenanceTracker,
} from "../../src/approval/provenance.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import { StructuredToolError } from "../../src/errors/tool-error.js";

let fixtureRoot: string | null = null;

async function makeFixture(): Promise<string> {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-a3-governance-"));
  setFileProvenanceStoreForTesting(path.join(fixtureRoot, "provenance.jsonl"));
  resetFileProvenanceStore();
  const config = buildPresetConfig("balanced", {
    folders: [fixtureRoot],
    approvalMode: "smart",
  });
  const manager = ConfigManager.resetInstance();
  await manager.updateConfig(config as any, false);
  resetProvenanceTracker();
  resetApprovalEngine();
  return fixtureRoot;
}

afterEach(async () => {
  ConfigManager.resetInstance();
  resetFileProvenanceStore();
  setFileProvenanceStoreForTesting(undefined);
  resetProvenanceTracker();
  resetApprovalEngine();
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    fixtureRoot = null;
  }
});

function sha256Of(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("A3 session_current", () => {
  it("reports the calling session identity with transport and permission context", async () => {
    await makeFixture();
    const identity = describeCurrentSession("local-process-424242");

    assert.strictEqual(identity.session_id, "local-process-424242");
    assert.strictEqual(identity.client_info.transport, "stdio");
    assert.strictEqual(identity.process_id, process.pid);
    assert.ok(!Number.isNaN(Date.parse(identity.started_at_utc)));
    assert.strictEqual(identity.profile_preset, "balanced");
    assert.strictEqual(identity.terminal_mode, "full");

    const httpIdentity = describeCurrentSession("gateway-session-1");
    assert.strictEqual(httpIdentity.client_info.transport, "http");
    assert.strictEqual(httpIdentity.session_id, "gateway-session-1");
  });

  it("falls back to the local-process session key without a transport session", async () => {
    await makeFixture();
    const identity = describeCurrentSession(undefined);
    assert.strictEqual(identity.session_id, `local-process-${process.pid}`);
  });
});

describe("A3 session_audit_search", () => {
  it("projects only the current session's provenance events", async () => {
    await makeFixture();
    const tracker = getProvenanceTracker();
    tracker.recordResult("current-session", "file_write_atomic", { path: "D:/x/a.txt" }, {
      content: [{ type: "text", text: "ok" }],
    });
    tracker.recordResult("other-session", "file_delete_safe", { path: "D:/x/b.txt" }, {
      content: [{ type: "text", text: "ok" }],
    });

    const result = searchCurrentSessionAudit({}, "current-session");
    assert.strictEqual(result.session_id, "current-session");
    assert.strictEqual(result.events.length, 1);
    assert.strictEqual(result.events[0].tool, "file_write_atomic");
    assert.strictEqual(result.events[0].action, "modify");
    for (const event of result.events) {
      assert.strictEqual(event.session_id, "current-session");
    }
  });

  it("filters by action, time bounds, and limit", async () => {
    await makeFixture();
    const tracker = getProvenanceTracker();
    const now = Date.now();
    tracker.recordResult("s", "file_create_exclusive", { path: "p" }, {
      content: [{ type: "text", text: "ok" }],
    }, "completed", now - 5_000);
    tracker.recordResult("s", "file_write_atomic", { path: "p" }, {
      content: [{ type: "text", text: "ok" }],
    }, "completed", now - 1_000);
    tracker.recordResult("s", "file_hash", { path: "p" }, {
      content: [{ type: "text", text: "ok" }],
    }, "completed", now);

    const created = searchCurrentSessionAudit(
      { actions: ["create"] },
      "s"
    );
    assert.strictEqual(created.events.length, 1);
    assert.strictEqual(created.events[0].tool, "file_create_exclusive");

    const recent = searchCurrentSessionAudit(
      { since_utc: new Date(now - 2_000).toISOString() },
      "s"
    );
    assert.strictEqual(recent.events.length, 2);

    const limited = searchCurrentSessionAudit({ limit: 2 }, "s");
    assert.strictEqual(limited.events.length, 2);
    assert.strictEqual(limited.total_events, 3, "total counts the full projection");
    assert.ok(
      limited.events[0].timestamp_utc >= limited.events[1].timestamp_utc,
      "events are ordered newest first"
    );
    const capped = searchCurrentSessionAudit({ limit: 0 }, "s");
    assert.deepStrictEqual(capped.events, []);
  });

  it("includes only this session's approval decisions", async () => {
    await makeFixture();
    const engine = getApprovalEngine();
    const created = engine.request({
      tool: "terminal_run",
      args: { command: "Write-Output x" },
      sessionId: "approver-session",
      ttlMs: 30_000,
      maxPending: 5,
      execute: async () => ({}),
    });
    assert.strictEqual(created.kind, "created");
    if (created.kind !== "created") return;
    const approved = engine.approve(created.job.id, "dashboard");
    assert.ok(approved.ok);

    const events = searchCurrentSessionAudit(
      { actions: ["approve"] },
      "approver-session"
    );
    assert.strictEqual(events.events.length, 1);
    assert.strictEqual(events.events[0].action, "approve");
    assert.strictEqual(events.events[0].tool, "terminal_run");

    const isolated = searchCurrentSessionAudit(
      { actions: ["approve", "deny"] },
      "different-session"
    );
    assert.strictEqual(isolated.events.length, 0);
  });

  it("rejects invalid ISO time bounds", async () => {
    await makeFixture();
    assert.throws(
      () => searchCurrentSessionAudit({ since_utc: "not-a-time" }, "s"),
      (err: unknown) =>
        err instanceof StructuredToolError && err.code === "TIME_RANGE_INVALID"
    );
  });
});

describe("A3 file_provenance_lookup", () => {
  it("reports WINHELM_VERIFIED for content matching the last governed outcome", async () => {
    const root = await makeFixture();
    const target = path.join(root, "verified.txt");
    await writeFileAtomic({ path: target, content: "verified-body\n" }, "producer-session");

    const result = await lookupFileProvenanceStatus({ path: target }, "reviewer-session");
    assert.strictEqual(result.provenance_status, "WINHELM_VERIFIED");
    assert.strictEqual(result.total_attributions, 1);
    assert.strictEqual(result.last_mutation?.session_id, "producer-session");
    assert.strictEqual(result.last_mutation?.action, "create");
    assert.strictEqual(result.last_mutation?.after_sha256, sha256Of("verified-body\n"));
    assert.strictEqual(result.history[0].session_id, "producer-session");
  });

  it("reports UNATTRIBUTED_EXTERNAL_CHANGE after an external edit", async () => {
    const root = await makeFixture();
    const target = path.join(root, "externally-edited.txt");
    await writeFileAtomic({ path: target, content: "original\n" }, "producer-session");
    await fs.writeFile(target, "externally-overwritten\n", "utf8");

    const result = await lookupFileProvenanceStatus({ path: target }, "reviewer-session");
    assert.strictEqual(result.provenance_status, "UNATTRIBUTED_EXTERNAL_CHANGE");
  });

  it("reports NO_WINHELM_PROVENANCE for files never governed by WinHelm", async () => {
    const root = await makeFixture();
    const target = path.join(root, "foreign.txt");
    await fs.writeFile(target, "never-touched\n", "utf8");

    const result = await lookupFileProvenanceStatus({ path: target }, "reviewer-session");
    assert.strictEqual(result.provenance_status, "NO_WINHELM_PROVENANCE");
    assert.strictEqual(result.total_attributions, 0);
    assert.strictEqual(result.last_mutation, null);
  });

  it("reports FILE_DELETED with deleted-target authorization via the containing root", async () => {
    const root = await makeFixture();
    const target = path.join(root, "vanished.txt");
    await writeFileAtomic({ path: target, content: "soon-gone\n" }, "producer-session");
    await fs.rm(target);

    const result = await lookupFileProvenanceStatus({ path: target }, "reviewer-session");
    assert.strictEqual(result.provenance_status, "FILE_DELETED");
    assert.strictEqual(result.total_attributions, 1);
  });

  it("keeps the projection path-scoped and free of store exposure", async () => {
    const root = await makeFixture();
    const target = path.join(root, "scoped.txt");
    const other = path.join(root, "other.txt");
    await writeFileAtomic({ path: target, content: "scoped\n" }, "producer-session");
    await writeFileAtomic({ path: other, content: "other\n" }, "producer-session");

    const result = await lookupFileProvenanceStatus({ path: target }, "reviewer-session");
    assert.strictEqual(result.total_attributions, 1);
    assert.deepStrictEqual(
      result.history.map((entry) => entry.after_sha256),
      [sha256Of("scoped\n")]
    );
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("provenance.jsonl"), "store location never leaks");
    assert.ok(!serialized.includes(path.basename(other)), "other paths never leak");
  });

  it("denies lookups outside configured folders and rejects an unknown path filter", async () => {
    const root = await makeFixture();
    const outside = path.join(path.dirname(root), "outside-secret.txt");

    await assert.rejects(
      lookupFileProvenanceStatus({ path: outside }, "reviewer-session"),
      (err: unknown) => err instanceof StructuredToolError
    );

    await assert.rejects(
      lookupFileProvenanceStatus({ path: "" }, "reviewer-session"),
      (err: unknown) =>
        err instanceof StructuredToolError && err.code === "PATH_INVALID"
    );
  });

  it("respects the actions filter and limit on history", async () => {
    const root = await makeFixture();
    const target = path.join(root, "multi.txt");
    await writeFileAtomic({ path: target, content: "v1\n" }, "producer-session");
    await writeFileAtomic({ path: target, content: "v2\n" }, "producer-session");
    await writeFileAtomic({ path: target, content: "v3\n" }, "producer-session");

    const limited = await lookupFileProvenanceStatus(
      { path: target, limit: 2 },
      "reviewer-session"
    );
    assert.strictEqual(limited.total_attributions, 2);
    assert.strictEqual(limited.history.length, 2);
    assert.strictEqual(limited.last_mutation?.after_sha256, sha256Of("v3\n"));
    assert.deepStrictEqual(
      limited.history.map((entry) => entry.after_sha256),
      [sha256Of("v2\n"), sha256Of("v3\n")]
    );
  });
});
