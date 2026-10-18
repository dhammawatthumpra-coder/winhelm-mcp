/**
 * WinHelm v1.4.1 Product Shell — Activity View
 * 
 * Human-readable event timeline of tool executions, security decisions, and system events.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderActivityView(ctx: ShellRenderContext): string {
  const { messages } = ctx;

  return `
    <section id="panel-activity" class="panel" aria-labelledby="heading-activity">
      <div class="panel-header">
        <h1 id="heading-activity" class="panel-title">${escapeHtml(messages.activityTitle)}</h1>
        <p class="panel-desc">Comprehensive timeline of AI tool executions and security decisions.</p>
      </div>

      <!-- FILTER PILLS -->
      <div class="filter-pills-bar" role="group" aria-label="Activity Filter Pills">
        <button class="filter-pill active" onclick="setActivityFilter('all', this)">${escapeHtml(messages.filterAll)}</button>
        <button class="filter-pill" onclick="setActivityFilter('tools', this)">${escapeHtml(messages.filterTools)}</button>
        <button class="filter-pill" onclick="setActivityFilter('security', this)">${escapeHtml(messages.filterSecurity)}</button>
        <button class="filter-pill" onclick="setActivityFilter('errors', this)">${escapeHtml(messages.filterErrors)}</button>
      </div>

      <!-- ACTIVITY TIMELINE LIST -->
      <div class="card" role="region" aria-label="Event Timeline">
        <div id="activityLogList" class="timeline-list">
          <div style="text-align:center; padding:var(--space-6); color:var(--text-muted);">
            ${escapeHtml(messages.activityEmpty)}
          </div>
        </div>
      </div>

      <div style="margin-top:var(--space-5); display:flex; gap:var(--space-3);">
        <a href="/api/monitor/export" class="btn-secondary" style="font-size:12px; display:inline-flex; align-items:center; gap:6px;">
          📥 Download Full Audit Log (JSON)
        </a>
      </div>
    </section>
  `;
}
