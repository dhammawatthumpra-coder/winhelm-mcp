import { PROFILES, type ToolProfile } from "../config/profiles.js";
import { getRuntimeLocale, translate as t } from "../i18n/messages.js";
import {
  ALL_TOOL_NAMES,
  ALL_V13_TOOL_NAMES,
  RECOVERY_TOOL_NAMES,
  SCHEMA_V2_TOOL_NAMES,
} from "../tools/registry.js";

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

export interface DashboardPermissionSummary {
  schemaMode: "legacy" | "v2" | "invalid";
  preset?: string | null;
  modified?: boolean | null;
  terminalMode?: string | null;
}

/**
 * Lightweight, zero-dependency, self-contained Web Monitor Dashboard for WinHelm.
 * Served directly by Express without external CDN dependencies.
 */
export function getDashboardHtml(
  activeProfile: ToolProfile = "full",
  permissionSummary?: DashboardPermissionSummary
): string {
  const profileDef = PROFILES[activeProfile] || PROFILES.full;
  const schemaMode = permissionSummary?.schemaMode ?? "legacy";
  // Baseline 7.6 messages that the Dashboard must show, in the configured
  // locale. Only these keys are normative, so untranslated UI stays English.
  const uiMessages = {
    fullWarn: t("mode.full.warn"),
    expiry: t("approve.expiry"),
    confirmType: t("confirm.type"),
    adminLocked: t("dashboard.admin.locked"),
    adminUnlocked: t("dashboard.admin.unlocked"),
    adminInstructions: t("dashboard.admin.instructions"),
    adminPlaceholder: t("dashboard.admin.placeholder"),
    adminUnlock: t("dashboard.admin.unlock"),
    adminCodeHint: t("dashboard.admin.code_hint"),
    adminLoading: t("dashboard.admin.loading"),
    approvalsTitle: t("dashboard.approvals.title"),
    approvalsNote: t("dashboard.approvals.note"),
    approvalsEmpty: t("dashboard.approvals.empty"),
    approvalsApprove: t("dashboard.approvals.approve"),
    approvalsDeny: t("dashboard.approvals.deny"),
    clientsTitle: t("dashboard.clients.title"),
    clientsNote: t("dashboard.clients.note"),
    clientsEmpty: t("dashboard.clients.empty"),
    clientsLoading: t("dashboard.clients.loading"),
  };
  const dashboardMessagesScript = `const DASHBOARD_MESSAGES = ${JSON.stringify({
    fullWarn: uiMessages.fullWarn,
    expiry: uiMessages.expiry,
    adminLocked: uiMessages.adminLocked,
    adminUnlocked: uiMessages.adminUnlocked,
    adminCodeHint: uiMessages.adminCodeHint,
    approvalsEmpty: uiMessages.approvalsEmpty,
    approvalsApprove: uiMessages.approvalsApprove,
    approvalsDeny: uiMessages.approvalsDeny,
    clientsEmpty: uiMessages.clientsEmpty,
    clientsLoading: uiMessages.clientsLoading,
  }).replace(/</g, "\\u003c")};`;
  const schemaV2Surface = schemaMode !== "legacy";
  const legacyActiveTools = new Set<string>([
    ...profileDef.tools,
    ...RECOVERY_TOOL_NAMES,
  ]);
  const displayedToolNames = schemaV2Surface
    ? [...ALL_V13_TOOL_NAMES]
    : [...ALL_TOOL_NAMES, ...RECOVERY_TOOL_NAMES];
  const exposedToolCount = schemaV2Surface
    ? displayedToolNames.length
    : displayedToolNames.filter((name) => legacyActiveTools.has(name)).length;
  const displayProfile =
    schemaMode === "v2"
      ? String(permissionSummary?.preset ?? "modified")
      : profileDef.name;
  const modifiedText =
    schemaMode === "v2" && permissionSummary?.modified === true
      ? " · MODIFIED"
      : "";
  const headerProfileText =
    schemaMode === "v2"
      ? `PROFILE: ${displayProfile.toUpperCase()}${modifiedText} · ${ALL_V13_TOOL_NAMES.length} SCHEMAS`
      : schemaMode === "invalid"
        ? `SCHEMA-V2 INVALID · ${ALL_V13_TOOL_NAMES.length} SCHEMAS`
        : `PROFILE: ${profileDef.name.toUpperCase()} · ${profileDef.tools.length} LEGACY + ${RECOVERY_TOOL_NAMES.length} RECOVERY`;
  const terminalMode = permissionSummary?.terminalMode ?? null;
  const riskBannerHtml =
    schemaMode === "invalid"
      ? `<div id="runtimeRiskBanner" class="risk-banner danger"><strong>Configuration unavailable.</strong> Schema-v2 validation failed; ordinary tool execution is fail-closed. Open Permissions with a local admin code to repair it.</div>`
      : terminalMode === "dangerous"
        ? `<div id="runtimeRiskBanner" class="risk-banner danger"><strong>DANGEROUS terminal mode is active.</strong> Command blocklists may be bypassed for the current configured window.</div>`
        : terminalMode === "full"
          ? `<div id="runtimeRiskBanner" class="risk-banner danger"><strong>${escapeHtml(uiMessages.fullWarn)}</strong></div>`
          : `<div id="runtimeRiskBanner" class="risk-banner" style="display:none;"></div>`;
  // The baseline requires an explicit legacy-configuration disclosure so a
  // pre-schema-v2 file is never mistaken for a v2 permission state.
  const legacyBannerHtml = `<div id="legacyConfigBanner" class="risk-banner warning" style="display:${
    schemaMode === "legacy" ? "block" : "none"
  };"><strong>Legacy configuration — upgrade available.</strong> This config has no <code>schemaVersion</code>, so v1.2.1 permissions, profile filtering and allowed directories stay in effect. Review the schema-v2 upgrade in Permissions with a local admin code.</div>`;

  const toolColor = (name: string): string => {
    if (RECOVERY_TOOL_NAMES.includes(name as any)) return "#a78bfa";
    if (
      name === SCHEMA_V2_TOOL_NAMES.COMMAND_RUN ||
      name.startsWith("terminal_")
    ) {
      return "#10b981";
    }
    if (
      name === "file_search_ripgrep" ||
      name === "pdf_generate" ||
      name === "file_preview"
    ) {
      return "#f59e0b";
    }
    if (name.startsWith("file_") || name.startsWith("archive_")) {
      return "#3b82f6";
    }
    if (
      name.startsWith("clipboard_") ||
      name === "screen_capture" ||
      name === "system_open" ||
      name === "notification_send"
    ) {
      return "#ec4899";
    }
    if (name.startsWith("http_") || name === "network_info") {
      return "#14b8a6";
    }
    return "#06b6d4";
  };

  const renderTool = (name: string) => {
    const isExposed = schemaV2Surface || legacyActiveTools.has(name);
    const label =
      name === SCHEMA_V2_TOOL_NAMES.COMMAND_RUN
        ? `${name} · terminal=${terminalMode ?? "n/a"}`
        : name;
    const safeLabel = escapeHtml(label);

    if (isExposed) {
      return `<div class="tool-item" data-tool-name="${escapeHtml(name)}"><span class="tool-dot" style="background: ${toolColor(name)};"></span> ${safeLabel}</div>`;
    }
    return `<div class="tool-item inactive" data-tool-name="${escapeHtml(name)}" title="Not loaded in ${escapeHtml(profileDef.name)} profile"><span class="tool-dot" style="background: #4b5563;"></span> <span style="text-decoration: line-through; opacity: 0.6;">${safeLabel}</span></div>`;
  };

  const primaryToolHtml = displayedToolNames
    .filter(
      (name) =>
        !RECOVERY_TOOL_NAMES.includes(name as any) &&
        name !== SCHEMA_V2_TOOL_NAMES.COMMAND_RUN
    )
    .map(renderTool)
    .join("");
  const commandRunHtml = displayedToolNames.includes(
    SCHEMA_V2_TOOL_NAMES.COMMAND_RUN
  )
    ? renderTool(SCHEMA_V2_TOOL_NAMES.COMMAND_RUN)
    : "";
  const recoveryToolHtml = RECOVERY_TOOL_NAMES
    .filter((name) => displayedToolNames.includes(name))
    .map(renderTool)
    .join("");

  const renderResource = () => {
    if (profileDef.includesResource) {
      return `<div class="tool-item"><span class="tool-dot" style="background: #eab308;"></span> preview://file</div>`;
    }
    return `<div class="tool-item inactive" title="Not loaded in ${profileDef.name} profile"><span class="tool-dot" style="background: #4b5563;"></span> <span style="text-decoration: line-through; opacity: 0.6;">preview://file</span></div>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WinHelm | Monitor Dashboard</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f2937;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --purple: #8b5cf6;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 24px;
      min-height: 100vh;
    }
    .container { max-width: 1300px; margin: 0 auto; }
    
    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .logo-area { display: flex; align-items: center; gap: 12px; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); opacity: 0.8; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.8; }
    }
    .header-controls { display: flex; align-items: center; gap: 12px; }
    button {
      background: var(--card-bg);
      color: var(--text-main);
      border: 1px solid var(--card-border);
      padding: 8px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    button:hover { background: #1f2937; border-color: #374151; }
    button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
    button.primary:hover { background: var(--primary-hover); }
    .toggle-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--text-muted);
      cursor: pointer;
    }

    .risk-banner {
      margin: 0 0 18px;
      padding: 12px 14px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
      border: 1px solid transparent;
    }
    .risk-banner.warning {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.45);
      color: #fcd34d;
    }
    .risk-banner.danger {
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(239, 68, 68, 0.45);
      color: #fca5a5;
    }
    .permissions-shell { margin-bottom: 24px; }
    .permissions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-top: 14px;
    }
    .field-label {
      display: block;
      font-size: 12px;
      color: var(--text-muted);
      margin: 10px 0 6px;
    }
    input[type="text"], input[type="password"], select, textarea {
      width: 100%;
      box-sizing: border-box;
      background: #0b1220;
      color: var(--text-main);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 9px 10px;
      font: inherit;
    }
    textarea { min-height: 92px; resize: vertical; }
    .permissions-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .permission-summary {
      white-space: pre-wrap;
      background: #0b1220;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px;
      min-height: 88px;
      font-size: 12px;
      line-height: 1.55;
      color: #cbd5e1;
      overflow-wrap: anywhere;
    }
    .admin-locked { color: var(--text-muted); font-size: 13px; }
    .admin-ok { color: var(--success); font-size: 13px; }
    .admin-error { color: #fca5a5; font-size: 13px; }
    .approval-row {
      border: 1px solid var(--card-border);
      background: #0b1220;
      border-radius: 7px;
      padding: 10px;
      margin-bottom: 8px;
    }
    .approval-meta {
      color: var(--text-muted);
      font-size: 11px;
      margin-top: 4px;
    }
    .risk-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 3px 8px;
      margin-top: 7px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid var(--card-border);
    }
    .risk-low { color: #86efac; border-color: rgba(34,197,94,.4); background: rgba(34,197,94,.1); }
    .risk-medium { color: #fde68a; border-color: rgba(245,158,11,.4); background: rgba(245,158,11,.1); }
    .risk-elevated { color: #fdba74; border-color: rgba(249,115,22,.45); background: rgba(249,115,22,.1); }
    .risk-high { color: #fca5a5; border-color: rgba(239,68,68,.5); background: rgba(239,68,68,.12); }
    .approval-countdown { font-variant-numeric: tabular-nums; }
    .approval-args {
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      color: #cbd5e1;
      margin-top: 8px;
      max-height: 160px;
      overflow: auto;
    }

    /* Grid Layout */
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 24px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 20px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    .card-title {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .metric-value { font-size: 28px; font-weight: 700; color: #fff; }
    .metric-sub { font-size: 13px; color: var(--text-muted); margin-top: 4px; }

    /* Progress bars */
    .progress-bar-bg {
      background: #1f2937;
      height: 8px;
      border-radius: 4px;
      overflow: hidden;
      margin-top: 10px;
    }
    .progress-bar-fill {
      height: 100%;
      background: var(--primary);
      border-radius: 4px;
      transition: width 0.4s ease;
    }
    .fill-green { background: var(--success); }
    .fill-yellow { background: var(--warning); }
    .fill-red { background: var(--danger); }

    /* Drives list */
    .drive-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      margin-top: 8px;
    }

    /* Live Feed / Table */
    .feed-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .filter-group { display: flex; gap: 8px; flex-wrap: wrap; }
    .filter-chip {
      background: #1f2937;
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
    }
    .filter-chip.active { background: var(--primary); color: #fff; border-color: var(--primary); }
    
    .table-container {
      overflow-x: auto;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th {
      background: #161f30;
      color: var(--text-muted);
      font-weight: 600;
      padding: 12px 16px;
      border-bottom: 1px solid var(--card-border);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
    }
    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--card-border);
      color: #e5e7eb;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    
    /* Badges */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-tool { background: rgba(139, 92, 246, 0.2); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.4); }
    .badge-req { background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); }
    .badge-sec { background: rgba(245, 158, 11, 0.2); color: #fde68a; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-err { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); }
    
    .status-tag {
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-success { color: var(--success); }
    .status-running { color: var(--warning); }
    .status-fail { color: var(--danger); }
    
    .tools-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .tool-item {
      background: #161f30;
      border: 1px solid var(--card-border);
      padding: 8px 12px;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: #93c5fd;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tool-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
    .tool-item.inactive {
      opacity: 0.35;
      background: #0d131f;
      border: 1px dashed #374151;
      color: #6b7280;
    }
    .tool-group-label {
      grid-column: 1 / -1;
      margin-top: 8px;
      padding-top: 10px;
      border-top: 1px solid var(--card-border);
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-area">
        <h2>⚡ WinHelm</h2>
        <span class="status-badge"><span class="pulse-dot"></span> LIVE MONITOR</span>
        <span class="status-badge" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.4); text-transform: uppercase;">${escapeHtml(headerProfileText)}</span>
      </div>
      <div class="header-controls">
        <label class="toggle-label">
          <input type="checkbox" id="autoRefresh" checked> Auto-refresh (2.5s)
        </label>
        <button id="btnRefresh" onclick="fetchData()">🔄 Refresh</button>
        <button onclick="document.getElementById('permissionsPanel').scrollIntoView({behavior:'smooth'})">🔐 Permissions</button>
        <button onclick="window.open('/api/monitor/export?format=json')">📥 Export JSON</button>
        <button onclick="window.open('/api/monitor/export?format=csv')">📥 Export CSV</button>
        <button id="btnClear" onclick="clearLogs()">🗑️ Clear</button>
      </div>
    </header>

    ${riskBannerHtml}
    ${legacyBannerHtml}

    <div class="card permissions-shell" id="permissionsPanel">
      <div class="card-title">
        <span>Permissions & Setup</span>
        <span id="adminState" class="admin-locked">${escapeHtml(uiMessages.adminLocked)}</span>
      </div>

      <div id="adminUnlock">
        <div style="font-size:13px;color:var(--text-muted);line-height:1.55;">
          ${escapeHtml(uiMessages.adminInstructions)}
        </div>
        <div style="display:flex;gap:8px;max-width:520px;margin-top:10px;">
          <input id="adminCodeInput" type="password" autocomplete="one-time-code" placeholder="${escapeHtml(uiMessages.adminPlaceholder)}">
          <button class="primary" onclick="unlockAdmin()">${escapeHtml(uiMessages.adminUnlock)}</button>
        </div>
        <div id="adminUnlockError" class="admin-error" style="margin-top:8px;"></div>
      </div>

      <div id="permissionsUnlocked" style="display:none;">
        <div class="permissions-grid">
          <div>
            <div style="font-weight:600;">Profile Wizard</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
              Profile is a preset only. The permission state shown below is authoritative.
            </div>

            <label class="field-label" for="profilePresetSelect">Preset</label>
            <select id="profilePresetSelect">
              <option value="safe">Safe</option>
              <option value="balanced">Balanced</option>
              <option value="power">Power</option>
              <option value="minimal">Legacy minimal</option>
              <option value="core">Legacy core</option>
              <option value="dev">Legacy dev</option>
              <option value="sysadmin">Legacy sysadmin</option>
              <option value="full">Legacy full</option>
            </select>

            <label class="field-label" for="profileFoldersInput">Folders · one per line, optional <code>path::alias</code></label>
            <textarea id="profileFoldersInput" spellcheck="false" placeholder="D:\\Workspace::workspace"></textarea>

            <label class="field-label" for="profileConfirmInput">Typed confirmation · Power/full only</label>
            <input id="profileConfirmInput" type="text" autocomplete="off" placeholder="${escapeHtml(uiMessages.confirmType)}">

            <div class="permissions-actions">
              <button onclick="previewProfile()">Preview</button>
              <button class="primary" onclick="applyProfile()">Apply</button>
              <button onclick="loadAdminProfile()">Refresh</button>
            </div>

            <div id="profilePreview" class="permission-summary" style="margin-top:12px;">${escapeHtml(uiMessages.adminLoading)}</div>

            <div style="margin-top:16px;border-top:1px solid var(--card-border);padding-top:12px;">
              <div style="font-weight:600;">MCP Client Connection</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
                Writes only <code>mcpServers.winhelm</code> in the local client config. Unrelated settings are preserved, an existing file is backed up first, and no auth or admin secret is embedded.
              </div>
              <div class="permissions-actions">
                <button onclick="previewMcpClient('claude')">Preview Claude Desktop</button>
                <button class="primary" onclick="connectMcpClient('claude')">Connect Claude Desktop</button>
              </div>
              <div class="permissions-actions" style="margin-top:8px;">
                <button onclick="previewMcpClient('cursor')">Preview Cursor</button>
                <button class="primary" onclick="connectMcpClient('cursor')">Connect Cursor</button>
              </div>
              <div id="clientConnectionPreview" class="permission-summary" style="margin-top:12px;">No client preview yet.</div>
            </div>
          </div>

          <div>
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
              <div style="font-weight:600;">${escapeHtml(uiMessages.approvalsTitle)}</div>
              <button onclick="loadApprovals()">Refresh</button>
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin:4px 0 10px;">
              ${escapeHtml(uiMessages.approvalsNote)}
            </div>
            <div id="approvalJobs">
              <div class="admin-locked">No admin data loaded yet.</div>
            </div>

            <div style="margin-top:16px;border-top:1px solid var(--card-border);padding-top:12px;">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                <div style="font-weight:600;">${escapeHtml(uiMessages.clientsTitle)}</div>
                <button onclick="loadSessions()">Refresh</button>
              </div>
              <div style="font-size:12px;color:var(--text-muted);margin:4px 0 8px;">
                ${escapeHtml(uiMessages.clientsNote)}
              </div>
              <div id="sessionClients" class="permission-summary">${escapeHtml(uiMessages.clientsEmpty)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Top Metrics -->
    <div class="grid">
      <!-- Card 1: Server Status -->
      <div class="card">
        <div class="card-title">Server Runtime</div>
        <div class="metric-value" id="uptimeText">--</div>
        <div class="metric-sub" id="serverInfoText">WinHelm v1.0.0</div>
      </div>

      <!-- Card 2: Active MCP Sessions -->
      <div class="card">
        <div class="card-title">Connected Sessions</div>
        <div class="metric-value" id="activeSessionsText">0</div>
        <div class="metric-sub" id="sessionBreakdown">Streamable: 0 | SSE: 0 | Tasks: 0</div>
      </div>

      <!-- Card 3: CPU Usage -->
      <div class="card">
        <div class="card-title">CPU Load</div>
        <div class="metric-value" id="cpuLoadText">-- %</div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="cpuBar" style="width: 0%"></div>
        </div>
      </div>

      <!-- Card 4: RAM Usage -->
      <div class="card">
        <div class="card-title">Memory (RAM)</div>
        <div class="metric-value" id="ramText">-- / -- GB</div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill fill-green" id="ramBar" style="width: 0%"></div>
        </div>
      </div>
    </div>

    <!-- Hardware: Drives & GPU -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px;">
      <!-- Drives Info -->
      <div class="card">
        <div class="card-title">Storage Drives</div>
        <div id="drivesContainer" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 8px;">
          <div style="color: var(--text-muted); font-size: 13px;">Reading drive metrics...</div>
        </div>
      </div>

      <!-- GPU Telemetry Card -->
      <div class="card" id="gpuCard">
        <div class="card-title">GPU Telemetry</div>
        <div id="gpuContainer" style="margin-top: 8px; font-size: 13px; color: var(--text-muted);">
          Detecting GPU...
        </div>
      </div>
    </div>

    <!-- Live Activity Table -->
    <div class="feed-header">
      <h3 style="font-size: 16px; font-weight: 600;">Activity & Execution Stream</h3>
      <div class="filter-group">
        <span class="filter-chip active" onclick="setFilter('all', this)">All</span>
        <span class="filter-chip" onclick="setFilter('tool', this)">Tools</span>
        <span class="filter-chip" onclick="setFilter('req', this)">HTTP Requests</span>
        <span class="filter-chip" onclick="setFilter('security', this)">Security</span>
        <span class="filter-chip" onclick="setFilter('error', this)">Errors</span>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th style="width: 100px;">Time</th>
            <th style="width: 110px;">Type</th>
            <th style="width: 200px;">Event</th>
            <th>Details</th>
            <th style="width: 90px;">Latency</th>
            <th style="width: 100px;">Status</th>
          </tr>
        </thead>
        <tbody id="logsTableBody">
          <tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">No logs recorded yet</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Registered Tools Reference -->
    <div class="card" style="margin-top: 24px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div class="card-title" style="margin-bottom: 0;">${schemaV2Surface ? "Exposed Tool Schemas" : "Registered Tools"} (${exposedToolCount} Exposed / ${displayedToolNames.length} Available)</div>
        <div style="font-size: 12px; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap;">
          <span><span class="tool-dot" style="background: #10b981;"></span> Terminal</span>
          <span><span class="tool-dot" style="background: #8b5cf6;"></span> Background Tasks</span>
          <span><span class="tool-dot" style="background: #3b82f6;"></span> Filesystem</span>
          <span><span class="tool-dot" style="background: #f59e0b;"></span> Search & PDF</span>
          <span><span class="tool-dot" style="background: #ec4899;"></span> Desktop</span>
          <span><span class="tool-dot" style="background: #06b6d4;"></span> System & Services</span>
          <span><span class="tool-dot" style="background: #14b8a6;"></span> Network</span>
        </div>
      </div>
      <div class="tools-grid" data-tool-surface="${schemaMode}">
        ${primaryToolHtml}
        ${commandRunHtml ? '<div class="tool-group-label">Terminal adapter</div>' + commandRunHtml : ''}
        <div class="tool-group-label">Recovery tools</div>
        ${recoveryToolHtml}
        <div class="tool-group-label">MCP resource</div>
        ${renderResource()}
      </div>
    </div>
  </div>

  <script>
    ${dashboardMessagesScript}
    let currentFilter = 'all';
    let logsCache = [];
    let adminCsrfToken = null;
    let pendingApprovalShortcuts = [];

    function setAdminState(text, className) {
      const el = document.getElementById('adminState');
      el.textContent = text;
      el.className = className || 'admin-locked';
    }

    function setUnlockError(text) {
      document.getElementById('adminUnlockError').textContent = text || '';
    }

    async function readJsonResponse(response) {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = new Error(
          body && body.error && body.error.message
            ? body.error.message
            : 'WinHelm admin request failed (' + response.status + ')'
        );
        err.code =
          body && body.error && body.error.code
            ? body.error.code
            : 'ADMIN_REQUEST_FAILED';
        throw err;
      }
      return body;
    }

    async function adminRequest(url, options) {
      const init = Object.assign({}, options || {});
      init.headers = Object.assign({}, init.headers || {});
      const method = String(init.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        if (!adminCsrfToken) {
          throw new Error('Admin session is not unlocked.');
        }
        init.headers['x-winhelm-csrf'] = adminCsrfToken;
      }
      return readJsonResponse(await fetch(url, init));
    }

    async function unlockAdmin() {
      const input = document.getElementById('adminCodeInput');
      const code = input.value.trim();
      setUnlockError('');
      if (!code) {
        setUnlockError(DASHBOARD_MESSAGES.adminCodeHint);
        return;
      }

      try {
        const response = await fetch('/admin/auth/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code })
        });
        const body = await readJsonResponse(response);
        adminCsrfToken = body.csrfToken;
        input.value = '';
        document.getElementById('adminUnlock').style.display = 'none';
        document.getElementById('permissionsUnlocked').style.display = 'block';
        setAdminState(DASHBOARD_MESSAGES.adminUnlocked, 'admin-ok');
        await Promise.all([loadAdminProfile(), loadApprovals(), loadSessions()]);
      } catch (err) {
        setAdminState(DASHBOARD_MESSAGES.adminLocked, 'admin-locked');
        setUnlockError(err.message || String(err));
      }
    }

    function parseFolderEditor() {
      const raw = document.getElementById('profileFoldersInput').value;
      return raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const marker = line.lastIndexOf('::');
          if (marker > 1) {
            const p = line.slice(0, marker).trim();
            const alias = line.slice(marker + 2).trim();
            if (p && alias) return { path: p, alias: alias };
          }
          return { path: line };
        });
    }

    function profilePayload() {
      const preset = document.getElementById('profilePresetSelect').value;
      const confirmation = document.getElementById('profileConfirmInput').value;
      const payload = {
        preset: preset,
        folders: parseFolderEditor()
      };
      if (confirmation.trim()) payload.confirmation = confirmation.trim();
      return payload;
    }

    function policyCounts(policy) {
      const counts = { auto: 0, ask: 0, off: 0 };
      Object.values(policy || {}).forEach(value => {
        if (value === 'auto') counts.auto += 1;
        else if (value === 'ask') counts.ask += 1;
        else if (value === 'off') counts.off += 1;
      });
      return counts;
    }

    function updateRuntimeRisk(profile) {
      const banner = document.getElementById('runtimeRiskBanner');
      const legacyBanner = document.getElementById('legacyConfigBanner');
      if (legacyBanner) {
        legacyBanner.style.display =
          profile.schemaMode === 'legacy' ? 'block' : 'none';
      }
      if (!banner) return;
      banner.textContent = '';
      banner.className = 'risk-banner';

      if (profile.schemaMode === 'invalid') {
        banner.style.display = 'block';
        banner.classList.add('danger');
        banner.textContent =
          'Configuration unavailable. Schema-v2 validation failed; ordinary tool execution is fail-closed.';
        return;
      }

      if (profile.terminalMode === 'dangerous') {
        banner.style.display = 'block';
        banner.classList.add('danger');
        banner.textContent =
          'DANGEROUS terminal mode is active. Command blocklists may be bypassed for the configured window.';
        return;
      }

      if (profile.terminalMode === 'full') {
        banner.style.display = 'block';
        banner.classList.add('danger');
        banner.textContent = DASHBOARD_MESSAGES.fullWarn;
        return;
      }

      banner.style.display = 'none';
    }

    function renderProfileState(profile, legacy) {
      const presetSelect = document.getElementById('profilePresetSelect');
      if (profile.preset && presetSelect.querySelector('option[value="' + profile.preset + '"]')) {
        presetSelect.value = profile.preset;
      } else if (legacy && legacy.profile && presetSelect.querySelector('option[value="' + legacy.profile + '"]')) {
        presetSelect.value = legacy.profile;
      } else {
        presetSelect.value = 'balanced';
      }

      const folders = Array.isArray(profile.folders) && profile.folders.length
        ? profile.folders
        : legacy && Array.isArray(legacy.allowedDirectories)
          ? legacy.allowedDirectories
              .filter(value => value !== '*' && String(value).toLowerCase() !== 'all')
              .map(value => ({ path: value }))
          : [];

      document.getElementById('profileFoldersInput').value = folders
        .map(folder =>
          folder.alias
            ? String(folder.path) + '::' + String(folder.alias)
            : String(folder.path)
        )
        .join('\n');

      const counts = policyCounts(profile.toolPolicy);
      const modified =
        profile.modified === true
          ? 'yes · ' + (profile.modifiedFields || []).join(', ')
          : profile.modified === false
            ? 'no'
            : 'n/a';

      const lines = [
        'Schema: ' + profile.schemaMode,
        'Preset: ' + (profile.preset || (legacy ? legacy.profile : 'none')),
        'Modified: ' + modified,
        'Terminal: ' + (profile.terminalMode || (legacy ? 'legacy' : 'off')),
        'Folders: ' + folders.length,
        'Tool policy: auto=' + counts.auto + ', ask=' + counts.ask + ', off=' + counts.off
      ];

      if (profile.validationErrors && profile.validationErrors.length) {
        lines.push('Validation: ' + profile.validationErrors.join(' | '));
      }

      document.getElementById('profilePreview').textContent = lines.join('\n');
      updateRuntimeRisk(profile);
    }

    async function loadAdminProfile() {
      try {
        const body = await adminRequest('/admin/profile');
        renderProfileState(body.profile, body.legacy);
      } catch (err) {
        document.getElementById('profilePreview').textContent =
          'Profile load failed: ' + (err.message || String(err));
      }
    }

    function renderProfilePreview(preview) {
      const counts = policyCounts(preview.toolPolicy);
      const lines = [
        'Preview preset: ' + preview.preset,
        'Terminal: ' + preview.terminalMode,
        'Changed: ' + (preview.changedFields.length ? preview.changedFields.join(', ') : 'none'),
        'Folders: ' + preview.folders.length,
        'Tool policy: auto=' + counts.auto + ', ask=' + counts.ask + ', off=' + counts.off
      ];

      if (preview.requiresTypedConfirmation) {
        lines.push('Typed confirmation is required before Apply.');
      }
      (preview.warnings || []).forEach(warning => {
        lines.push('WARNING: ' + warning);
      });

      preview.folders.forEach(folder => {
        lines.push(
          '  ' +
            folder.path +
            ' [' +
            folder.permission +
            ']' +
            (folder.alias ? ' @' + folder.alias : '')
        );
      });

      document.getElementById('profilePreview').textContent = lines.join('\n');
    }

    async function previewProfile() {
      try {
        const body = await adminRequest('/admin/profiles/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profilePayload())
        });
        renderProfilePreview(body.preview);
      } catch (err) {
        document.getElementById('profilePreview').textContent =
          (err.code ? err.code + ': ' : '') + (err.message || String(err));
      }
    }

    async function applyProfile() {
      try {
        const body = await adminRequest('/admin/profiles/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profilePayload())
        });
        document.getElementById('profileConfirmInput').value = '';
        renderProfileState(body.profile, null);
        const backupLine = body.backupPath
          ? '\nBackup created: ' + body.backupPath
          : '';
        document.getElementById('profilePreview').textContent +=
          '\nApplied successfully.' +
          backupLine +
          '\nReconnect the MCP client if it cached the previous tool list.';
      } catch (err) {
        document.getElementById('profilePreview').textContent =
          (err.code ? err.code + ': ' : '') + (err.message || String(err));
      }
    }

    function clientPreviewLines(preview, applied) {
      const target = preview.target || {};
      const entry = preview.proposedEntry || {};
      const lines = [
        (applied ? 'Applied: ' : 'Preview: ') + String(target.displayName || ''),
        'Config: ' + String(target.configPath || ''),
        'Config file exists: ' + (target.configFileExists ? 'yes' : 'no'),
        'Changed: ' + (preview.changed ? 'yes' : 'no'),
        'Command: ' + String(entry.command || ''),
        'Replaces: ' +
          (preview.existingEntry
            ? JSON.stringify(preview.existingEntry)
            : 'nothing (new entry)')
      ];

      (entry.args || []).forEach(arg => {
        lines.push('  ' + String(arg));
      });
      (preview.warnings || []).forEach(warning => {
        lines.push('WARNING: ' + String(warning));
      });

      return lines;
    }

    function setClientPreview(text) {
      document.getElementById('clientConnectionPreview').textContent = text;
    }

    async function previewMcpClient(client) {
      setClientPreview('Loading preview…');
      try {
        const body = await adminRequest(
          '/admin/clients/' + client + '/preview',
          { method: 'POST' }
        );
        setClientPreview(clientPreviewLines(body.preview, false).join('\n'));
      } catch (err) {
        setClientPreview(
          (err.code ? err.code + ': ' : '') + (err.message || String(err))
        );
      }
    }

    async function connectMcpClient(client) {
      setClientPreview('Writing client config…');
      try {
        const body = await adminRequest(
          '/admin/clients/' + client + '/apply',
          { method: 'POST' }
        );
        const lines = clientPreviewLines(body.preview, true);
        lines.push(
          body.backupPath
            ? 'Backup: ' + String(body.backupPath)
            : 'No previous client config to back up.'
        );
        setClientPreview(lines.join('\n'));
      } catch (err) {
        setClientPreview(
          (err.code ? err.code + ': ' : '') + (err.message || String(err))
        );
      }
    }

    function renderSessionClients(sessions) {
      const target = document.getElementById('sessionClients');
      target.className = 'permission-summary';
      target.textContent = '';

      if (!Array.isArray(sessions) || sessions.length === 0) {
        target.textContent = DASHBOARD_MESSAGES.clientsEmpty;
        return;
      }

      sessions.forEach(session => {
        const client = session.clientInfo || {};
        const label =
          String(client.name || 'unknown client') +
          (client.version ? ' ' + String(client.version) : '');
        addTextElement(
          target,
          'div',
          label +
            ' · session ' +
            String(session.sessionId || 'n/a') +
            ' · pending ' +
            String(session.pendingApprovals || 0)
        );
      });
    }

    async function loadSessions() {
      const target = document.getElementById('sessionClients');
      target.className = 'permission-summary';
      target.textContent = DASHBOARD_MESSAGES.clientsLoading;
      try {
        const body = await adminRequest('/admin/sessions');
        renderSessionClients(body.sessions);
      } catch (err) {
        target.className = 'admin-error';
        target.textContent =
          (err.code ? err.code + ': ' : '') + (err.message || String(err));
      }
    }

    function addTextElement(parent, tagName, text, className) {
      const el = document.createElement(tagName);
      if (className) el.className = className;
      el.textContent = text;
      parent.appendChild(el);
      return el;
    }

    async function approvalAction(jobId, action) {
      try {
        await adminRequest(
          '/admin/approvals/' + encodeURIComponent(jobId) + '/' + action,
          { method: 'POST' }
        );
        await loadApprovals();
      } catch (err) {
        const target = document.getElementById('approvalJobs');
        target.textContent =
          (err.code ? err.code + ': ' : '') + (err.message || String(err));
        target.className = 'admin-error';
      }
    }

    function formatCountdown(expiresAt) {
      const remaining = Math.max(0, Number(expiresAt || 0) - Date.now());
      const totalSeconds = Math.ceil(remaining / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return (
        String(minutes).padStart(2, '0') +
        ':' +
        String(seconds).padStart(2, '0')
      );
    }

    function refreshApprovalCountdowns() {
      document.querySelectorAll('[data-approval-expires]').forEach(el => {
        const expiresAt = Number(el.getAttribute('data-approval-expires'));
        el.textContent = 'expires in ' + formatCountdown(expiresAt);
      });
    }

    async function loadApprovals() {
      const target = document.getElementById('approvalJobs');
      try {
        const body = await adminRequest('/admin/approvals');
        const jobs = Array.isArray(body.jobs) ? body.jobs : [];
        pendingApprovalShortcuts = jobs
          .filter(job => job.state === 'awaiting_approval')
          .map(job => String(job.id || ''))
          .filter(Boolean);
        target.className = '';
        target.replaceChildren();

        if (!jobs.length) {
          addTextElement(
          target,
          'div',
          DASHBOARD_MESSAGES.approvalsEmpty,
          'admin-locked'
        );
          return;
        }

        jobs.forEach(job => {
          const row = document.createElement('div');
          row.className = 'approval-row';

          addTextElement(
            row,
            'div',
            String(job.tool || 'unknown') + ' · ' + String(job.state || 'unknown')
          );

          const risk = job.risk || {};
          const riskTag = addTextElement(
            row,
            'div',
            String(risk.class || 'R?') +
              ' · ' +
              String(risk.label || 'Risk not classified') +
              ' — ' +
              String(risk.description || ''),
            'risk-tag risk-' + String(risk.level || 'high')
          );
          riskTag.setAttribute('aria-label', 'Approval risk');

          const meta = document.createElement('div');
          meta.className = 'approval-meta';
          const client = job.clientInfo || null;
          const clientText = client && client.name
            ? String(client.name) +
              (client.version ? ' ' + String(client.version) : '')
            : 'unknown client';
          addTextElement(
            meta,
            'span',
            'From ' +
              clientText +
              ' · session ' +
              String(job.sessionId || 'n/a') +
              ' · job ' +
              String(job.id || '') +
              ' · '
          );
          const countdown = addTextElement(
            meta,
            'span',
            'expires in ' + formatCountdown(job.expiresAt),
            'approval-countdown'
          );
          countdown.setAttribute(
            'data-approval-expires',
            String(job.expiresAt || 0)
          );
          addTextElement(meta, 'span', ' · ' + DASHBOARD_MESSAGES.expiry);
          row.appendChild(meta);

          if (typeof job.dataDisclosure === 'string' && job.dataDisclosure) {
            addTextElement(
              row,
              'div',
              'Data disclosure: ' + job.dataDisclosure,
              'approval-meta'
            );
          }

          const args = addTextElement(
            row,
            'div',
            JSON.stringify(job.args || {}, null, 2),
            'approval-args'
          );
          args.setAttribute('aria-label', 'Approval arguments');

          const provenance = Array.isArray(job.provenance)
            ? job.provenance
            : [];
          if (provenance.length > 0) {
            addTextElement(
              row,
              'div',
              'Recent session activity',
              'approval-meta'
            );

            provenance.forEach(entry => {
              const item = document.createElement('div');
              item.className = 'approval-row';
              item.style.marginTop = '6px';
              item.style.padding = '8px';

              const bytes =
                entry.metadata &&
                typeof entry.metadata.bytes === 'number'
                  ? ' · ' + entry.metadata.bytes + ' bytes'
                  : '';
              addTextElement(
                item,
                'div',
                String(entry.tool || 'unknown') +
                  ' · ' +
                  String(entry.status || 'unknown') +
                  bytes
              );
              addTextElement(
                item,
                'div',
                String(entry.target || ''),
                'approval-meta'
              );

              if (typeof entry.preview === 'string' && entry.preview) {
                const preview = document.createElement('div');
                preview.className = 'approval-args';
                preview.style.display = 'none';
                preview.textContent = entry.preview;

                const toggle = document.createElement('button');
                toggle.textContent = 'Show text preview';
                toggle.addEventListener('click', () => {
                  const opening = preview.style.display === 'none';
                  preview.style.display = opening ? 'block' : 'none';
                  toggle.textContent = opening
                    ? 'Hide text preview'
                    : 'Show text preview';
                });

                item.appendChild(toggle);
                item.appendChild(preview);
              }

              row.appendChild(item);
            });
          }

          if (job.state === 'awaiting_approval') {
            const actions = document.createElement('div');
            actions.className = 'permissions-actions';

            const approve = document.createElement('button');
            approve.className = 'primary';
            approve.textContent = DASHBOARD_MESSAGES.approvalsApprove;
            approve.addEventListener('click', () => approvalAction(job.id, 'approve'));

            const deny = document.createElement('button');
            deny.textContent = DASHBOARD_MESSAGES.approvalsDeny;
            deny.addEventListener('click', () => approvalAction(job.id, 'deny'));

            actions.appendChild(approve);
            actions.appendChild(deny);
            row.appendChild(actions);
          }

          target.appendChild(row);
        });
        refreshApprovalCountdowns();
      } catch (err) {
        target.replaceChildren();
        target.className = 'admin-error';
        target.textContent =
          'Approval load failed: ' + (err.message || String(err));
      }
    }

    function formatUptime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      return \`\${h}h \${m}m \${s}s\`;
    }

    function formatTime(isoStr) {
      if (!isoStr) return '--:--:--';
      const d = new Date(isoStr);
      return d.toLocaleTimeString();
    }

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function setFilter(type, el) {
      currentFilter = type;
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      renderLogs();
    }

    function renderLogs() {
      const tbody = document.getElementById('logsTableBody');
      const filtered = logsCache.filter(item => {
        if (currentFilter === 'all') return true;
        if (currentFilter === 'tool') return item.type === 'tool';
        if (currentFilter === 'req') return item.type === 'req';
        if (currentFilter === 'security') return item.type === 'security';
        if (currentFilter === 'error') return item.type === 'error' || item.level === 'error';
        return true;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">No matching events</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(log => {
        let badgeClass = 'badge-tool';
        let typeLabel = 'TOOL';
        if (log.type === 'req') { badgeClass = 'badge-req'; typeLabel = 'HTTP'; }
        if (log.type === 'security') { badgeClass = 'badge-sec'; typeLabel = 'SECURITY'; }
        if (log.type === 'error' || log.level === 'error') { badgeClass = 'badge-err'; typeLabel = 'ERROR'; }

        let statusClass = 'status-success';
        if (log.status === 'RUNNING') statusClass = 'status-running';
        if (log.status === 'FAILED' || log.status === 'BLOCKED' || (typeof log.status === 'number' && log.status >= 400)) statusClass = 'status-fail';

        const duration = log.durationMs !== undefined ? \`\${log.durationMs}ms\` : '-';
        const detail = log.detail ? escapeHtml(log.detail) : '-';
        const title = escapeHtml(log.title || '');
        const statusText = escapeHtml(log.status !== undefined && log.status !== null ? String(log.status) : 'OK');

        return \`
          <tr>
            <td style="color: var(--text-muted)">\${formatTime(log.timestamp)}</td>
            <td><span class="badge \${badgeClass}">\${typeLabel}</span></td>
            <td style="font-weight: 600; color: #fff;">\${title}</td>
            <td style="color: #cbd5e1; word-break: break-all;">\${detail}</td>
            <td style="color: var(--text-muted)">\${duration}</td>
            <td><span class="status-tag \${statusClass}">\${statusText}</span></td>
          </tr>
        \`;
      }).join('');
    }

    async function exchangeTokenIfNeeded() {
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('token') || urlParams.get('auth');
      if (token) {
        try {
          await fetch('/auth/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          });
          // Clean URL bar to avoid leaking token in history/bookmarks/screenshots
          urlParams.delete('token');
          urlParams.delete('auth');
          const cleanQuery = urlParams.toString();
          const cleanUrl = window.location.pathname + (cleanQuery ? '?' + cleanQuery : '');
          window.history.replaceState({}, document.title, cleanUrl);
        } catch (e) {
          console.warn('Token exchange failed', e);
        }
      }
    }

    async function fetchData() {
      try {
        const [statsRes, logsRes] = await Promise.all([
          fetch('/api/monitor/stats').then(r => r.json()),
          fetch('/api/monitor/logs').then(r => r.json())
        ]);

        // Server & Uptime
        document.getElementById('uptimeText').textContent = formatUptime(statsRes.uptimeSeconds || 0);
        document.getElementById('serverInfoText').textContent = \`Port: \${statsRes.port} | Host: \${statsRes.host}\`;
        
        // Sessions
        const sse = statsRes.activeSessions?.sse || 0;
        const http = statsRes.activeSessions?.streamableHttp || 0;
        document.getElementById('sessionBreakdown').textContent = \`Streamable: \${http} | SSE: \${sse} | Tasks: \${statsRes.backgroundTasks || 0}\`;

        // CPU
        if (statsRes.system?.CpuLoadPercentage !== undefined) {
          const cpu = statsRes.system.CpuLoadPercentage;
          document.getElementById('cpuLoadText').textContent = \`\${cpu}%\`;
          const cpuBar = document.getElementById('cpuBar');
          cpuBar.style.width = \`\${Math.min(100, Math.max(0, cpu))}%\`;
          cpuBar.className = \`progress-bar-fill \${cpu > 80 ? 'fill-red' : cpu > 50 ? 'fill-yellow' : 'fill-green'}\`;
        }

        // RAM
        if (statsRes.system?.TotalRamGB && statsRes.system?.UsedRamGB) {
          const used = statsRes.system.UsedRamGB;
          const total = statsRes.system.TotalRamGB;
          const pct = Math.round((used / total) * 100);
          document.getElementById('ramText').textContent = \`\${used} / \${total} GB (\${pct}%)\`;
          const ramBar = document.getElementById('ramBar');
          ramBar.style.width = \`\${pct}%\`;
          ramBar.className = \`progress-bar-fill \${pct > 85 ? 'fill-red' : pct > 65 ? 'fill-yellow' : 'fill-green'}\`;
        }

        // Drives
        if (statsRes.system?.Drives && Array.isArray(statsRes.system.Drives)) {
          const drivesHtml = statsRes.system.Drives.map(d => {
            const usedPct = Math.round((d.UsedGB / d.TotalGB) * 100) || 0;
            return \`
              <div style="background: #161f30; padding: 12px; border-radius: 6px; border: 1px solid var(--card-border);">
                <div class="drive-row" style="font-weight: 600; color: #fff;">
                  <span>Drive \${escapeHtml(d.Name)}:</span>
                  <span>\${d.FreeGB} GB Free / \${d.TotalGB} GB</span>
                </div>
                <div class="progress-bar-bg" style="margin-top: 6px;">
                  <div class="progress-bar-fill \${usedPct > 90 ? 'fill-red' : 'fill-green'}" style="width: \${usedPct}%"></div>
                </div>
              </div>
            \`;
          }).join('');
          document.getElementById('drivesContainer').innerHTML = drivesHtml;
        }

        // GPU Telemetry
        const gpuContainer = document.getElementById('gpuContainer');
        if (statsRes.gpu && statsRes.gpu.gpus && statsRes.gpu.gpus.length > 0) {
          const gpuHtml = statsRes.gpu.gpus.map(g => {
            const vramPct = g.memoryTotalMB ? Math.round((g.memoryUsedMB / g.memoryTotalMB) * 100) : 0;
            const tempText = g.temperatureC ? g.temperatureC + '°C' : '';
            const tempColor = g.temperatureC > 75 ? 'var(--danger)' : 'var(--success)';
            return \`
              <div style="background: #161f30; padding: 12px; border-radius: 6px; border: 1px solid var(--card-border); margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; font-weight: 600; color: #fff;">
                  <span>\${escapeHtml(g.name)}</span>
                  <span style="color: \${tempColor};">\${escapeHtml(tempText)}</span>
                </div>
                \${g.memoryTotalMB ? \`
                  <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); margin-top: 4px;">
                    <span>VRAM: \${g.memoryUsedMB} MB / \${g.memoryTotalMB} MB</span>
                    <span>Driver: \${escapeHtml(g.driverVersion || 'N/A')}</span>
                  </div>
                  <div class="progress-bar-bg" style="margin-top: 6px;">
                    <div class="progress-bar-fill \${vramPct > 85 ? 'fill-red' : 'fill-green'}" style="width: \${vramPct}%"></div>
                  </div>
                \` : '<div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">Integrated / WMI GPU Active</div>'}
              </div>
            \`;
          }).join('');
          gpuContainer.innerHTML = gpuHtml;
        } else {
          gpuContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">Standard Graphics Adapter Active (No dedicated NVIDIA GPU detected)</div>';
        }

        // Logs
        logsCache = logsRes.logs || [];
        renderLogs();
      } catch (err) {
        console.warn('Dashboard fetch error:', err);
      }
    }

    async function clearLogs() {
      await fetch('/api/monitor/logs', { method: 'DELETE' });
      logsCache = [];
      renderLogs();
    }

    document.addEventListener('keydown', event => {
      const active = document.activeElement;
      const tag = active && active.tagName
        ? active.tagName.toUpperCase()
        : '';
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (active && active.isContentEditable)
      ) {
        return;
      }
      if (pendingApprovalShortcuts.length !== 1) return;

      const jobId = pendingApprovalShortcuts[0];
      if (event.key === 'Enter') {
        event.preventDefault();
        void approvalAction(jobId, 'approve');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        void approvalAction(jobId, 'deny');
      }
    });

    // Auto-refresh interval
    setInterval(() => {
      if (document.getElementById('autoRefresh').checked) {
        fetchData();
      }
    }, 2500);
    setInterval(refreshApprovalCountdowns, 1000);

    // Initial fetch (exchange token first if provided in URL)
    exchangeTokenIfNeeded().then(() => fetchData());
  </script>
</body>
</html>`;
}
