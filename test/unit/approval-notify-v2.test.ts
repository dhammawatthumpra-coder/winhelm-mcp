import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalEngine } from "../../src/approval/approval-engine.js";
import {
  approvalJobUrl,
  notifyApprovalPending,
} from "../../src/approval/notify.js";
import { buildApprovalToastXml } from "../../src/engine/system.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  getApprovalEngine,
  initializeApprovalPersistence,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import {
  setConfiguredLocale,
  translate,
} from "../../src/i18n/messages.js";

function requestJob(engine: ApprovalEngine, sessionId = "notify-session") {
  return engine.request({
    tool: "http_request",
    args: { url: "https://example.com" },
    sessionId,
    ttlMs: 60_000,
    maxPending: 5,
    execute: async () => "done",
  });
}

describe("Approval pending notification", () => {
  it("notifies once with the job that was queued", () => {
    const seen: string[] = [];
    const engine = new ApprovalEngine({
      onCreated: (job) => seen.push(job.id),
    });

    const first = requestJob(engine);
    assert.deepStrictEqual(seen, [first.job.id]);

    // A deduped request must not notify again.
    requestJob(engine);
    assert.deepStrictEqual(seen, [first.job.id]);
  });

  it("keeps the approval flow working when the notifier throws", () => {
    const engine = new ApprovalEngine({
      onCreated: () => {
        throw new Error("toast backend exploded");
      },
    });

    const created = requestJob(engine);
    assert.strictEqual(created.kind, "created");
    assert.strictEqual(engine.list().length, 1);
  });

  it("deep links to the approvals page of the listening port", () => {
    const manager = ConfigManager.resetInstance();
    try {
      assert.strictEqual(approvalJobUrl("job_1"), undefined);

      manager.setRuntimeEffectivePort(18801);
      assert.strictEqual(
        approvalJobUrl("job_1"),
        "http://127.0.0.1:18801/approvals/job_1"
      );
      assert.strictEqual(
        approvalJobUrl("job/../evil"),
        "http://127.0.0.1:18801/approvals/job%2F..%2Fevil"
      );
    } finally {
      manager.setRuntimeEffectivePort(undefined);
      ConfigManager.resetInstance();
    }
  });

  it("sends the localized approval message and swallows backend failures", async () => {
    const manager = ConfigManager.resetInstance();
    const previousLocale = process.env.WINHELM_LOCALE;
    delete process.env.WINHELM_LOCALE;
    try {
      manager.setRuntimeEffectivePort(18802);
      setConfiguredLocale("th");

      const sent: Array<string | undefined> = [];
      await notifyApprovalPending(
        { id: "job_th" },
        {
          send: async (url) => {
            sent.push(url);
          },
        }
      );
      assert.deepStrictEqual(sent, [
        "http://127.0.0.1:18802/approvals/job_th",
      ]);

      await notifyApprovalPending(
        { id: "job_fail" },
        {
          send: async () => {
            throw new Error("toast unavailable");
          },
        }
      );
    } finally {
      manager.setRuntimeEffectivePort(undefined);
      setConfiguredLocale(undefined);
      ConfigManager.resetInstance();
      if (previousLocale === undefined) {
        delete process.env.WINHELM_LOCALE;
      } else {
        process.env.WINHELM_LOCALE = previousLocale;
      }
    }
  });
});

describe("Approval notification wiring", () => {
  it("notifies only when the production bootstrap enables it", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-notify-wiring-")
    );
    const journalPath = path.join(dir, "approval-jobs.json");
    const seen: string[] = [];

    try {
      initializeApprovalPersistence(journalPath, {
        notifyApprovals: true,
        notifier: (job) => {
          seen.push(job.id);
        },
      });
      const notified = getApprovalEngine().request({
        tool: "http_request",
        args: { url: "https://example.com/notified" },
        sessionId: "wiring-session",
        ttlMs: 60_000,
        maxPending: 5,
        execute: async () => "done",
      });
      assert.deepStrictEqual(seen, [notified.job.id]);

      // Default (tests, library callers): no desktop side effect.
      initializeApprovalPersistence(journalPath);
      seen.length = 0;
      getApprovalEngine().request({
        tool: "http_request",
        args: { url: "https://example.com/silent" },
        sessionId: "wiring-session",
        ttlMs: 60_000,
        maxPending: 5,
        execute: async () => "done",
      });
      assert.deepStrictEqual(seen, []);
    } finally {
      resetApprovalEngine();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Approval toast XML", () => {
  it("carries the approval URL in both the toast launch and the action", () => {
    const url = "http://127.0.0.1:18803/approvals/job_9";
    const xml = buildApprovalToastXml(
      "WinHelm approval required",
      "An AI action is waiting.",
      "Open WinHelm",
      url
    );

    assert.ok(xml.startsWith("<toast"));
    assert.ok(xml.includes(`activationType='protocol' launch='${url}'`));
    assert.ok(
      xml.includes(
        `<action content='Open WinHelm' activationType='protocol' arguments='${url}' />`
      )
    );
    assert.ok(xml.includes("<text>WinHelm approval required</text>"));
  });

  it("escapes every injected value", () => {
    const hostile = "http://127.0.0.1/approvals/'/><script>alert(1)</script>";
    const xml = buildApprovalToastXml(
      "title & <tag>",
      "body 'quoted'",
      "open",
      hostile
    );

    assert.ok(!xml.includes("<script>"));
    assert.ok(xml.includes("&lt;script&gt;"));
    assert.ok(xml.includes("title &amp; &lt;tag&gt;"));
    // Attribute quoting cannot be closed by the injected value.
    assert.strictEqual(
      xml.split("activationType='protocol'").length - 1,
      2
    );
  });

  it("omits the action when no deep link is available", () => {
    const xml = buildApprovalToastXml("t", "m", "open");
    assert.strictEqual(xml.includes("<actions>"), false);
    assert.strictEqual(xml.includes("activationType"), false);
  });

  it("uses catalog text for WinHelm's own notification", () => {
    const previousLocale = process.env.WINHELM_LOCALE;
    delete process.env.WINHELM_LOCALE;
    try {
      setConfiguredLocale("en");
      assert.strictEqual(
        translate("notify.approval.title"),
        "WinHelm approval required"
      );
      assert.strictEqual(
        translate("notify.approval.action"),
        "Open WinHelm"
      );

      setConfiguredLocale("th");
      assert.ok(translate("notify.approval.title").startsWith("WinHelm"));
      assert.notStrictEqual(
        translate("notify.approval.body"),
        translate("notify.approval.body", {}, "en")
      );
    } finally {
      setConfiguredLocale(undefined);
      if (previousLocale === undefined) {
        delete process.env.WINHELM_LOCALE;
      } else {
        process.env.WINHELM_LOCALE = previousLocale;
      }
    }
  });
});
