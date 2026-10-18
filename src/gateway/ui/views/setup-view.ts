/**
 * WinHelm v1.4.1 Product Shell — Setup View & Companion Bridge
 * 
 * Provides narrow companion surfaces: Check Installation, Open Setup Assistant,
 * Connect Client, and guided first-run journey steps without duplicating the installation engine.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderSetupView(ctx: ShellRenderContext): string {
  const { messages } = ctx;
  const companionStatus = ctx.adapters?.setupAssistant ?? "unknown";
  const isCompanionReady = companionStatus === "installed_ready";

  const companionBadge = isCompanionReady
    ? escapeHtml(messages.shellSetupCompanionReady)
    : escapeHtml(messages.shellSetupCompanionUnknown);

  const companionPillClass = isCompanionReady ? "status-pill status-ready" : "status-pill status-neutral";

  // Blocker C Corrective: Launch button remains safely disabled in Phase 2 across all states.
  // Never invokes an undefined function. Explains that companion bridge connects in Phase 3.
  const openButtonTitle = isCompanionReady
    ? escapeHtml(messages.shellSetupCompanionConnectedNotice)
    : escapeHtml(messages.shellSetupCompanionDisabledHint);

  const openButtonHtml = `<button class="btn-primary" disabled aria-disabled="true" style="opacity:0.6; cursor:not-allowed;" title="${openButtonTitle}">${escapeHtml(messages.shellSetupCompanionLaunch)}</button>`;

  return `
    <section id="panel-setup" class="panel" aria-labelledby="heading-setup">
      <div class="panel-header">
        <h1 id="heading-setup" class="panel-title">${escapeHtml(messages.setupTitle)}</h1>
        <p class="panel-desc">${escapeHtml(messages.setupDesc)}</p>
      </div>

      <div style="display: flex; gap: var(--space-3); margin-bottom: var(--space-4);">
        <button class="btn-secondary" onclick="refreshAllData()">${escapeHtml(messages.setupRecheck)}</button>
      </div>

      <div id="setupLockedNotice" class="banner banner-info" style="display:none; margin-bottom:var(--space-4);">
        ${escapeHtml(messages.setupLocked)}
      </div>

      <!-- COMPANION APPLICATION STATUS (Blocker C Fix) -->
      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellSetupAriaCompanion)}">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellSetupCompanionTitle)}</span>
          <span class="${companionPillClass}">${companionBadge}</span>
        </div>
        <div style="font-size:13px; color:var(--text-secondary); margin-bottom:var(--space-3);">
          ${escapeHtml(messages.shellSetupCompanionDesc)}
        </div>

        <div style="display:flex; gap:var(--space-3); flex-wrap:wrap; align-items:center;">
          ${openButtonHtml}
          <button class="btn-secondary" onclick="checkInstallationHealth()">
            ${escapeHtml(messages.shellSetupCompanionDiagnostics)}
          </button>
        </div>

        <div style="font-size:12px; color:var(--text-muted); margin-top:var(--space-2);">
          ${openButtonTitle}
        </div>

        <div id="setupDiagnosticResult" style="margin-top:var(--space-3); font-size:12px; display:none;"></div>
      </div>

      <!-- GUIDED READINESS JOURNEY STEPS -->
      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellSetupAriaWorkspace)}">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepWorkspace)}</strong>
          <span id="setupWorkspaceStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupWorkspaceDetail" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
        <div style="margin-top:10px;">
          <button class="btn-secondary" onclick="showTab('access')">${escapeHtml(messages.setupOpenAccess)}</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellSetupAriaProfile)}">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepProfile)}</strong>
          <span id="setupProfileStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupProfileDetail" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
        <div style="margin-top:10px;">
          <button class="btn-secondary" onclick="showTab('access')">${escapeHtml(messages.setupOpenAccess)}</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellSetupAriaApproval)}">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepApproval)}</strong>
          <span id="setupApprovalStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupApprovalDetail" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
        <div style="margin-top:10px;">
          <button class="btn-secondary" onclick="showTab('access')">${escapeHtml(messages.setupOpenAccess)}</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellSetupAriaClient)}">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepClient)}</strong>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
          <span id="setupClientClaudeName" style="font-size:13px;">${escapeHtml(messages.connClaudeLabel)}</span>
          <span id="setupClientClaudeStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupClientClaudeDetail" style="font-size:12px; color:var(--text-muted); margin-top:4px; word-break:break-all;"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
          <span style="font-size:13px;">${escapeHtml(messages.connCursorLabel)}</span>
          <span id="setupClientCursorStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupClientCursorDetail" style="font-size:12px; color:var(--text-muted); margin-top:4px; word-break:break-all;"></div>
        <div style="margin-top:10px;">
          <button class="btn-secondary" onclick="showTab('connections')">${escapeHtml(messages.setupOpenConnections)}</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellSetupAriaObserve)}">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepObserve)}</strong>
          <span id="setupSessionsStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupSessionsDetail" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellSetupAriaFirstAction)}">
        <div class="card-label">${escapeHtml(messages.setupStepFirstAction)}</div>
        <div style="font-size:13px; color:var(--text-secondary); margin-top:6px; line-height:1.6;">${escapeHtml(messages.setupFirstActionBody)}</div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellSetupAriaOrientation)}">
        <div class="card-label">${escapeHtml(messages.setupStepOrientation)}</div>
        <div style="font-size:13px; color:var(--text-secondary); margin-top:6px; line-height:1.6;">${escapeHtml(messages.setupOrientationBody)}</div>
        <div style="display:flex; gap:var(--space-2); margin-top:12px; flex-wrap:wrap;">
          <button class="btn-secondary" onclick="showTab('approvals')">${escapeHtml(messages.setupOpenApprovals)}</button>
          <button class="btn-secondary" onclick="showTab('activity')">${escapeHtml(messages.setupOpenActivity)}</button>
        </div>
      </div>
    </section>
  `;
}
