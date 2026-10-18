/**
 * WinHelm v1.4.1 Product Shell — Approvals View
 * 
 * Human decision inbox for reviewing, inspecting, and authorizing pending tool executions.
 * Backend-authoritative Mandatory Confirmation only.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderApprovalsView(ctx: ShellRenderContext): string {
  const { messages } = ctx;
  const nativeStatus = ctx.adapters?.nativeApproval ?? "unknown";
  const isNativeReady = nativeStatus === "ready";

  const nativeStatusBadge = isNativeReady
    ? escapeHtml(messages.shellApprovalsNativeReady || "Windows Native Notifications: Available & Active")
    : escapeHtml(messages.shellApprovalsNativeUnavailable || "Windows Native Notifications: Not yet integrated");

  const nativeStatusDesc = isNativeReady
    ? escapeHtml(messages.shellApprovalsNativeReadyDesc || "Approval prompts can be received as Windows desktop notifications.")
    : escapeHtml(messages.shellApprovalsNativeUnavailableDesc || "Desktop notification integration is pending. Web Dashboard approvals remain your active, authoritative fallback.");

  const nativeBannerClass = isNativeReady ? "banner banner-info" : "banner banner-info";

  return `
    <section id="panel-approvals" class="panel" aria-labelledby="heading-approvals">
      <div class="panel-header">
        <h1 id="heading-approvals" class="panel-title">${escapeHtml(messages.approvalsTitle)} — Approval Jobs</h1>
        <p class="panel-desc">${escapeHtml(messages.approvalsOnce || "One-time action")} · ${escapeHtml(messages.approvalsNote || "Pending approvals are local-only.")}</p>
      </div>

      <!-- TRANCHE B: WINDOWS NATIVE NOTIFICATIONS STATUS (Blocker A Fix) -->
      <div class="${nativeBannerClass}" role="region" aria-label="Notification Integration">
        <div class="banner-content">
          <span aria-hidden="true" style="font-size:18px;">${isNativeReady ? "🔔" : "ℹ️"}</span>
          <div>
            <strong>${nativeStatusBadge}</strong>
            <div style="font-size:12px; margin-top:2px;">
              ${nativeStatusDesc}
            </div>
          </div>
        </div>
      </div>

      <!-- INBOX PENDING LIST -->
      <div class="card" role="region" aria-label="Pending Approvals Queue">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellApprovalsQueueTitle || "Active Queue")}</span>
          <span id="approvalQueueCountPill" class="status-pill status-ready">0 Pending</span>
        </div>
        <div id="approvalJobs" class="approval-jobs-container" aria-live="polite">
          <div style="text-align:center; padding:var(--space-6); color:var(--text-muted);">
            <div style="font-size:28px; margin-bottom:var(--space-2);">✓</div>
            <div style="font-size:var(--text-base); font-weight:600; color:var(--text-primary);">${escapeHtml(messages.approvalsEmpty)}</div>
            <div style="font-size:var(--text-xs); margin-top:4px;">${escapeHtml(messages.shellApprovalsEmptySub || "When AI clients request sensitive or mutating actions, they will appear here.")}</div>
          </div>
        </div>
      </div>

      <!-- RECENT DECISIONS AUDIT -->
      <div class="card" style="margin-top:var(--space-5);" role="region" aria-label="Recent Approval History">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellApprovalsHistoryTitle || "Recent Approval Decisions")}</span>
        </div>
        <div id="approvalHistoryList" class="timeline-list">
          <div style="color:var(--text-muted); font-size:var(--text-xs); padding:var(--space-2);">${escapeHtml(messages.shellApprovalsHistoryEmpty || "No recent decisions recorded in this session.")}</div>
        </div>
      </div>
    </section>
  `;
}
