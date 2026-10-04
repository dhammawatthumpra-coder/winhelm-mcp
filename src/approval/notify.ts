import { ConfigManager } from "../config/config-manager.js";
import { sendWinHelmApprovalNotification } from "../engine/system.js";
import type { ApprovalJob } from "./approval-engine.js";

export interface ApprovalNotifierOptions {
  send?: (activationUrl?: string) => Promise<unknown>;
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
  job: Pick<ApprovalJob, "id">,
  options: ApprovalNotifierOptions = {}
): Promise<void> {
  try {
    const send = options.send ?? sendWinHelmApprovalNotification;
    await send(approvalJobUrl(job.id));
  } catch {
    // The Dashboard, receipt/status path and CLI remain the approval channels
    // when the toast backend is unavailable.
  }
}
