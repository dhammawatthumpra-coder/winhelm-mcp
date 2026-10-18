import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSanitizedApprovalSummary,
  sanitizeTargetSummary,
} from "../../src/approval/display-schema.js";
import {
  buildApprovalToastXml,
  type ToastActionItem,
  type ApprovalNotificationPayload,
} from "../../src/engine/system.js";
import {
  notifyApprovalPending,
  approvalJobUrl,
} from "../../src/approval/notify.js";
import { ApprovalEngine } from "../../src/approval/approval-engine.js";

describe("Phase 1: Native Notification Presentation — Display Schema & Sanitization", () => {
  it("sanitizes long filesystem paths cleanly with ellipsis", () => {
    const longPath = "D:\\very\\long\\deeply\\nested\\directory\\structure\\with\\many\\folders\\that\\exceed\\normal\\limits\\document.txt";
    const target = sanitizeTargetSummary("file_write", { path: longPath });
    assert.ok(target);
    assert.ok(target.length <= 70);
    assert.ok(target.includes("..."));
    assert.ok(target.startsWith("D:\\very\\long"));
    assert.ok(target.endsWith("document.txt"));
  });

  it("redacts sensitive command-line parameters from target summary", () => {
    const sensitiveCmd = "powershell.exe -Password MySecretPassword123 -File test.ps1";
    const target = sanitizeTargetSummary("powershell_exec", { command: sensitiveCmd });
    assert.ok(target);
    assert.ok(target.includes("[REDACTED]"));
    assert.ok(!target.includes("MySecretPassword123"));
  });

  it("strips query parameters and user credentials from URLs", () => {
    const sensitiveUrl = "https://user:pass@api.internal.local/v1/resource?token=secretToken12345&foo=bar";
    const target = sanitizeTargetSummary("http_request", { url: sensitiveUrl });
    assert.ok(target);
    assert.ok(!target.includes("secretToken12345"));
    assert.ok(!target.includes("pass"));
    assert.strictEqual(target, "https://api.internal.local/v1/resource");
  });

  it("formats sanitized summary with bounded lengths", () => {
    const job = {
      id: "job_test-123",
      tool: "file_write",
      args: {
        path: "C:\\projects\\app\\config.json",
        content: "Super secret file contents that should never be in notification",
      },
    };

    const summary = formatSanitizedApprovalSummary(job, {
      clientName: "Claude Desktop",
    });

    assert.strictEqual(summary.jobId, "job_test-123");
    assert.strictEqual(summary.tool, "file_write");
    assert.ok(summary.title.length <= 64);
    assert.ok(summary.body.length <= 256);
    assert.ok(summary.body.includes("Target: C:\\projects\\app\\config.json"));
    assert.ok(summary.body.includes("Client: Claude Desktop"));
    // File content must never leak into body
    assert.ok(!summary.body.includes("Super secret file contents"));
  });

  it("highlights Mandatory Confirmation in title and body", () => {
    const job = {
      id: "job_mandatory-456",
      tool: "process_kill",
      args: { processId: 9999 },
    };

    const summary = formatSanitizedApprovalSummary(job, {
      isMandatoryConfirmation: true,
    });

    assert.ok(summary.isMandatoryConfirmation);
    assert.ok(summary.title.startsWith("[MANDATORY]"));
    assert.ok(summary.body.includes("Requires explicit confirmation."));
    assert.ok(summary.body.includes("PID: 9999"));
  });
});

describe("Phase 1: Native Notification Presentation — Toast XML & Action Buttons", () => {
  it("renders Approve, Deny, and Review action buttons in Toast XML", () => {
    const actions: ToastActionItem[] = [
      {
        content: "Approve",
        arguments: "winhelm-approval:decide?jobId=job_789&decision=approved",
        activationType: "protocol",
      },
      {
        content: "Deny",
        arguments: "winhelm-approval:decide?jobId=job_789&decision=denied",
        activationType: "protocol",
      },
      {
        content: "Review in Dashboard",
        arguments: "http://127.0.0.1:8788/approvals/job_789",
        activationType: "protocol",
      },
    ];

    const xml = buildApprovalToastXml(
      "WinHelm Approval: file_write",
      "Target: D:\\test.txt\nRisk: MEDIUM",
      "Review",
      "http://127.0.0.1:8788/approvals/job_789",
      true,
      actions
    );

    assert.ok(xml.includes("<action content='Approve' activationType='protocol' arguments='winhelm-approval:decide?jobId=job_789&amp;decision=approved' />"));
    assert.ok(xml.includes("<action content='Deny' activationType='protocol' arguments='winhelm-approval:decide?jobId=job_789&amp;decision=denied' />"));
    assert.ok(xml.includes("<action content='Review in Dashboard' activationType='protocol' arguments='http://127.0.0.1:8788/approvals/job_789' />"));
  });

  it("safely escapes hostile characters in action arguments and message", () => {
    const hostileActions: ToastActionItem[] = [
      {
        content: "Approve & Continue",
        arguments: "winhelm-approval:decide?jobId='><script>bad()</script>",
        activationType: "protocol",
      },
    ];

    const xml = buildApprovalToastXml(
      "Title <unsafe>",
      "Message with 'quotes' & \"double\"",
      "Open",
      undefined,
      false,
      hostileActions
    );

    assert.ok(!xml.includes("<script>"));
    assert.ok(xml.includes("&lt;script&gt;"));
    assert.ok(xml.includes("Title &lt;unsafe&gt;"));
    assert.ok(xml.includes("&amp; Continue"));
  });
});

describe("Phase 1: Native Notification Presentation — notifyApprovalPending Integration", () => {
  it("formats rich payload and binds unique jobId when job has tool information", async () => {
    let capturedUrl: string | undefined;
    let capturedPayload: ApprovalNotificationPayload | undefined;

    const mockSend = async (
      url?: string,
      payload?: ApprovalNotificationPayload
    ) => {
      capturedUrl = url;
      capturedPayload = payload;
    };

    await notifyApprovalPending(
      {
        id: "job_integ_001",
        tool: "file_write",
        args: { path: "D:\\test\\output.log" },
      },
      {
        send: mockSend,
        meta: { clientName: "Cursor IDE" },
        activationToken: "tok_test_123",
      }
    );

    assert.ok(capturedUrl?.includes("job_integ_001"));
    assert.ok(capturedPayload);
    assert.strictEqual(capturedPayload.title, "WinHelm Approval: file_write");
    assert.ok(capturedPayload.message?.includes("Target: D:\\test\\output.log"));
    assert.ok(capturedPayload.message?.includes("Client: Cursor IDE"));
    assert.strictEqual(capturedPayload.actions?.length, 3);
    assert.ok(capturedPayload.actions[0].arguments.includes("job_integ_001"));
    assert.ok(capturedPayload.actions[0].arguments.includes("decision=approved"));
    assert.ok(capturedPayload.actions[0].arguments.includes("&token=tok_test_123"));
    assert.ok(capturedPayload.actions[1].arguments.includes("decision=denied"));
    assert.ok(capturedPayload.actions[1].arguments.includes("&token=tok_test_123"));
  });

  it("omits direct Approve/Deny buttons when activationToken is not provided", async () => {
    let capturedPayload: ApprovalNotificationPayload | undefined;
    await notifyApprovalPending(
      {
        id: "job_no_token_001",
        tool: "file_write",
        args: { path: "D:\\test\\output.log" },
      },
      {
        send: async (_url, payload) => {
          capturedPayload = payload;
        },
      }
    );

    assert.ok(capturedPayload);
    assert.strictEqual(capturedPayload.actions?.length, 1);
    assert.strictEqual(capturedPayload.actions[0].content, "Review in Dashboard");
  });

  it("ensures notification backend failure does not throw or corrupt engine state", async () => {
    const engine = new ApprovalEngine();
    const outcome = engine.request({
      tool: "file_write",
      args: { path: "D:\\safe\\target.txt" },
      sessionId: "test-session",
      ttlMs: 60_000,
      maxPending: 5,
      execute: async () => "ok",
    });

    assert.strictEqual(outcome.kind, "created");
    const job = outcome.job;

    // Call notifyApprovalPending with a backend that explodes
    await assert.doesNotReject(async () => {
      await notifyApprovalPending(job, {
        send: async () => {
          throw new Error("Simulated Windows notification subsystem crash");
        },
      });
    });

    // The job must still be awaiting_approval and approvable
    assert.strictEqual(engine.get(job.id)?.state, "awaiting_approval");
    const approved = engine.approve(job.id, "cli");
    assert.strictEqual(approved.ok, true);
    // Allow async executeApproved to settle
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(engine.get(job.id)?.state, "completed");
  });
});
