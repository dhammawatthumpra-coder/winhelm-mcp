import { ConfigManager } from "../config/config-manager.js";
import {
  sendWinHelmApprovalNotification,
  type ApprovalNotificationPayload,
  type ToastActionItem,
} from "../engine/system.js";
import type { ApprovalJob } from "./approval-engine.js";
import {
  formatSanitizedApprovalSummary,
} from "./display-schema.js";

export interface ApprovalNotifierOptions {
  send?: (
    activationUrl?: string,
    payload?: ApprovalNotificationPayload
  ) => Promise<unknown>;
  meta?: Record<string, unknown>;
  activationToken?: string;
  journalPath?: string;
}

/**
 * Deep link the toast opens. The effective listener port is only known once
 * the gateway is listening. Stdio instances (Claude Desktop / Cursor) never
 * listen; for those the default local Dashboard port is used so the toast
 * points at a usable decision surface — since DEF-02 the Dashboard lists and
 * decides jobs owned by every WinHelm instance. Loopback only; no public
 * listener is ever invented.
 */
export function approvalJobUrl(jobId: string): string | undefined {
  const port =
    ConfigManager.getInstance().getRuntimeEffectivePort() ?? 8788;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    return undefined;
  }
  return `http://127.0.0.1:${port}/approvals/${encodeURIComponent(jobId)}`;
}

/**
 * Advisory approval notification. It must never influence the approval flow,
 * so every failure (including a failing toast backend) is swallowed.
 */
export async function notifyApprovalPending(
  job: Pick<ApprovalJob, "id"> & Partial<Pick<ApprovalJob, "tool" | "args">>,
  options: ApprovalNotifierOptions = {}
): Promise<void> {
  try {
    const send = options.send ?? sendWinHelmApprovalNotification;
    const url = approvalJobUrl(job.id);

    let payload: ApprovalNotificationPayload | undefined;
    if (job.tool) {
      const summary = formatSanitizedApprovalSummary(
        {
          id: job.id,
          tool: job.tool,
          args: job.args ?? {},
        },
        options.meta
      );

      const actions: ToastActionItem[] = [];

      if (options.activationToken) {
        const tokenParam = `&token=${encodeURIComponent(options.activationToken)}`;
        const journalParam = options.journalPath
          ? `&journal=${encodeURIComponent(options.journalPath)}`
          : "";
        actions.push(
          {
            content: "Approve",
            arguments: `winhelm-approval:decide?jobId=${encodeURIComponent(job.id)}&decision=approved${tokenParam}${journalParam}`,
            activationType: "protocol",
          },
          {
            content: "Deny",
            arguments: `winhelm-approval:decide?jobId=${encodeURIComponent(job.id)}&decision=denied${tokenParam}${journalParam}`,
            activationType: "protocol",
          }
        );
      }

      if (url) {
        actions.push({
          content: "Review in Dashboard",
          arguments: url,
          activationType: "protocol",
        });
      }

      payload = {
        url,
        title: summary.title,
        message: summary.body,
        actionLabel: "Review in Dashboard",
        actions,
      };
    }

    await send(url, payload);
  } catch {
    // The Dashboard, receipt/status path and CLI remain the approval channels
    // when the toast backend is unavailable.
  }
}
