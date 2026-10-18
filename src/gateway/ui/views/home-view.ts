/**
 * WinHelm v1.4.1 Product Shell — Home View
 * 
 * Answers the 5 daily operational questions immediately:
 * 1. Is WinHelm running and healthy?
 * 2. Is anything waiting for my attention?
 * 3. Which clients are connected or configured?
 * 4. What security/access posture am I currently using?
 * 5. Is Remote Access off or on?
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderHomeView(ctx: ShellRenderContext): string {
  const messages = ctx.messages || {};
  const schemaMode = ctx.schemaMode || "legacy";
  const terminalMode = ctx.terminalMode || "ask";
  const displayProfile = String(ctx.displayProfile || ctx.preset || "balanced");
  const approvalMode = String(ctx.approvalMode || "manual");
  const isModified = ctx.isModified === true;

  return `
    <section id="panel-overview" class="panel active" aria-labelledby="heading-home">
      <div class="panel-header">
        <h1 id="heading-home" class="panel-title">${escapeHtml(messages.navOverview)}</h1>
        <p class="panel-desc">${escapeHtml(messages.shellHomeDesc || "WinHelm runtime status, security boundary, and client overview.")}</p>
      </div>

      <!-- SYSTEM WARNINGS & NOTICES -->
      <div id="homeWarningBanners">
        ${schemaMode === "legacy" ? `<div class="banner banner-warning">${escapeHtml(messages.legacyBanner)}</div>` : ""}
        ${terminalMode === "full" ? `<div class="banner banner-danger">${escapeHtml(messages.fullWarn)}</div>` : ""}
        <div id="homeUrgentBanner" class="banner banner-warning" style="display:none;" role="alert">
          <div class="banner-content">
            <span aria-hidden="true" style="font-size:18px;">⚠️</span>
            <div>
              <strong id="urgentBannerTitle">${escapeHtml(messages.shellHomeUrgentTitle || "Action Required")}</strong>
              <div id="urgentBannerSubtitle" style="font-size:12px; margin-top:2px;"></div>
            </div>
          </div>
          <button class="banner-btn" onclick="showTab('approvals')">${escapeHtml(messages.shellHomeUrgentReview || "Review in Inbox")}</button>
        </div>
      </div>

      <!-- 4 CORE POSTURE TILES -->
      <div class="card-grid">
        <!-- 1. APPROVALS POSTURE -->
        <div class="card" onclick="showTab('approvals')" style="cursor:pointer;" role="region" aria-label="${escapeHtml(messages.shellHomeAriaApprovalsSummary || "Approvals Summary")}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.pendingTitle)}</span>
            <span id="statPendingBadge" class="status-pill status-ready">
              <span class="status-dot green"></span> 0 ${escapeHtml(messages.shellHomePendingCountSuffix || "Pending")}
            </span>
          </div>
          <div class="card-value" id="statPendingApprovals">0</div>
          <div class="card-sub">${escapeHtml(messages.shellHomeApprovalsSub || "Tool executions requiring your authorization")}</div>
          <a href="javascript:void(0)" class="card-action-link">${escapeHtml(messages.shellHomeOpenInbox || "Open Inbox →")}</a>
        </div>

        <!-- 2. ACCESS POSTURE -->
        <div class="card" onclick="showTab('access')" style="cursor:pointer;" role="region" aria-label="${escapeHtml(messages.shellHomeAriaAccessSummary || "Access Posture Summary")}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.profileTitle)}</span>
            <span class="status-pill status-neutral">${escapeHtml(displayProfile.toUpperCase())}</span>
          </div>
          <div class="card-value" id="statProfile">
            ${escapeHtml(displayProfile.toUpperCase())} ${isModified ? `<span class="badge badge-warning" style="font-size:11px;">${escapeHtml(messages.profileModified)}</span>` : ""}
          </div>
          <div class="card-sub">
            ${escapeHtml(messages.shellHomePolicyLabel || "Policy:")} <strong id="statApprovalMode">${escapeHtml(approvalMode.toUpperCase())}</strong>
            <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
              ${escapeHtml(messages.shellHomePolicyDesc || "Safe Profile restricts tool exposure; terminal mode controls execution safety.")}
            </div>
          </div>
          <a href="javascript:void(0)" class="card-action-link">${escapeHtml(messages.shellHomeReviewPolicy || "Review Policy →")}</a>
        </div>

        <!-- 3. REMOTE ACCESS POSTURE -->
        <div class="card" onclick="showTab('connections')" style="cursor:pointer;" role="region" aria-label="${escapeHtml(messages.shellHomeAriaRemoteSummary || "Remote Access Summary")}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.shellHomeRemoteTitle || "Remote Access")}</span>
            <span id="statRemotePill" class="status-pill status-ready">
              <span class="status-dot green"></span> ${escapeHtml(messages.shellHomeRemoteOff || "Remote Access Off")}
            </span>
          </div>
          <div class="card-value" id="statRemoteText">${escapeHtml(messages.shellHomeLocalReady || "Local Ready")}</div>
          <div class="card-sub" id="statRemoteDetail">
            ${escapeHtml(messages.shellHomeRemoteDetail || "Listening on 127.0.0.1 loopback only. Zero public exposure.")}
          </div>
          <a href="javascript:void(0)" class="card-action-link">${escapeHtml(messages.shellHomeConfigureIngress || "Configure Ingress →")}</a>
        </div>

        <!-- 4. CLIENT ECOSYSTEM -->
        <div class="card" onclick="showTab('connections')" style="cursor:pointer;" role="region" aria-label="${escapeHtml(messages.shellHomeAriaClientsSummary || "Client Ecosystem Summary")}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.connectionsTitle)}</span>
            <span class="status-pill status-ready" id="statClientBadge">${escapeHtml(messages.connConnected || "Connected")}</span>
          </div>
          <div class="card-value" id="statConnectedClients">0 ${escapeHtml(messages.shellHomeClientsConnectedSuffix || "Connected")}</div>
          <div class="card-sub" id="statClientList">
            Claude Desktop, Cursor, ChatGPT, Gemini
          </div>
          <a href="javascript:void(0)" class="card-action-link">${escapeHtml(messages.shellHomeViewClients || "View Clients →")}</a>
        </div>
      </div>

      <!-- SERVER STATUS & QUICK ACCESS -->
      <div class="card-grid-2">
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellHomeAriaRuntimeStatus || "Runtime Status")}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.shellHomeServerStatus || "Server Status")}</span>
            <span class="status-pill status-ready"><span class="status-dot green"></span> ${escapeHtml(messages.shellHomeServerRunning || "Running")}</span>
          </div>
          <div class="card-value">
            <span id="statServerStatus">${escapeHtml(messages.statusRunning)}</span>
          </div>
          <div class="card-sub" id="statServerInfo">${escapeHtml(messages.shellHomeServerInfo || "WinHelm MCP Server")}</div>
          <div id="statWarnings" style="font-size:12px; color:var(--text-muted);">
            ${escapeHtml(messages.warningsNone)}
          </div>
        </div>

        <div class="card" role="region" aria-label="${escapeHtml(messages.shellHomeAriaQuickActions || "Quick Actions")}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.shellHomeShortcutsTitle || "Operational Shortcuts")}</span>
          </div>
          <div style="flex-direction:column; gap:var(--space-2); margin-top:var(--space-1); display:flex;">
            <button class="btn-secondary" style="text-align:left; font-size:13px;" onclick="showTab('approvals')">
              🛡️ ${escapeHtml(messages.shellHomeShortcutApprovals || "Review Pending Approvals")} (<span id="quickApprovalCount">0</span>)
            </button>
            <button class="btn-secondary" style="text-align:left; font-size:13px;" onclick="showTab('connections')">
              🔗 ${escapeHtml(messages.shellHomeShortcutConnections || "Verify AI Client Integrations")}
            </button>
            <button class="btn-secondary" style="text-align:left; font-size:13px;" onclick="showTab('access')">
              🔒 ${escapeHtml(messages.shellHomeShortcutAccess || "Manage Allowed Folders & Security Policy")}
            </button>
          </div>
        </div>
      </div>

      <!-- RECENT ACTIVITY TIMELINE -->
      <div class="card" style="margin-top:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellHomeAriaRecentActivity || "Recent Activity Stream")}">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellHomeActivityTitle || "Recent Operational Activity")}</span>
          <a href="javascript:void(0)" onclick="showTab('activity')" class="card-action-link">${escapeHtml(messages.shellHomeActivityViewAll || "View Full Audit Log →")}</a>
        </div>
        <div id="homeRecentActivityList" class="timeline-list">
          <div style="color:var(--text-muted); font-size:var(--text-xs); padding:var(--space-2);">${escapeHtml(messages.shellHomeActivityLoading || "Loading recent activity…")}</div>
        </div>
      </div>
    </section>
  `;
}
