/**
 * WinHelm v1.4.1 Product Shell — Approvals View
 * 
 * Human decision inbox for reviewing, inspecting, and authorizing pending tool executions.
 * Backend-authoritative Mandatory Confirmation only.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderApprovalsView(ctx: ShellRenderContext): string {
  const { messages } = ctx;

  return `
    <section id="panel-approvals" class="panel" aria-labelledby="heading-approvals">
      <div class="panel-header">
        <h1 id="heading-approvals" class="panel-title">${escapeHtml(messages.approvalsTitle)} — Approval Jobs</h1>
        <p class="panel-desc">${escapeHtml(messages.approvalsOnce || "One-time action")} · ${escapeHtml(messages.approvalsNote || "Pending approvals are local-only.")}</p>
      </div>

      <!-- TRANCHE B: WINDOWS NATIVE NOTIFICATIONS STATUS -->
      <div class="banner banner-info" role="region" aria-label="Notification Integration">
        <div class="banner-content">
          <span aria-hidden="true" style="font-size:18px;">🔔</span>
          <div>
            <strong>Windows Native Notifications: Available & Active</strong>
            <div style="font-size:12px; margin-top:2px;">
              Approval prompts can be received as Windows desktop notifications. You can also safely approve or deny actions directly from this dashboard.
            </div>
          </div>
        </div>
      </div>

      <!-- INBOX PENDING LIST -->
      <div class="card" role="region" aria-label="Pending Approvals Queue">
        <div class="card-header">
          <span class="card-label">Active Queue</span>
          <span id="approvalQueueCountPill" class="status-pill status-ready">0 Pending</span>
        </div>
        <div id="approvalJobs" class="approval-jobs-container" aria-live="polite">
          <div style="text-align:center; padding:var(--space-6); color:var(--text-muted);">
            <div style="font-size:28px; margin-bottom:var(--space-2);">✓</div>
            <div style="font-size:var(--text-base); font-weight:600; color:var(--text-primary);">${escapeHtml(messages.approvalsEmpty)}</div>
            <div style="font-size:var(--text-xs); margin-top:4px;">When AI clients request sensitive or mutating actions, they will appear here.</div>
          </div>
        </div>
      </div>

      <!-- RECENT DECISIONS AUDIT -->
      <div class="card" style="margin-top:var(--space-5);" role="region" aria-label="Recent Approval History">
        <div class="card-header">
          <span class="card-label">Recent Approval Decisions</span>
        </div>
        <div id="approvalHistoryList" class="timeline-list">
          <div style="color:var(--text-muted); font-size:var(--text-xs); padding:var(--space-2);">No recent decisions recorded in this session.</div>
        </div>
      </div>
    </section>
  `;
}
