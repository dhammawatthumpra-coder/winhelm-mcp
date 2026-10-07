import { PROFILES, type ToolProfile } from "../config/profiles.js";
import { getRuntimeLocale, translate as t } from "../i18n/messages.js";

/**
 * Escape HTML special characters to prevent Cross-Site Scripting (XSS).
 */
export function escapeHtml(str: any): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ProductShellSummary {
  schemaMode: "legacy" | "v2" | "invalid";
  preset?: string | null;
  modified?: boolean | null;
  terminalMode?: string | null;
  approvalMode?: string | null;
  focusJobId?: string | null;
}

/**
 * Modern, accessible, zero-dependency Web Product Shell for WinHelm v1.4.
 * Served directly by Express without external CDN dependencies.
 */
export function getProductShellHtml(
  activeProfile: ToolProfile = "full",
  summary?: ProductShellSummary
): string {
  const profileDef = PROFILES[activeProfile] || PROFILES.full;
  const schemaMode = summary?.schemaMode ?? "legacy";
  const displayProfile =
    schemaMode === "v2"
      ? String(summary?.preset ?? "balanced")
      : profileDef.name;
  const isModified = summary?.modified === true;
  const terminalMode = summary?.terminalMode ?? "ask";
  const approvalMode = summary?.approvalMode ?? "manual";
  const focusJobId = summary?.focusJobId ?? "";
  const locale = getRuntimeLocale();

  const messages = {
    title: t("shell.title"),
    navOverview: t("shell.nav.overview"),
    navAccess: t("shell.nav.access"),
    navApprovals: t("shell.nav.approvals"),
    navActivity: t("shell.nav.activity"),
    navConnections: t("shell.nav.connections"),
    navSettings: t("shell.nav.settings"),
    navAdvanced: t("shell.nav.advanced"),
    statusRunning: t("shell.overview.status.running"),
    profileTitle: t("shell.overview.profile.title"),
    profileModified: t("shell.overview.profile.modified"),
    approvalTitle: t("shell.overview.approval.title"),
    pendingTitle: t("shell.overview.pending.title"),
    connectionsTitle: t("shell.overview.connections.title"),
    legacyBanner: t("shell.overview.legacy.banner"),
    warningsNone: t("shell.overview.warnings.none"),
    accessTitle: t("shell.access.title"),
    foldersTitle: t("shell.access.folders.title"),
    foldersEmpty: t("shell.access.folders.empty"),
    folderRead: t("shell.access.folders.read"),
    folderReadwrite: t("shell.access.folders.readwrite"),
    terminalTitle: t("shell.access.terminal.title"),
    terminalSafeDistinction: t("shell.access.terminal.safe_distinction"),
    accessPreview: t("shell.access.preview"),
    accessSave: t("shell.access.save"),
    approvalsTitle: t("shell.approvals.title"),
    approvalsEmpty: t("shell.approvals.empty"),
    approvalsApprove: t("shell.approvals.approve"),
    approvalsDeny: t("shell.approvals.deny"),
    approvalsClient: t("shell.approvals.client"),
    approvalsTool: t("shell.approvals.tool"),
    approvalsRisk: t("shell.approvals.risk"),
    approvalsTarget: t("shell.approvals.target"),
    approvalsDetails: t("shell.approvals.details"),
    approvalsPreview: t("shell.approvals.preview"),
    approvalsOnce: t("shell.approvals.once"),
    activityTitle: t("shell.activity.title"),
    activityEmpty: t("shell.activity.empty"),
    filterAll: t("shell.activity.filter.all"),
    filterTools: t("shell.activity.filter.tools"),
    filterSecurity: t("shell.activity.filter.security"),
    filterErrors: t("shell.activity.filter.errors"),
    activityAdvancedHint: t("shell.activity.advanced_hint"),
    connTitle: t("shell.connections.title"),
    connClaudeLabel: t("shell.connections.claude.label"),
    connClaudeType: t("shell.connections.claude.type"),
    connCursorLabel: t("shell.connections.cursor.label"),
    connCursorType: t("shell.connections.cursor.type"),
    connChatgptLabel: t("shell.connections.chatgpt.label"),
    connChatgptLifecycleTitle: t("shell.connections.chatgpt.lifecycle_title"),
    connChatgptDependencyLabel: t("shell.connections.chatgpt.dependency_label"),
    connChatgptProfileLabel: t("shell.connections.chatgpt.profile_label"),
    connChatgptBackendLabel: t("shell.connections.chatgpt.backend_label"),
    connChatgptStateLabel: t("shell.connections.chatgpt.state_label"),
    connChatgptOwnershipLabel: t("shell.connections.chatgpt.ownership_label"),
    connChatgptManaged: t("shell.connections.chatgpt.managed"),
    connChatgptExternal: t("shell.connections.chatgpt.external_unmanaged"),
    connChatgptActionStart: t("shell.connections.chatgpt.action_start"),
    connChatgptActionStop: t("shell.connections.chatgpt.action_stop"),
    connChatgptActionRestart: t("shell.connections.chatgpt.action_restart"),
    connChatgptActionDoctor: t("shell.connections.chatgpt.action_doctor"),
    connChatgptConfirmHint: t("shell.connections.chatgpt.confirm_hint"),
    connChatgptConfirmPlaceholder: t("shell.connections.chatgpt.confirm_placeholder"),
    connChatgptExternalNotice: t("shell.connections.chatgpt.external_notice"),
    connChatgptConfigureHint: t("shell.connections.chatgpt.configure_hint"),
    connChatgptRecoveryHint: t("shell.connections.chatgpt.recovery_hint"),
    connChatgptType: t("shell.connections.chatgpt.type"),
    connTailscaleLabel: t("shell.connections.tailscale.label"),
    connTailscaleType: t("shell.connections.tailscale.type"),
    connConfigure: t("shell.connections.configure"),
    connConnected: t("shell.connections.connected"),
    connNotConnected: t("shell.connections.not_connected"),
    settingsTitle: t("shell.settings.title"),
    settingsProfile: t("shell.settings.profile"),
    settingsApprovalMode: t("shell.settings.approval_mode"),
    settingsLanguage: t("shell.settings.language"),
    settingsToken: t("shell.settings.token"),
    settingsDangerousNotice: t("shell.settings.dangerous_notice"),
    settingsSave: t("shell.settings.save"),
    adminRequired: t("shell.admin.required"),
    adminHint: t("shell.admin.hint"),
    adminInstructions: t("dashboard.admin.instructions"),
    adminPlaceholder: t("shell.admin.placeholder"),
    adminUnlock: t("shell.admin.unlock"),
    adminUnlocked: t("shell.admin.status_unlocked"),
    adminLocked: t("shell.admin.status_locked"),
    approvalsNote: t("dashboard.approvals.note"),
    confirmType: t("confirm.type"),
    tokenConfirm: t("dashboard.token.confirm"),
    tokenRotate: t("dashboard.token.rotate"),
    tokenNew: t("dashboard.token.new"),
    tokenOnce: t("dashboard.token.once"),
    fullWarn: t("mode.full.warn"),
    navSetup: t("shell.nav.setup"),
    setupTitle: t("shell.setup.title"),
    setupDesc: t("shell.setup.desc"),
    setupRecheck: t("shell.setup.recheck"),
    setupLocked: t("shell.setup.locked"),
    setupStepWorkspace: t("shell.setup.step.workspace"),
    setupStepProfile: t("shell.setup.step.profile"),
    setupStepApproval: t("shell.setup.step.approval"),
    setupStepClient: t("shell.setup.step.client"),
    setupStepObserve: t("shell.setup.step.observe"),
    setupStepFirstAction: t("shell.setup.step.first_action"),
    setupStepOrientation: t("shell.setup.step.orientation"),
    setupStatusComplete: t("shell.setup.status.complete"),
    setupStatusIncomplete: t("shell.setup.status.incomplete"),
    setupStatusConfigured: t("shell.setup.status.configured"),
    setupStatusNeedsConfiguration: t("shell.setup.status.needs_configuration"),
    setupStatusAttention: t("shell.setup.status.attention"),
    setupStatusActive: t("shell.setup.status.active"),
    setupStatusNotObserved: t("shell.setup.status.not_observed"),
    setupCurrent: t("shell.setup.current"),
    setupOpenAccess: t("shell.setup.open_access"),
    setupOpenSettings: t("shell.setup.open_settings"),
    setupOpenConnections: t("shell.setup.open_connections"),
    setupOpenApprovals: t("shell.setup.open_approvals"),
    setupOpenActivity: t("shell.setup.open_activity"),
    setupFirstActionBody: t("shell.setup.first_action.body"),
    setupOrientationBody: t("shell.setup.orientation.body"),
    connRestartHint: t("shell.connections.restart_hint"),
  };

  const clientScriptMessages = JSON.stringify(messages).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(messages.title)}</title>
  <style>
    :root {
      --bg-dark: #0b0f19;
      --bg-panel: #111827;
      --bg-card: #1f2937;
      --bg-card-hover: #283548;
      --border-color: #374151;
      --border-focus: #3b82f6;
      --text-main: #f9fafb;
      --text-muted: #9ca3af;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-dark);
      color: var(--text-main);
      font-family: var(--font-family);
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background-color: var(--bg-panel);
      border-bottom: 1px solid var(--border-color);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 50;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
    }

    .brand-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 9999px;
      background-color: rgba(37, 99, 235, 0.2);
      color: #60a5fa;
      border: 1px solid rgba(37, 99, 235, 0.4);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .admin-pill {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border-color);
      background: var(--bg-card);
      color: var(--text-muted);
      transition: all 0.2s;
    }
    .admin-pill:hover { border-color: var(--border-focus); color: var(--text-main); }
    .admin-pill.unlocked {
      background: rgba(16, 185, 129, 0.15);
      border-color: rgba(16, 185, 129, 0.4);
      color: #34d399;
    }

    .layout {
      display: flex;
      flex: 1;
      min-height: calc(100vh - 57px);
    }

    nav.sidebar {
      width: 240px;
      background-color: var(--bg-panel);
      border-right: 1px solid var(--border-color);
      padding: 20px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-radius: 8px;
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      background: none;
      font-family: inherit;
      font-size: 14px;
      text-align: left;
      width: 100%;
      transition: all 0.15s ease;
    }
    .nav-item:hover {
      background-color: var(--bg-card);
      color: var(--text-main);
    }
    .nav-item.active {
      background-color: var(--primary);
      color: #ffffff;
      font-weight: 600;
    }

    .nav-badge {
      background: var(--danger);
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      padding: 1px 7px;
      border-radius: 9999px;
    }

    .nav-divider {
      height: 1px;
      background-color: var(--border-color);
      margin: 12px 0;
    }

    .nav-external {
      color: #93c5fd;
      border: 1px dashed rgba(59, 130, 246, 0.4);
      background: rgba(59, 130, 246, 0.05);
    }
    .nav-external:hover {
      background: rgba(59, 130, 246, 0.15);
      color: #bfdbfe;
    }

    main.content {
      flex: 1;
      padding: 24px 32px;
      overflow-y: auto;
      max-width: 1200px;
    }

    .panel { display: none; }
    .panel.active { display: block; }

    .panel-header {
      margin-bottom: 24px;
    }
    .panel-title {
      font-size: 24px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 6px;
    }
    .panel-desc {
      color: var(--text-muted);
      font-size: 14px;
    }

    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .card {
      background-color: var(--bg-panel);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 20px;
    }

    .card-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .card-value {
      font-size: 22px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .card-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 6px;
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-dot.green { background-color: var(--success); box-shadow: 0 0 8px rgba(16, 185, 129, 0.5); }
    .status-dot.yellow { background-color: var(--warning); }
    .status-dot.red { background-color: var(--danger); }

    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-primary { background: rgba(37, 99, 235, 0.2); color: #60a5fa; border: 1px solid rgba(37, 99, 235, 0.4); }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-danger { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .badge-neutral { background: var(--bg-card); color: var(--text-muted); border: 1px solid var(--border-color); }

    .banner {
      padding: 14px 18px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 13px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .banner-warning {
      background-color: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.4);
      color: #fbbf24;
    }
    .banner-danger {
      background-color: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #f87171;
    }
    .banner-info {
      background-color: rgba(37, 99, 235, 0.1);
      border: 1px solid rgba(37, 99, 235, 0.4);
      color: #93c5fd;
    }

    button.btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: inherit;
      transition: all 0.15s;
    }
    button.btn-primary { background: var(--primary); color: #fff; }
    button.btn-primary:hover { background: var(--primary-hover); }
    button.btn-success { background: var(--success); color: #fff; }
    button.btn-success:hover { background: #059669; }
    button.btn-danger { background: var(--danger); color: #fff; }
    button.btn-danger:hover { background: #dc2626; }
    button.btn-secondary { background: var(--bg-card); border-color: var(--border-color); color: var(--text-main); }
    button.btn-secondary:hover { background: var(--bg-card-hover); }

    .approval-item {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 14px;
      transition: border-color 0.2s;
    }
    .approval-item:hover, .approval-item.focused {
      border-color: var(--border-focus);
    }
    .approval-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .approval-tool {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
    }
    .approval-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      background: rgba(0,0,0,0.2);
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 12px;
      font-size: 13px;
    }
    .approval-field-label { color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
    .approval-field-val { color: var(--text-main); font-weight: 500; word-break: break-all; }
    .approval-text-preview {
      background: #060911;
      border: 1px solid #1f293d;
      border-radius: 6px;
      padding: 12px;
      font-family: Consolas, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
      color: #cbd5e1;
      margin-bottom: 12px;
    }

    table.data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    table.data-table th {
      text-align: left;
      padding: 10px 14px;
      background-color: var(--bg-card);
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-color);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
    }
    table.data-table td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-color);
      color: var(--text-main);
    }
    table.data-table tr:hover td {
      background-color: rgba(255, 255, 255, 0.02);
    }

    .form-group {
      margin-bottom: 18px;
    }
    .form-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-main);
      margin-bottom: 6px;
    }
    .form-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    select.form-control, input.form-control, textarea.form-control {
      width: 100%;
      max-width: 500px;
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      padding: 8px 12px;
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
    }
    select.form-control:focus, input.form-control:focus, textarea.form-control:focus {
      outline: none;
      border-color: var(--border-focus);
    }

    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(2px);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.open { display: flex; }
    .modal-card {
      background: var(--bg-panel);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 24px;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .modal-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; color: #fff; }
    .modal-desc { font-size: 13px; color: var(--text-muted); margin-bottom: 16px; }

    @media (max-width: 768px) {
      .layout { flex-direction: column; }
      nav.sidebar { width: 100%; border-right: none; border-bottom: 1px solid var(--border-color); padding: 12px; }
      main.content { padding: 16px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>WinHelm</span>
      <span class="brand-badge">PRODUCT SHELL</span>
    </div>
    <div class="header-actions">
      <div id="adminPill" class="admin-pill" onclick="handleAdminPillClick()" title="${escapeHtml(messages.adminHint)}">
        <span class="status-dot yellow" id="adminDot"></span>
        <span id="adminPillText">${escapeHtml(messages.adminLocked)}</span>
      </div>
    </div>
  </header>

  <div class="layout">
    <nav class="sidebar">
      <button class="nav-item active" data-tab="overview" onclick="showTab('overview')">
        <span>${escapeHtml(messages.navOverview)}</span>
      </button>
      <button class="nav-item" data-tab="setup" onclick="showTab('setup')">
        <span>${escapeHtml(messages.navSetup)}</span>
      </button>
      <button class="nav-item" data-tab="access" onclick="showTab('access')">
        <span>${escapeHtml(messages.navAccess)}</span>
      </button>
      <button class="nav-item" data-tab="approvals" onclick="showTab('approvals')">
        <span>${escapeHtml(messages.navApprovals)}</span>
        <span id="sidebarApprovalCount" class="nav-badge" style="display:none;">0</span>
      </button>
      <button class="nav-item" data-tab="activity" onclick="showTab('activity')">
        <span>${escapeHtml(messages.navActivity)}</span>
      </button>
      <button class="nav-item" data-tab="connections" onclick="showTab('connections')">
        <span>${escapeHtml(messages.navConnections)}</span>
      </button>
      <button class="nav-item" data-tab="settings" onclick="showTab('settings')">
        <span>${escapeHtml(messages.navSettings)}</span>
      </button>

      <div class="nav-divider"></div>

      <a href="/dashboard" class="nav-item nav-external" title="Open engineering dashboard for raw hardware telemetry and diagnostics">
        <span>${escapeHtml(messages.navAdvanced)} ↗</span>
      </a>
    </nav>

    <main class="content">
      <!-- 1. OVERVIEW PANEL -->
      <section id="panel-overview" class="panel active">
        <div class="panel-header">
          <h1 class="panel-title">${escapeHtml(messages.navOverview)}</h1>
          <p class="panel-desc">WinHelm runtime status, security boundary, and client overview.</p>
        </div>

        <div id="overviewBanners">
          ${schemaMode === "legacy" ? `<div class="banner banner-warning">${escapeHtml(messages.legacyBanner)}</div>` : ""}
          ${terminalMode === "full" ? `<div class="banner banner-danger">${escapeHtml(messages.fullWarn)}</div>` : ""}
        </div>

        <div class="card-grid">
          <div class="card">
            <div class="card-label">Server Status</div>
            <div class="card-value">
              <span class="status-dot green"></span>
              <span id="statStatus">${escapeHtml(messages.statusRunning)}</span>
            </div>
            <div class="card-sub" id="statServerInfo">WinHelm MCP Server</div>
          </div>

          <div class="card">
            <div class="card-label">${escapeHtml(messages.profileTitle)}</div>
            <div class="card-value">
              <span id="statProfile">${escapeHtml(displayProfile.toUpperCase())}</span>
              ${isModified ? `<span class="badge badge-warning">${escapeHtml(messages.profileModified)}</span>` : ""}
            </div>
            <div class="card-sub">Terminal: <span id="statTerminalMode">${escapeHtml(terminalMode)}</span></div>
          </div>

          <div class="card">
            <div class="card-label">${escapeHtml(messages.approvalTitle)}</div>
            <div class="card-value">
              <span id="statApprovalMode">${escapeHtml(approvalMode.toUpperCase())}</span>
            </div>
            <div class="card-sub">Cross-process governance</div>
          </div>

          <div class="card">
            <div class="card-label">${escapeHtml(messages.pendingTitle)}</div>
            <div class="card-value">
              <span id="statPendingApprovals">0</span>
            </div>
            <div class="card-sub">Requests awaiting decision</div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 24px;">
          <div class="card-label">${escapeHtml(messages.connectionsTitle)}</div>
          <div id="overviewConnectionsList" style="display: flex; gap: 16px; flex-wrap: wrap; margin-top: 10px;">
            <div style="font-size: 13px; color: var(--text-muted);">Checking client sessions…</div>
          </div>
        </div>
      </section>

      <!-- 2. SETUP PANEL (M3A Phase 1 guided first-run) -->
      <section id="panel-setup" class="panel">
        <div class="panel-header">
          <h1 class="panel-title">${escapeHtml(messages.setupTitle)}</h1>
          <p class="panel-desc">${escapeHtml(messages.setupDesc)}</p>
        </div>

        <div style="display: flex; gap: 12px; margin-bottom: 20px;">
          <button class="btn btn-secondary" onclick="refreshAllData()">${escapeHtml(messages.setupRecheck)}</button>
        </div>

        <div id="setupLockedNotice" class="banner banner-info" style="display:none;">
          ${escapeHtml(messages.setupLocked)}
        </div>

        <div class="card" style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600;">${escapeHtml(messages.setupStepWorkspace)}</span>
            <span id="setupWorkspaceStatus" class="badge badge-neutral">—</span>
          </div>
          <div id="setupWorkspaceDetail" style="font-size: 13px; color: var(--text-muted); margin-top: 8px;"></div>
          <div style="margin-top: 12px;">
            <button class="btn btn-secondary" onclick="showTab('access')">${escapeHtml(messages.setupOpenAccess)}</button>
          </div>
        </div>

        <div class="card" style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600;">${escapeHtml(messages.setupStepProfile)}</span>
            <span id="setupProfileStatus" class="badge badge-neutral">—</span>
          </div>
          <div id="setupProfileDetail" style="font-size: 13px; color: var(--text-muted); margin-top: 8px;"></div>
          <div style="margin-top: 12px;">
            <button class="btn btn-secondary" onclick="showTab('access')">${escapeHtml(messages.setupOpenAccess)}</button>
          </div>
        </div>

        <div class="card" style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600;">${escapeHtml(messages.setupStepApproval)}</span>
            <span id="setupApprovalStatus" class="badge badge-neutral">—</span>
          </div>
          <div id="setupApprovalDetail" style="font-size: 13px; color: var(--text-muted); margin-top: 8px;"></div>
          <div style="margin-top: 12px;">
            <button class="btn btn-secondary" onclick="showTab('settings')">${escapeHtml(messages.setupOpenSettings)}</button>
          </div>
        </div>

        <div class="card" style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600;">${escapeHtml(messages.setupStepClient)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px;">
            <span id="setupClientClaudeName" style="font-size: 13px;">${escapeHtml(messages.connClaudeLabel)}</span>
            <span id="setupClientClaudeStatus" class="badge badge-neutral">—</span>
          </div>
          <div id="setupClientClaudeDetail" style="font-size: 12px; color: var(--text-muted); margin-top: 4px; word-break: break-all;"></div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px;">
            <span style="font-size: 13px;">${escapeHtml(messages.connCursorLabel)}</span>
            <span id="setupClientCursorStatus" class="badge badge-neutral">—</span>
          </div>
          <div id="setupClientCursorDetail" style="font-size: 12px; color: var(--text-muted); margin-top: 4px; word-break: break-all;"></div>
          <div style="margin-top: 12px;">
            <button class="btn btn-secondary" onclick="showTab('connections')">${escapeHtml(messages.setupOpenConnections)}</button>
          </div>
        </div>

        <div class="card" style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600;">${escapeHtml(messages.setupStepObserve)}</span>
            <span id="setupSessionsStatus" class="badge badge-neutral">—</span>
          </div>
          <div id="setupSessionsDetail" style="font-size: 13px; color: var(--text-muted); margin-top: 8px;"></div>
        </div>

        <div class="card" style="margin-bottom: 16px;">
          <div class="card-label">${escapeHtml(messages.setupStepFirstAction)}</div>
          <div style="font-size: 14px; margin-top: 8px;">${escapeHtml(messages.setupFirstActionBody)}</div>
        </div>

        <div class="card" style="margin-bottom: 16px;">
          <div class="card-label">${escapeHtml(messages.setupStepOrientation)}</div>
          <div style="font-size: 14px; margin-top: 8px;">${escapeHtml(messages.setupOrientationBody)}</div>
          <div style="display: flex; gap: 12px; margin-top: 12px;">
            <button class="btn btn-secondary" onclick="showTab('approvals')">${escapeHtml(messages.setupOpenApprovals)}</button>
            <button class="btn btn-secondary" onclick="showTab('activity')">${escapeHtml(messages.setupOpenActivity)}</button>
          </div>
        </div>
      </section>

      <!-- 2. ACCESS PANEL -->
      <section id="panel-access" class="panel">
        <div class="panel-header">
          <h1 class="panel-title">${escapeHtml(messages.accessTitle)}</h1>
          <p class="panel-desc">Manage permitted folders and inspect execution containment boundaries.</p>
        </div>

        <div class="card" style="margin-bottom: 20px;">
          <div class="card-label">${escapeHtml(messages.foldersTitle)}</div>
          <div id="accessFoldersList" style="margin-top: 12px;">
            <div style="color: var(--text-muted);">${escapeHtml(messages.foldersEmpty)}</div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 20px;">
          <div class="card-label">${escapeHtml(messages.terminalTitle)}</div>
          <div style="margin-top: 8px; font-size: 14px;">
            Effective mode: <strong>${escapeHtml(terminalMode.toUpperCase())}</strong>
          </div>
          <div class="banner banner-info" style="margin-top: 12px; margin-bottom: 0;">
            ${escapeHtml(messages.terminalSafeDistinction)}
          </div>
        </div>

        <div class="card">
          <div class="card-label">Configure Permissions (Admin)</div>
          <div class="form-group" style="margin-top: 12px;">
            <label class="form-label" for="editPresetSelect">Capability Profile Preset</label>
            <select id="editPresetSelect" class="form-control">
              <option value="safe">Safe (Read-only tools)</option>
              <option value="balanced">Balanced (Standard development)</option>
              <option value="power">Power (Broad system access)</option>
              <option value="minimal">Minimal</option>
              <option value="core">Core</option>
              <option value="dev">Dev</option>
              <option value="sysadmin">Sysadmin</option>
              <option value="full">Full (Unrestricted)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="editFoldersText">Allowed Folders (One per line, optional ::alias)</label>
            <textarea id="editFoldersText" class="form-control" rows="4" placeholder="C:\\Projects\\MyApp::workspace"></textarea>
          </div>
          <div class="form-group" id="accessConfirmGroup" style="display:none;">
            <label class="form-label" for="accessConfirmInput" style="color: var(--warning);">Confirmation Required</label>
            <div class="form-desc">${escapeHtml(messages.confirmType)}</div>
            <input type="text" id="accessConfirmInput" class="form-control" placeholder="confirm">
          </div>
          <div style="display: flex; gap: 12px;">
            <button class="btn btn-secondary" onclick="handleAccessPreview()">${escapeHtml(messages.accessPreview)}</button>
            <button class="btn btn-primary" onclick="handleAccessApply()">${escapeHtml(messages.accessSave)}</button>
          </div>
          <div id="accessActionResult" class="approval-text-preview" style="display:none; margin-top: 16px;"></div>
        </div>
      </section>

      <!-- 3. APPROVALS PANEL -->
      <section id="panel-approvals" class="panel">
        <div class="panel-header">
          <h1 class="panel-title">${escapeHtml(messages.approvalsTitle)} · Approval Jobs</h1>
          <p class="panel-desc">${escapeHtml(messages.approvalsOnce)} · ${escapeHtml(messages.approvalsNote)}</p>
        </div>

        <div id="approvalJobs">
          <div class="card" style="text-align: center; color: var(--text-muted); padding: 32px;">
            ${escapeHtml(messages.approvalsEmpty)}
          </div>
        </div>
      </section>

      <!-- 4. ACTIVITY PANEL -->
      <section id="panel-activity" class="panel">
        <div class="panel-header">
          <h1 class="panel-title">${escapeHtml(messages.activityTitle)}</h1>
          <p class="panel-desc">Recent tool calls, HTTP requests, and security audit log events.</p>
        </div>

        <div style="display: flex; gap: 8px; margin-bottom: 16px;">
          <button class="btn btn-primary" id="btnActAll" onclick="setActivityFilter('all')">${escapeHtml(messages.filterAll)}</button>
          <button class="btn btn-secondary" id="btnActTools" onclick="setActivityFilter('tool')">${escapeHtml(messages.filterTools)}</button>
          <button class="btn btn-secondary" id="btnActSec" onclick="setActivityFilter('security')">${escapeHtml(messages.filterSecurity)}</button>
          <button class="btn btn-secondary" id="btnActErr" onclick="setActivityFilter('error')">${escapeHtml(messages.filterErrors)}</button>
        </div>

        <div class="card" style="padding: 0; overflow: hidden; margin-bottom: 16px;">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 100px;">Time</th>
                <th style="width: 90px;">Type</th>
                <th style="width: 180px;">Action</th>
                <th>Details</th>
                <th style="width: 80px;">Latency</th>
                <th style="width: 90px;">Status</th>
              </tr>
            </thead>
            <tbody id="activityTableBody">
              <tr><td colspan="6" style="text-align:center; padding: 24px; color: var(--text-muted);">${escapeHtml(messages.activityEmpty)}</td></tr>
            </tbody>
          </table>
        </div>

        <div style="font-size: 12px; color: var(--text-muted);">
          ${escapeHtml(messages.activityAdvancedHint)} <a href="/dashboard" style="color: #60a5fa;">Open Dashboard</a>
        </div>
      </section>

      <!-- 5. CONNECTIONS PANEL -->
      <section id="panel-connections" class="panel">
        <div class="panel-header">
          <h1 class="panel-title">${escapeHtml(messages.connTitle)}</h1>
          <p class="panel-desc">Configure MCP client integrations and monitor connection state.</p>
        </div>

        <div class="card-grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));">
          <!-- Claude Desktop -->
          <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <span style="font-size: 16px; font-weight: 700; color: #fff;">${escapeHtml(messages.connClaudeLabel)}</span>
              <span class="badge badge-primary">${escapeHtml(messages.connClaudeType)}</span>
            </div>
            <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">Direct local client connection via native config update.</p>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-secondary" onclick="handleClientPreview('claude')">Preview</button>
              <button class="btn btn-primary" onclick="handleClientApply('claude')">${escapeHtml(messages.connConfigure)}</button>
            </div>
          </div>

          <!-- Cursor -->
          <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <span style="font-size: 16px; font-weight: 700; color: #fff;">${escapeHtml(messages.connCursorLabel)}</span>
              <span class="badge badge-primary">${escapeHtml(messages.connCursorType)}</span>
            </div>
            <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">Workspace and editor client integration via local config.</p>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-secondary" onclick="handleClientPreview('cursor')">Preview</button>
              <button class="btn btn-primary" onclick="handleClientApply('cursor')">${escapeHtml(messages.connConfigure)}</button>
            </div>
          </div>

          <!-- ChatGPT / OpenAI -->
          <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <span style="font-size: 16px; font-weight: 700; color: #fff;">${escapeHtml(messages.connChatgptLabel)}</span>
              <span class="badge badge-primary">${escapeHtml(messages.connChatgptType)}</span>
            </div>
            <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">${escapeHtml(messages.connChatgptLifecycleTitle)}</p>
            <div style="font-size: 13px; line-height: 1.9;">
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">${escapeHtml(messages.connChatgptDependencyLabel)}</span>
                <span id="tunnelDependencyStatus" class="badge badge-neutral">…</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">${escapeHtml(messages.connChatgptProfileLabel)}</span>
                <span id="tunnelProfileStatus" class="badge badge-neutral">…</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">${escapeHtml(messages.connChatgptBackendLabel)}</span>
                <span id="tunnelBackendStatus" class="badge badge-neutral">…</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">${escapeHtml(messages.connChatgptStateLabel)}</span>
                <span id="tunnelStateBadge" class="badge badge-neutral">…</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">${escapeHtml(messages.connChatgptOwnershipLabel)}</span>
                <span id="tunnelOwnershipBadge" class="badge badge-neutral">…</span>
              </div>
            </div>
            <div id="tunnelDetail" style="font-size: 12px; color: var(--text-muted); margin-top: 10px; word-break: break-all;"></div>
            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px;">
              <button class="btn btn-primary" onclick="handleTunnelStart()">${escapeHtml(messages.connChatgptActionStart)}</button>
              <button class="btn btn-danger" onclick="handleTunnelStop()">${escapeHtml(messages.connChatgptActionStop)}</button>
              <button class="btn btn-secondary" onclick="handleTunnelRestart()">${escapeHtml(messages.connChatgptActionRestart)}</button>
              <button class="btn btn-secondary" onclick="handleTunnelDoctor()">${escapeHtml(messages.connChatgptActionDoctor)}</button>
            </div>
            <div id="tunnelConfirmGroup" style="display: none; margin-top: 10px;">
              <div class="form-desc" style="margin-bottom: 6px;">${escapeHtml(messages.connChatgptConfirmHint)}</div>
              <input type="text" id="tunnelConfirmInput" class="form-control" placeholder="${escapeHtml(messages.connChatgptConfirmPlaceholder)}" autocomplete="off">
            </div>
            <div id="tunnelActionResult" class="approval-text-preview" style="display: none; margin-top: 12px;"></div>
          </div>

          <!-- Tailscale HTTPS -->
          <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <span style="font-size: 16px; font-weight: 700; color: #fff;">${escapeHtml(messages.connTailscaleLabel)}</span>
              <span class="badge badge-neutral">${escapeHtml(messages.connTailscaleType)}</span>
            </div>
            <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">End-to-end encrypted mesh remote access. Requires manual Tailscale Funnel / Serve configuration.</p>
            <div>
              <span class="badge badge-neutral">Manual Configuration</span>
            </div>
          </div>
        </div>

        <div id="clientActionResult" class="approval-text-preview" style="display:none; margin-top: 16px;"></div>

        <div class="card" style="margin-top: 24px;">
          <div class="card-label">Active Connected Client Sessions</div>
          <div id="liveClientSessionsList" style="margin-top: 12px;">
            <div style="color: var(--text-muted); font-size: 13px;">Checking active sessions…</div>
          </div>
        </div>
      </section>

      <!-- 6. SETTINGS PANEL -->
      <section id="panel-settings" class="panel">
        <div class="panel-header">
          <h1 class="panel-title">${escapeHtml(messages.settingsTitle)}</h1>
          <p class="panel-desc">Manage system preferences, approval policy, and authentication credentials.</p>
        </div>

        <div class="card" style="max-width: 600px; margin-bottom: 24px;">
          <div class="form-group">
            <label class="form-label" for="settingsApprovalModeSelect">${escapeHtml(messages.settingsApprovalMode)}</label>
            <div class="form-desc">Controls when AI tool actions require explicit human confirmation.</div>
            <select id="settingsApprovalModeSelect" class="form-control">
              <option value="manual">Manual (Confirm modifying actions)</option>
              <option value="smart">Smart (Automate low-risk reads)</option>
              <option value="trusted">Trusted (Autonomous trusted lane)</option>
            </select>
          </div>
          <div style="margin-bottom: 18px;">
            <button class="btn btn-primary" onclick="handleApprovalModeApply()">${escapeHtml(messages.settingsSave)}</button>
          </div>
          <div id="approvalModeResult" class="approval-text-preview" style="display:none;"></div>

          <div class="nav-divider"></div>

          <div class="form-group">
            <label class="form-label">${escapeHtml(messages.settingsToken)}</label>
            <div class="form-desc">Replace master token immediately. All clients must update their token.</div>
            <button class="btn btn-secondary" onclick="handleRotateToken()">${escapeHtml(messages.tokenRotate)}</button>
          </div>
          <div id="tokenResult" class="approval-text-preview" style="display:none;"></div>

          <div class="nav-divider"></div>

          <div class="banner banner-warning" style="margin-bottom: 0;">
            ${escapeHtml(messages.settingsDangerousNotice)}
          </div>
        </div>
      </section>
    </main>
  </div>

  <!-- ADMIN UNLOCK MODAL -->
  <div id="adminModal" class="modal-overlay">
    <div class="modal-card">
      <h2 class="modal-title">${escapeHtml(messages.adminRequired)}</h2>
      <p class="modal-desc">${escapeHtml(messages.adminInstructions)}</p>
      <div class="form-group">
        <input type="password" id="adminCodeInput" class="form-control" style="max-width: 100%;" placeholder="${escapeHtml(messages.adminPlaceholder)}" autocomplete="off">
        <div id="adminModalError" style="color: var(--danger); font-size: 12px; margin-top: 6px;"></div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn btn-secondary" onclick="closeAdminModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAdminCode()">${escapeHtml(messages.adminUnlock)}</button>
      </div>
    </div>
  </div>

  <script>
    const SHELL_MESSAGES = ${clientScriptMessages};
    const INITIAL_FOCUS_JOB_ID = ${JSON.stringify(focusJobId).replace(/</g, "\\u003c")};

    let adminCsrfToken = null;
    let isAdminUnlocked = false;
    let activityCache = [];
    let currentActivityFilter = 'all';
    let pendingApprovalShortcuts = [];
    let setupAutoSurfaced = false;
    let lastProfile = null;
    let lastSessions = [];
    let lastClientStatus = [];
    let lastTunnelStatus = null;

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function showTab(tabName) {
      document.querySelectorAll('.nav-item').forEach(btn => {
        if (btn.getAttribute('data-tab') === tabName) {
          btn.classList.add('active');
        } else if (btn.getAttribute('data-tab')) {
          btn.classList.remove('active');
        }
      });
      document.querySelectorAll('.panel').forEach(p => {
        if (p.id === 'panel-' + tabName) {
          p.classList.add('active');
        } else {
          p.classList.remove('active');
        }
      });
    }

    function setActivityFilter(filter) {
      currentActivityFilter = filter;
      const btns = {
        all: document.getElementById('btnActAll'),
        tool: document.getElementById('btnActTools'),
        security: document.getElementById('btnActSec'),
        error: document.getElementById('btnActErr')
      };
      Object.keys(btns).forEach(key => {
        if (btns[key]) {
          btns[key].className = key === filter ? 'btn btn-primary' : 'btn btn-secondary';
        }
      });
      renderActivityTable();
    }

    async function apiRequest(url, options) {
      const init = Object.assign({}, options || {});
      init.headers = Object.assign({}, init.headers || {});
      const method = String(init.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && adminCsrfToken) {
        init.headers['x-winhelm-csrf'] = adminCsrfToken;
      }
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = (data && data.error && data.error.message) ? data.error.message : ('Request failed (' + res.status + ')');
        const err = new Error(message);
        err.code = (data && data.error && data.error.code) ? data.error.code : 'REQUEST_FAILED';
        err.status = res.status;
        err.details = data && data.error && data.error.details;
        throw err;
      }
      return data;
    }

    function openAdminModal() {
      document.getElementById('adminModal').classList.add('open');
      document.getElementById('adminCodeInput').value = '';
      document.getElementById('adminModalError').textContent = '';
      document.getElementById('adminCodeInput').focus();
    }

    function closeAdminModal() {
      document.getElementById('adminModal').classList.remove('open');
    }

    function handleAdminPillClick() {
      if (isAdminUnlocked) {
        if (window.confirm('Lock admin session now?')) {
          apiRequest('/admin/auth/logout', { method: 'POST' }).finally(() => {
            isAdminUnlocked = false;
            adminCsrfToken = null;
            updateAdminUI();
          });
        }
      } else {
        openAdminModal();
      }
    }

    function updateAdminUI() {
      const pill = document.getElementById('adminPill');
      const dot = document.getElementById('adminDot');
      const text = document.getElementById('adminPillText');
      if (isAdminUnlocked) {
        pill.classList.add('unlocked');
        dot.className = 'status-dot green';
        text.textContent = SHELL_MESSAGES.adminUnlocked;
      } else {
        pill.classList.remove('unlocked');
        dot.className = 'status-dot yellow';
        text.textContent = SHELL_MESSAGES.adminLocked;
      }
    }

    async function submitAdminCode() {
      const code = document.getElementById('adminCodeInput').value.trim();
      const errBox = document.getElementById('adminModalError');
      errBox.textContent = '';
      if (!code) {
        errBox.textContent = 'Please enter an admin code.';
        return;
      }
      try {
        const body = await apiRequest('/admin/auth/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code })
        });
        adminCsrfToken = body.csrfToken;
        isAdminUnlocked = true;
        closeAdminModal();
        updateAdminUI();
        refreshAllData();
      } catch (err) {
        errBox.textContent = err.message || 'Invalid admin code.';
      }
    }

    async function ensureAdminUnlocked() {
      if (!isAdminUnlocked) {
        openAdminModal();
        return false;
      }
      return true;
    }

    async function fetchStatsAndLogs() {
      try {
        const [stats, logs] = await Promise.all([
          apiRequest('/api/monitor/stats').catch(() => null),
          apiRequest('/api/monitor/logs').catch(() => ({ logs: [] }))
        ]);

        if (stats) {
          const sText = document.getElementById('statServerInfo');
          if (sText) sText.textContent = 'Port ' + stats.port + ' · Host ' + stats.host;
        }

        if (logs && Array.isArray(logs.logs)) {
          activityCache = logs.logs;
          renderActivityTable();
        }
      } catch (e) {
        console.warn('Stats/logs fetch error', e);
      }
    }

    function renderActivityTable() {
      const tbody = document.getElementById('activityTableBody');
      if (!tbody) return;
      const filtered = activityCache.filter(item => {
        if (currentActivityFilter === 'all') return true;
        if (currentActivityFilter === 'tool') return item.type === 'tool';
        if (currentActivityFilter === 'security') return item.type === 'security';
        if (currentActivityFilter === 'error') return item.type === 'error' || item.level === 'error';
        return true;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">' + escapeHtml(SHELL_MESSAGES.activityEmpty) + '</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.slice(0, 50).map(log => {
        let badgeClass = 'badge-primary';
        let typeLabel = 'TOOL';
        if (log.type === 'req') { badgeClass = 'badge-neutral'; typeLabel = 'HTTP'; }
        if (log.type === 'security') { badgeClass = 'badge-warning'; typeLabel = 'SECURITY'; }
        if (log.type === 'error' || log.level === 'error') { badgeClass = 'badge-danger'; typeLabel = 'ERROR'; }

        let statusClass = 'badge-success';
        if (log.status === 'RUNNING') statusClass = 'badge-warning';
        if (log.status === 'FAILED' || log.status === 'BLOCKED' || (typeof log.status === 'number' && log.status >= 400)) statusClass = 'badge-danger';

        const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '--:--';
        const duration = log.durationMs !== undefined ? (log.durationMs + 'ms') : '-';
        const title = escapeHtml(log.title || log.action || '-');
        const detail = escapeHtml(log.detail || '-');
        const statusText = escapeHtml(log.status !== undefined && log.status !== null ? String(log.status) : 'OK');

        return '<tr>' +
          '<td style="color: var(--text-muted);">' + timeStr + '</td>' +
          '<td><span class="badge ' + badgeClass + '">' + typeLabel + '</span></td>' +
          '<td style="font-weight: 600; color: #fff;">' + title + '</td>' +
          '<td style="color: #cbd5e1; word-break: break-all;">' + detail + '</td>' +
          '<td style="color: var(--text-muted);">' + duration + '</td>' +
          '<td><span class="badge ' + statusClass + '">' + statusText + '</span></td>' +
        '</tr>';
      }).join('');
    }

    async function fetchAdminData() {
      if (!isAdminUnlocked) return;
      try {
        const [profileRes, approvalsRes, sessionsRes, clientStatusRes] = await Promise.all([
          apiRequest('/admin/profile').catch(() => null),
          apiRequest('/admin/approvals').catch(() => null),
          apiRequest('/admin/sessions').catch(() => null),
          apiRequest('/admin/clients/status').catch(() => null)
        ]);

        if (profileRes && profileRes.profile) {
          lastProfile = profileRes.profile;
          renderProfileData(profileRes.profile);
        }
        if (approvalsRes && Array.isArray(approvalsRes.jobs)) {
          renderApprovals(approvalsRes.jobs);
        }
        if (sessionsRes && Array.isArray(sessionsRes.sessions)) {
          lastSessions = sessionsRes.sessions;
          renderSessions(sessionsRes.sessions);
        }
        if (clientStatusRes && Array.isArray(clientStatusRes.clients)) {
          lastClientStatus = clientStatusRes.clients;
        }
        renderSetup();
        fetchTunnelStatus();

        const profileFolders = (profileRes && profileRes.profile && Array.isArray(profileRes.profile.folders))
          ? profileRes.profile.folders
          : [];
        if (!setupAutoSurfaced && profileFolders.length === 0) {
          setupAutoSurfaced = true;
          showTab('setup');
        }
      } catch (e) {
        console.warn('Admin fetch error', e);
      }
    }

    function setupBadgeClass(status) {
      if (status === 'complete' || status === 'configured' || status === 'active') return 'badge-success';
      if (status === 'attention') return 'badge-danger';
      if (status === 'needs_configuration' || status === 'incomplete') return 'badge-warning';
      return 'badge-neutral';
    }

    function setSetupBadge(id, label, status) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = label;
      el.className = 'badge ' + setupBadgeClass(status);
    }

    function renderSetupClientStatus(clientKey, statusId, detailId) {
      const entry = (lastClientStatus || []).find(c => c.client === clientKey);
      const statusEl = document.getElementById(statusId);
      const detailEl = document.getElementById(detailId);
      if (!statusEl || !detailEl) return;
      if (!entry) {
        statusEl.textContent = '—';
        statusEl.className = 'badge badge-neutral';
        detailEl.textContent = '';
        return;
      }
      const labels = {
        configured: SHELL_MESSAGES.setupStatusConfigured,
        needs_configuration: SHELL_MESSAGES.setupStatusNeedsConfiguration,
        attention: SHELL_MESSAGES.setupStatusAttention
      };
      statusEl.textContent = labels[entry.status] || entry.status;
      statusEl.className = 'badge ' + setupBadgeClass(entry.status);
      const detailParts = [];
      if (entry.configPath) detailParts.push(entry.configPath);
      if (entry.errorCode) detailParts.push(entry.errorCode);
      if (entry.warningCount > 0) detailParts.push('warnings: ' + entry.warningCount);
      detailEl.textContent = detailParts.join(' · ');
    }

    function renderSetup() {
      const lockedNotice = document.getElementById('setupLockedNotice');
      if (!lockedNotice) return;
      if (!isAdminUnlocked) {
        lockedNotice.style.display = 'block';
        return;
      }
      lockedNotice.style.display = 'none';

      const profile = lastProfile;
      const folders = profile && Array.isArray(profile.folders) ? profile.folders : [];
      const workspaceComplete = folders.length > 0;
      setSetupBadge('setupWorkspaceStatus',
        workspaceComplete ? SHELL_MESSAGES.setupStatusComplete : SHELL_MESSAGES.setupStatusIncomplete,
        workspaceComplete ? 'complete' : 'incomplete');
      const workspaceDetail = document.getElementById('setupWorkspaceDetail');
      if (workspaceDetail) {
        workspaceDetail.textContent = folders.map(f => f.path).join('; ');
      }

      const preset = profile ? (profile.preset || (profile.schemaMode === 'legacy' ? 'legacy' : '')) : '';
      setSetupBadge('setupProfileStatus',
        preset ? SHELL_MESSAGES.setupStatusComplete : SHELL_MESSAGES.setupStatusIncomplete,
        preset ? 'complete' : 'incomplete');
      const profileDetail = document.getElementById('setupProfileDetail');
      if (profileDetail) {
        profileDetail.textContent = SHELL_MESSAGES.setupCurrent + ': ' + (preset || '-');
      }

      const approvalMode = profile ? profile.approvalMode : '';
      setSetupBadge('setupApprovalStatus',
        approvalMode ? SHELL_MESSAGES.setupStatusComplete : SHELL_MESSAGES.setupStatusIncomplete,
        approvalMode ? 'complete' : 'incomplete');
      const approvalDetail = document.getElementById('setupApprovalDetail');
      if (approvalDetail) {
        approvalDetail.textContent = SHELL_MESSAGES.setupCurrent + ': ' + (approvalMode || '-');
      }

      renderSetupClientStatus('claude', 'setupClientClaudeStatus', 'setupClientClaudeDetail');
      renderSetupClientStatus('cursor', 'setupClientCursorStatus', 'setupClientCursorDetail');

      const activeCount = (lastSessions || []).length;
      setSetupBadge('setupSessionsStatus',
        activeCount > 0 ? SHELL_MESSAGES.setupStatusActive : SHELL_MESSAGES.setupStatusNotObserved,
        activeCount > 0 ? 'active' : 'neutral');
      const sessionsDetail = document.getElementById('setupSessionsDetail');
      if (sessionsDetail) {
        sessionsDetail.textContent = lastSessions
          .map(s => ((s.clientInfo && s.clientInfo.name) || 'Client') + ' (' + (s.sessionId || 'n/a') + ')')
          .join('; ');
      }
    }

    function renderProfileData(p) {
      const presetSelect = document.getElementById('editPresetSelect');
      if (presetSelect && p.preset) presetSelect.value = p.preset;

      const modeSelect = document.getElementById('settingsApprovalModeSelect');
      if (modeSelect && p.approvalMode) modeSelect.value = p.approvalMode;

      const statProf = document.getElementById('statProfile');
      if (statProf) statProf.textContent = String(p.preset || 'modified').toUpperCase();

      const statApp = document.getElementById('statApprovalMode');
      if (statApp) statApp.textContent = String(p.approvalMode || 'manual').toUpperCase();

      const statTerm = document.getElementById('statTerminalMode');
      if (statTerm) statTerm.textContent = String(p.terminalMode || 'off');

      const foldersList = document.getElementById('accessFoldersList');
      if (foldersList) {
        const folders = Array.isArray(p.folders) ? p.folders : [];
        if (folders.length === 0) {
          foldersList.innerHTML = '<div style="color: var(--text-muted);">' + escapeHtml(SHELL_MESSAGES.foldersEmpty) + '</div>';
        } else {
          foldersList.innerHTML = folders.map(f => {
            const permBadge = f.permission === 'readwrite'
              ? '<span class="badge badge-warning">' + escapeHtml(SHELL_MESSAGES.folderReadwrite) + '</span>'
              : '<span class="badge badge-neutral">' + escapeHtml(SHELL_MESSAGES.folderRead) + '</span>';
            const aliasTag = f.alias ? '<span style="color: #60a5fa; margin-left: 8px;">@' + escapeHtml(f.alias) + '</span>' : '';
            return '<div style="display:flex; justify-content:space-between; align-items:center; padding: 8px 0; border-bottom: 1px solid var(--border-color);">' +
              '<div><span style="font-family: Consolas, monospace;">' + escapeHtml(f.path) + '</span>' + aliasTag + '</div>' +
              '<div>' + permBadge + '</div>' +
            '</div>';
          }).join('');
        }

        const editFoldersText = document.getElementById('editFoldersText');
        if (editFoldersText) {
          editFoldersText.value = folders.map(f => f.alias ? (f.path + '::' + f.alias) : f.path).join('\\n');
        }
      }
    }

    function renderApprovals(jobs) {
      const target = document.getElementById('approvalJobs');
      const countPill = document.getElementById('statPendingApprovals');
      const sideBadge = document.getElementById('sidebarApprovalCount');
      if (!target) return;

      const pending = jobs.filter(j => j.state === 'awaiting_approval');
      if (countPill) countPill.textContent = String(pending.length);
      if (sideBadge) {
        sideBadge.textContent = String(pending.length);
        sideBadge.style.display = pending.length > 0 ? 'inline-block' : 'none';
      }

      pendingApprovalShortcuts = pending.map(j => String(j.id || '')).filter(Boolean);

      if (jobs.length === 0) {
        target.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted); padding: 32px;">' +
          escapeHtml(SHELL_MESSAGES.approvalsEmpty) +
        '</div>';
        return;
      }

      target.innerHTML = jobs.map(job => {
        const isPending = job.state === 'awaiting_approval';
        const isFocused = INITIAL_FOCUS_JOB_ID && job.id === INITIAL_FOCUS_JOB_ID;
        const focusedClass = isFocused ? ' focused' : '';
        const risk = job.risk || {};
        const riskBadge = '<span class="badge badge-danger">' + escapeHtml(risk.class || 'R?') + ' · ' + escapeHtml(risk.label || 'Risk') + '</span>';
        const clientInfo = job.clientInfo || {};
        const clientName = escapeHtml(clientInfo.name || 'Unknown Client');

        let actionsHtml = '';
        if (isPending) {
          actionsHtml = '<div style="display: flex; gap: 8px; margin-top: 14px;">' +
            '<button class="btn btn-success" onclick="executeApproval(\\'' + escapeHtml(job.id) + '\\', \\'approve\\')">' + escapeHtml(SHELL_MESSAGES.approvalsApprove) + '</button>' +
            '<button class="btn btn-danger" onclick="executeApproval(\\'' + escapeHtml(job.id) + '\\', \\'deny\\')">' + escapeHtml(SHELL_MESSAGES.approvalsDeny) + '</button>' +
          '</div>';
        }

        const argsText = job.arguments ? JSON.stringify(job.arguments, null, 2) : '';

        return '<div class="approval-item' + focusedClass + '" id="job-' + escapeHtml(job.id) + '">' +
          '<div class="approval-header">' +
            '<div class="approval-tool">' + escapeHtml(job.tool || 'Tool') + ' <span class="badge badge-neutral">' + escapeHtml(job.state) + '</span></div>' +
            '<div>' + riskBadge + '</div>' +
          '</div>' +
          '<div class="approval-grid">' +
            '<div><div class="approval-field-label">' + escapeHtml(SHELL_MESSAGES.approvalsClient) + '</div><div class="approval-field-val">' + clientName + '</div></div>' +
            '<div><div class="approval-field-label">Job ID</div><div class="approval-field-val">' + escapeHtml(job.id) + '</div></div>' +
            '<div><div class="approval-field-label">Session</div><div class="approval-field-val">' + escapeHtml(job.sessionId || '-') + '</div></div>' +
          '</div>' +
          (argsText ? ('<div class="approval-field-label" style="margin-bottom:4px;">' + escapeHtml(SHELL_MESSAGES.approvalsPreview) + '</div><div class="approval-text-preview">' + escapeHtml(argsText) + '</div>') : '') +
          actionsHtml +
        '</div>';
      }).join('');

      if (INITIAL_FOCUS_JOB_ID) {
        const el = document.getElementById('job-' + INITIAL_FOCUS_JOB_ID);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }
    }

    function renderSessions(sessions) {
      const target = document.getElementById('liveClientSessionsList');
      const overviewList = document.getElementById('overviewConnectionsList');

      if (sessions.length === 0) {
        const emptyHtml = '<div style="color: var(--text-muted); font-size: 13px;">No active client sessions announced.</div>';
        if (target) target.innerHTML = emptyHtml;
        if (overviewList) overviewList.innerHTML = emptyHtml;
        return;
      }

      const itemsHtml = sessions.map(s => {
        const c = s.clientInfo || {};
        const label = escapeHtml(c.name || 'Client') + (c.version ? (' ' + escapeHtml(c.version)) : '');
        const pendingCount = s.pendingApprovals || 0;
        return '<div style="background: var(--bg-card); padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
          '<div><strong>' + label + '</strong> <span style="color: var(--text-muted); font-size: 12px; margin-left: 8px;">session ' + escapeHtml(s.sessionId || 'n/a') + '</span></div>' +
          '<div>' + (pendingCount > 0 ? ('<span class="badge badge-warning">' + pendingCount + ' pending</span>') : '<span class="badge badge-success">Connected</span>') + '</div>' +
        '</div>';
      }).join('');

      if (target) target.innerHTML = itemsHtml;
      if (overviewList) overviewList.innerHTML = itemsHtml;
    }

    async function executeApproval(jobId, action) {
      if (!await ensureAdminUnlocked()) return;
      try {
        await apiRequest('/admin/approvals/' + encodeURIComponent(jobId) + '/' + action, { method: 'POST' });
        await fetchAdminData();
      } catch (err) {
        alert(err.message || 'Approval action failed');
      }
    }

    function parseFoldersInput() {
      const raw = document.getElementById('editFoldersText').value;
      return raw.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean).map(line => {
        const marker = line.lastIndexOf('::');
        if (marker > 1) {
          const p = line.slice(0, marker).trim();
          const alias = line.slice(marker + 2).trim();
          if (p && alias) return { path: p, alias: alias };
        }
        return { path: line };
      });
    }

    async function handleAccessPreview() {
      if (!await ensureAdminUnlocked()) return;
      const resBox = document.getElementById('accessActionResult');
      resBox.style.display = 'block';
      resBox.textContent = 'Generating preview…';
      try {
        const payload = {
          preset: document.getElementById('editPresetSelect').value,
          folders: parseFoldersInput()
        };
        const conf = document.getElementById('accessConfirmInput').value.trim();
        if (conf) payload.confirmation = conf;

        const body = await apiRequest('/admin/profiles/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const p = body.preview || {};
        const lines = [
          'Preview Preset: ' + p.preset,
          'Terminal Mode: ' + p.terminalMode,
          'Changed Fields: ' + (p.changedFields && p.changedFields.length ? p.changedFields.join(', ') : 'none'),
          'Folders: ' + (p.folders ? p.folders.length : 0)
        ];
        if (p.requiresTypedConfirmation) {
          lines.push('CONFIRMATION REQUIRED: Please type "confirm" below before applying.');
          document.getElementById('accessConfirmGroup').style.display = 'block';
        } else {
          document.getElementById('accessConfirmGroup').style.display = 'none';
        }
        (p.warnings || []).forEach(w => lines.push('WARNING: ' + w));
        resBox.textContent = lines.join('\\n');
      } catch (err) {
        resBox.textContent = 'Preview error: ' + (err.message || String(err));
      }
    }

    async function handleAccessApply() {
      if (!await ensureAdminUnlocked()) return;
      const resBox = document.getElementById('accessActionResult');
      resBox.style.display = 'block';
      resBox.textContent = 'Applying changes…';
      try {
        const payload = {
          preset: document.getElementById('editPresetSelect').value,
          folders: parseFoldersInput()
        };
        const conf = document.getElementById('accessConfirmInput').value.trim();
        if (conf) payload.confirmation = conf;

        const body = await apiRequest('/admin/profiles/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        resBox.textContent = 'Permissions applied successfully.' + (body.backupPath ? ('\\nBackup created: ' + body.backupPath) : '');
        document.getElementById('accessConfirmInput').value = '';
        document.getElementById('accessConfirmGroup').style.display = 'none';
        refreshAllData();
      } catch (err) {
        resBox.textContent = 'Apply error: ' + (err.message || String(err));
      }
    }

    async function handleApprovalModeApply() {
      if (!await ensureAdminUnlocked()) return;
      const resBox = document.getElementById('approvalModeResult');
      resBox.style.display = 'block';
      resBox.textContent = 'Applying approval mode…';
      try {
        const mode = document.getElementById('settingsApprovalModeSelect').value;
        const body = await apiRequest('/admin/approval-mode/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalMode: mode })
        });
        resBox.textContent = 'Approval mode set to ' + mode.toUpperCase() + '.' + (body.backupPath ? ('\\nBackup: ' + body.backupPath) : '');
        refreshAllData();
      } catch (err) {
        resBox.textContent = 'Approval mode error: ' + (err.message || String(err));
      }
    }

    async function handleRotateToken() {
      if (!await ensureAdminUnlocked()) return;
      if (!window.confirm(SHELL_MESSAGES.tokenConfirm)) return;
      const resBox = document.getElementById('tokenResult');
      resBox.style.display = 'block';
      resBox.textContent = 'Rotating token…';
      try {
        const body = await apiRequest('/admin/auth/token/rotate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmation: 'confirm' })
        });
        resBox.textContent = SHELL_MESSAGES.tokenNew + '\\n' + body.token + '\\n\\n' + SHELL_MESSAGES.tokenOnce;
      } catch (err) {
        resBox.textContent = 'Token rotate error: ' + (err.message || String(err));
      }
    }

    async function handleClientPreview(clientName) {
      if (!await ensureAdminUnlocked()) return;
      const resBox = document.getElementById('clientActionResult');
      resBox.style.display = 'block';
      resBox.textContent = 'Loading client preview…';
      try {
        const body = await apiRequest('/admin/clients/' + encodeURIComponent(clientName) + '/preview', { method: 'POST' });
        const p = body.preview || {};
        const lines = [
          'Target: ' + (p.target && p.target.displayName || clientName),
          'Config Path: ' + (p.target && p.target.configPath || 'unknown'),
          'Config File Exists: ' + (p.target && p.target.configFileExists ? 'yes' : 'no'),
          'Changed: ' + (p.changed ? 'yes' : 'no'),
          'Command: ' + (p.proposedEntry && p.proposedEntry.command || '')
        ];
        (p.warnings || []).forEach(w => lines.push('WARNING: ' + w));
        resBox.textContent = lines.join('\\n');
      } catch (err) {
        resBox.textContent = 'Client preview error: ' + (err.message || String(err));
      }
    }

    async function handleClientApply(clientName) {
      if (!await ensureAdminUnlocked()) return;
      const resBox = document.getElementById('clientActionResult');
      resBox.style.display = 'block';
      resBox.textContent = 'Configuring client…';
      try {
        const body = await apiRequest('/admin/clients/' + encodeURIComponent(clientName) + '/apply', { method: 'POST' });
        resBox.textContent = 'Client configured successfully.' + (body.backupPath ? ('\\nBackup created: ' + body.backupPath) : '') + '\\n' + SHELL_MESSAGES.connRestartHint;
      } catch (err) {
        resBox.textContent = 'Client configure error: ' + (err.message || String(err));
      }
    }

    function tunnelBadgeClass(kind) {
      if (kind === 'ok') return 'badge badge-success';
      if (kind === 'warn') return 'badge badge-warning';
      if (kind === 'bad') return 'badge badge-danger';
      return 'badge badge-neutral';
    }

    function setTunnelBadge(id, kind, label) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = label;
      el.className = tunnelBadgeClass(kind);
    }

    function renderTunnelStatus(status) {
      if (!status) return;
      const dep = status.dependency || {};
      setTunnelBadge('tunnelDependencyStatus',
        dep.state === 'qualified' ? 'ok' : (dep.state === 'unqualified' ? 'bad' : 'warn'),
        dep.state || 'missing');
      setTunnelBadge('tunnelProfileStatus',
        status.profile && status.profile.state === 'ready' ? 'ok' : 'warn',
        status.profile ? status.profile.state : 'missing');
      setTunnelBadge('tunnelBackendStatus',
        status.backend && status.backend.state === 'ready' ? 'ok' : (status.backend && status.backend.state === 'stale' ? 'bad' : 'warn'),
        status.backend ? status.backend.state : 'attention');

      const daemon = status.daemon || {};
      const stateKind = daemon.state === 'managed_ready' ? 'ok'
        : (daemon.state === 'managed_starting' || daemon.state === 'managed_degraded') ? 'warn'
        : (daemon.state === 'external_running' ? 'ok' : 'neutral');
      setTunnelBadge('tunnelStateBadge', stateKind, daemon.state || 'stopped');

      const ownership = daemon.ownership || 'none';
      const ownershipEl = document.getElementById('tunnelOwnershipBadge');
      if (ownershipEl) {
        if (ownership === 'managed') {
          ownershipEl.textContent = SHELL_MESSAGES.connChatgptManaged;
          ownershipEl.className = 'badge badge-primary';
        } else if (ownership === 'external') {
          ownershipEl.textContent = SHELL_MESSAGES.connChatgptExternal;
          ownershipEl.className = 'badge badge-warning';
        } else {
          ownershipEl.textContent = '—';
          ownershipEl.className = 'badge badge-neutral';
        }
      }

      const detailEl = document.getElementById('tunnelDetail');
      if (detailEl) {
        const parts = [];
        if (dep.state === 'qualified' && dep.version) parts.push('version: ' + dep.version);
        if (dep.state === 'unqualified' && dep.observedVersion) parts.push('observed version: ' + dep.observedVersion);
        if (status.backend && status.backend.reason) parts.push('backend: ' + status.backend.reason);
        if (daemon.pid) parts.push('pid: ' + daemon.pid);
        if (ownership === 'external') parts.push(SHELL_MESSAGES.connChatgptExternalNotice);
        if (ownership === 'none' && status.configPresent !== true) parts.push(SHELL_MESSAGES.connChatgptConfigureHint);
        if (ownership === 'none') parts.push(SHELL_MESSAGES.connChatgptRecoveryHint);
        detailEl.textContent = parts.join(' · ');
      }
    }

    async function fetchTunnelStatus() {
      if (!isAdminUnlocked) return;
      try {
        const body = await apiRequest('/admin/tunnel/status');
        if (body && body.status) {
          lastTunnelStatus = body.status;
          renderTunnelStatus(lastTunnelStatus);
        }
      } catch (e) {
        console.warn('Tunnel status fetch error', e);
      }
    }

    async function tunnelLifecycleAction(endpoint, confirmValue) {
      const resBox = document.getElementById('tunnelActionResult');
      resBox.style.display = 'block';
      resBox.textContent = '…';
      try {
        const body = await apiRequest(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmation: confirmValue })
        });
        if (body && body.status) {
          lastTunnelStatus = body.status;
          renderTunnelStatus(lastTunnelStatus);
        }
        resBox.textContent = 'OK';
        document.getElementById('tunnelConfirmInput').value = '';
      } catch (err) {
        resBox.textContent = err.message || String(err);
      }
      fetchTunnelStatus();
    }

    async function handleTunnelStart() {
      if (!await ensureAdminUnlocked()) return;
      document.getElementById('tunnelConfirmGroup').style.display = 'block';
      await tunnelLifecycleAction('/admin/tunnel/start',
        document.getElementById('tunnelConfirmInput').value.trim());
    }

    async function handleTunnelStop() {
      if (!await ensureAdminUnlocked()) return;
      document.getElementById('tunnelConfirmGroup').style.display = 'block';
      await tunnelLifecycleAction('/admin/tunnel/stop',
        document.getElementById('tunnelConfirmInput').value.trim());
    }

    async function handleTunnelRestart() {
      if (!await ensureAdminUnlocked()) return;
      document.getElementById('tunnelConfirmGroup').style.display = 'block';
      await tunnelLifecycleAction('/admin/tunnel/restart',
        document.getElementById('tunnelConfirmInput').value.trim());
    }

    async function handleTunnelDoctor() {
      if (!await ensureAdminUnlocked()) return;
      const resBox = document.getElementById('tunnelActionResult');
      resBox.style.display = 'block';
      resBox.textContent = '…';
      try {
        const body = await apiRequest('/admin/tunnel/doctor');
        const checks = (body && body.checks) || [];
        resBox.textContent = checks.map(c => (c.ok ? 'OK' : 'FAIL') + ' ' + c.name + (c.code ? ' [' + c.code + ']' : '') + ' — ' + c.detail).join('\\n');
      } catch (err) {
        resBox.textContent = err.message || String(err);
      }
    }

    async function exchangeTokenIfNeeded() {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token') || params.get('auth');
      if (token) {
        try {
          await fetch('/auth/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token })
          });
          params.delete('token');
          params.delete('auth');
          const cleanQuery = params.toString();
          const cleanUrl = window.location.pathname + (cleanQuery ? ('?' + cleanQuery) : '');
          window.history.replaceState({}, document.title, cleanUrl);
        } catch (e) {
          console.warn('Token exchange failed', e);
        }
      }
    }

    async function checkExistingAdminSession() {
      try {
        const st = await apiRequest('/admin/status');
        if (st && st.authenticated) {
          isAdminUnlocked = true;
          updateAdminUI();
        }
      } catch (e) {
        isAdminUnlocked = false;
        updateAdminUI();
      }
    }

    function refreshAllData() {
      fetchStatsAndLogs();
      if (isAdminUnlocked) {
        fetchAdminData();
      }
    }

    document.addEventListener('keydown', event => {
      const active = document.activeElement;
      const tag = active && active.tagName ? active.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (active && active.isContentEditable)) {
        return;
      }
      if (pendingApprovalShortcuts.length !== 1) return;

      const jobId = pendingApprovalShortcuts[0];
      if (event.key === 'Enter') {
        event.preventDefault();
        executeApproval(jobId, 'approve');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        executeApproval(jobId, 'deny');
      }
    });

    if (INITIAL_FOCUS_JOB_ID) {
      showTab('approvals');
    }

    exchangeTokenIfNeeded().then(async () => {
      await checkExistingAdminSession();
      refreshAllData();
      setInterval(refreshAllData, 3000);
    });
  </script>
</body>
</html>`;
}
