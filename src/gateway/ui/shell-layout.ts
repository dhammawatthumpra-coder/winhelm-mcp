/**
 * WinHelm v1.4.1 Product Shell — Main Shell Layout
 * 
 * Semantic HTML structure, accessible navigation landmarks,
 * WCAG dialogs, and integration of all panel views.
 */

import { escapeHtml, type ShellRenderContext } from "./common.js";
import { getDesignTokensCss } from "./tokens.css.js";
import { renderHomeView } from "./views/home-view.js";
import { renderApprovalsView } from "./views/approvals-view.js";
import { renderConnectionsView } from "./views/connections-view.js";
import { renderAccessView } from "./views/access-view.js";
import { renderActivityView } from "./views/activity-view.js";
import { renderSettingsView } from "./views/settings-view.js";
import { renderAdvancedView } from "./views/advanced-view.js";
import { renderSetupView } from "./views/setup-view.js";
import { getClientScript } from "./client-script.js";

export function renderProductShell(ctx: ShellRenderContext): string {
  const { messages, locale, clientScriptMessages, focusJobId } = ctx;

  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(messages.title || "WinHelm Product Shell")}</title>
  <style>
    ${getDesignTokensCss()}
  </style>
</head>
<body>

  <!-- TOP HEADER -->
  <header class="app-header" role="banner">
    <div class="brand-section">
      <div class="brand-logo">
        <div class="brand-icon">W</div>
        <span>WinHelm</span>
        <span class="brand-badge">PRODUCT SHELL</span>
      </div>
    </div>

    <div class="header-actions">
      <!-- ADMIN UNLOCK PILL -->
      <div id="adminPill" class="admin-pill" onclick="handleAdminPillClick()" role="button" tabindex="0" title="${escapeHtml(messages.adminHint || "Click to unlock local admin privileges")}">
        <span class="status-dot yellow" id="adminDot"></span>
        <span id="adminText">${escapeHtml(messages.adminLocked || "Admin Locked")}</span>
      </div>

      <!-- THEME TOGGLE -->
      <button class="icon-btn" onclick="handleThemeChange(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')" title="Toggle Theme" aria-label="Toggle visual theme">
        ☼
      </button>

      <!-- LANGUAGE SELECT -->
      <button class="icon-btn" style="font-size:11px; font-weight:700;" onclick="handleLanguageChange('${locale === "en" ? "th" : "en"}')" title="Switch Language" aria-label="Switch interface language">
        ${locale === "en" ? "TH" : "EN"}
      </button>
    </div>
  </header>

  <!-- APP BODY -->
  <div class="app-body">
    <!-- SEMANTIC NAVIGATION SIDEBAR -->
    <nav class="sidebar" id="appSidebar" role="navigation" aria-label="Primary Navigation">
      <div class="nav-group">
        <button class="nav-item active" data-tab="overview" onclick="showTab('overview')" aria-current="page">
          <div class="nav-item-left">
            <span>🏠</span>
            <span>${escapeHtml(messages.navOverview)}</span>
          </div>
        </button>

        <button class="nav-item" data-tab="setup" onclick="showTab('setup')">
          <div class="nav-item-left">
            <span>🚀</span>
            <span>${escapeHtml(messages.navSetup)}</span>
          </div>
        </button>

        <button class="nav-item" data-tab="access" onclick="showTab('access')">
          <div class="nav-item-left">
            <span>🔒</span>
            <span>${escapeHtml(messages.navAccess)}</span>
          </div>
        </button>

        <button class="nav-item" data-tab="approvals" onclick="showTab('approvals')">
          <div class="nav-item-left">
            <span>🛡️</span>
            <span>${escapeHtml(messages.navApprovals)}</span>
          </div>
          <span id="sidebarApprovalCount" class="nav-badge" style="display:none;">0</span>
        </button>

        <button class="nav-item" data-tab="activity" onclick="showTab('activity')">
          <div class="nav-item-left">
            <span>📜</span>
            <span>${escapeHtml(messages.navActivity)}</span>
          </div>
        </button>

        <button class="nav-item" data-tab="connections" onclick="showTab('connections')">
          <div class="nav-item-left">
            <span>🔗</span>
            <span>${escapeHtml(messages.connTitle)}</span>
          </div>
        </button>

        <button class="nav-item" data-tab="settings" onclick="showTab('settings')">
          <div class="nav-item-left">
            <span>⚙️</span>
            <span>${escapeHtml(messages.settingsTitle)}</span>
          </div>
        </button>

        <button class="nav-item" data-tab="advanced" onclick="showTab('advanced')">
          <div class="nav-item-left">
            <span>🔧</span>
            <span>${escapeHtml(messages.navAdvanced)}</span>
          </div>
        </button>
      </div>

      <div class="sidebar-footer">
        <a href="/dashboard" class="sidebar-external-link" title="Open engineering dashboard for raw hardware metrics and tool registry">
          <span>${escapeHtml(messages.shellNavAdvancedMonitor || "Advanced / Diagnostics ↗")}</span>
        </a>
      </div>
    </nav>

    <!-- MAIN CONTENT VIEW PANELS -->
    <main class="main-content" role="main">
      ${renderHomeView(ctx)}
      ${renderSetupView(ctx)}
      ${renderAccessView(ctx)}
      ${renderApprovalsView(ctx)}
      ${renderActivityView(ctx)}
      ${renderConnectionsView(ctx)}
      ${renderSettingsView(ctx)}
      ${renderAdvancedView(ctx)}
    </main>
  </div>

  <!-- ADMIN UNLOCK MODAL (Role: dialog, accessible trap) -->
  <div id="adminModal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="adminModalTitle" aria-hidden="true">
    <div class="modal-dialog">
      <div class="modal-header">
        <h2 id="adminModalTitle" class="modal-title">${escapeHtml(messages.adminRequired || "Admin Authorization Required")}</h2>
        <button class="icon-btn" onclick="closeAdminModal()" aria-label="Close dialog">✕</button>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:var(--space-3);">
          ${escapeHtml(messages.adminInstructions || "Run 'winhelm admin-code' in a local terminal, then enter the one-time code here.")}
        </p>
        <div style="margin-bottom:var(--space-3);">
          <label for="adminCodeInput" style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">
            ${escapeHtml(messages.adminPlaceholder || "One-time admin code")}
          </label>
          <input type="password" id="adminCodeInput" class="mandatory-confirm-input" style="max-width:100%; width:100%;" placeholder="${escapeHtml(messages.adminPlaceholder || "Enter code")}" autocomplete="one-time-code" />
        </div>
        <div id="adminUnlockError" style="color:var(--status-offline-text); font-size:12px; margin-bottom:var(--space-2);"></div>
        <div style="font-size:11px; color:var(--text-muted); background:var(--bg-subtle); padding:var(--space-2); border-radius:4px;">
          ${escapeHtml(messages.shellModalSecretWarning || "🔒 Never share or paste the admin code into an AI chat.")}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="closeAdminModal()">${escapeHtml(messages.shellModalCancel || "Cancel")}</button>
        <button class="btn-approve" onclick="submitAdminCode()">${escapeHtml(messages.adminUnlock || "Unlock")}</button>
      </div>
    </div>
  </div>

  <!-- PRODUCTION CLIENT SCRIPT -->
  <script>
    ${getClientScript(clientScriptMessages, focusJobId)}
  </script>
</body>
</html>`;
}
