/**
 * WinHelm v1.4.1 Product Shell — Setup View & Companion Bridge
 * 
 * Provides narrow companion surfaces: Check Installation, Open Setup Assistant,
 * Connect Client, and guided first-run journey steps without duplicating the installation engine.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderSetupView(ctx: ShellRenderContext): string {
  const { messages } = ctx;

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

      <!-- COMPANION APPLICATION STATUS (Constraint 3) -->
      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="Setup Assistant Companion">
        <div class="card-header">
          <span class="card-label">Setup Assistant Companion</span>
          <span class="status-pill status-ready">Companion Supported</span>
        </div>
        <div style="font-size:13px; color:var(--text-secondary); margin-bottom:var(--space-3);">
          The standalone WinHelm Setup Assistant companion manages Windows service registration, prerequisites installation, and automated client configuration.
        </div>

        <div style="display:flex; gap:var(--space-3); flex-wrap:wrap;">
          <button class="btn-primary" onclick="alert('In production, launches standalone Setup Assistant companion application if detected on disk.')">
            🚀 Open Setup Assistant
          </button>
          <button class="btn-secondary" onclick="checkInstallationHealth()">
            🔍 Run Diagnostics / Check Installation
          </button>
        </div>

        <div id="setupDiagnosticResult" style="margin-top:var(--space-3); font-size:12px; display:none;"></div>
      </div>

      <!-- GUIDED READINESS JOURNEY STEPS -->
      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="Workspace Folders Setup Step">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepWorkspace)}</strong>
          <span id="setupWorkspaceStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupWorkspaceDetail" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
        <div style="margin-top:10px;">
          <button class="btn-secondary" onclick="showTab('access')">${escapeHtml(messages.setupOpenAccess)}</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="Capability Profile Setup Step">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepProfile)}</strong>
          <span id="setupProfileStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupProfileDetail" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
        <div style="margin-top:10px;">
          <button class="btn-secondary" onclick="showTab('access')">${escapeHtml(messages.setupOpenAccess)}</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="Approval Mode Setup Step">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepApproval)}</strong>
          <span id="setupApprovalStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupApprovalDetail" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
        <div style="margin-top:10px;">
          <button class="btn-secondary" onclick="showTab('access')">${escapeHtml(messages.setupOpenAccess)}</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="Client Configuration Setup Step">
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

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="Connection Observation Setup Step">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:14px;">${escapeHtml(messages.setupStepObserve)}</strong>
          <span id="setupSessionsStatus" class="status-pill status-neutral">—</span>
        </div>
        <div id="setupSessionsDetail" style="font-size:12px; color:var(--text-muted); margin-top:6px;"></div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="First Safe Action Guidance">
        <div class="card-label">${escapeHtml(messages.setupStepFirstAction)}</div>
        <div style="font-size:13px; color:var(--text-secondary); margin-top:6px; line-height:1.6;">${escapeHtml(messages.setupFirstActionBody)}</div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);" role="region" aria-label="Navigation Orientation">
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
