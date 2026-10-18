/**
 * WinHelm v1.4.1 Product Shell — Connections View
 * 
 * Manages client connections, separates local client state from Remote Access state,
 * and houses the verified ChatGPT tunnel lifecycle surface.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderConnectionsView(ctx: ShellRenderContext): string {
  const { messages } = ctx;

  return `
    <section id="panel-connections" class="panel" aria-labelledby="heading-connections">
      <div class="panel-header">
        <h1 id="heading-connections" class="panel-title">${escapeHtml(messages.connTitle)}</h1>
        <p class="panel-desc">${escapeHtml(messages.shellConnectionsDesc || "Manage local AI client applications, reverse tunnels, and network access.")}</p>
      </div>

      <!-- REMOTE ACCESS & INGRESS CONTROL BANNER -->
      <div id="connectionsRemoteStatusBanner" class="banner banner-info" role="region" aria-label="${escapeHtml(messages.shellConnectionsAriaRemotePosture || "Remote Access Posture")}">
        <div class="banner-content">
          <span aria-hidden="true" style="font-size:18px;">🔒</span>
          <div>
            <strong id="connRemoteStatusHeading">${escapeHtml(messages.shellHomeLocalReady || "Local Ready")} · ${escapeHtml(messages.shellHomeRemoteOff || "Remote Access Off")}</strong>
            <div id="connRemoteStatusDetail" style="font-size:12px; margin-top:2px;">
              ${escapeHtml(messages.shellHomeRemoteDetail || "Listening on 127.0.0.1 loopback only. Zero public exposure.")}
            </div>
          </div>
        </div>
      </div>

      <!-- FIRST-CLASS CLIENT INTEGRATIONS -->
      <h2 class="policy-group-title" style="margin-top:var(--space-5);">${escapeHtml(messages.shellConnectionsFirstClassHeading || "First-Class Clients")}</h2>
      <div class="card-grid-2">
        <!-- Claude Desktop -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellConnectionsAriaClaude || "Claude Desktop Integration")}">
          <div class="card-header">
            <strong style="color:var(--text-primary); font-size:var(--text-md);">${escapeHtml(messages.connClaudeLabel)}</strong>
            <span class="status-pill status-ready">${escapeHtml(messages.connClaudeType)}</span>
          </div>
          <div class="card-sub">
            ${escapeHtml(messages.shellConnectionsClaudeDesc || "Direct local client connection via native config update.")}
            <div id="connClaudeStatus" style="font-size:12px; margin-top:4px;">${escapeHtml(messages.shellConnectionsCheckingStatus || "Checking status…")}</div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${escapeHtml(messages.connRestartHint || "If this client was running, restart it or reconnect so the new configuration is loaded.")}</div>
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button class="btn-secondary" onclick="handleClientPreview('claude')">${escapeHtml(messages.shellConnectionsBtnPreview || "Preview")}</button>
            <button class="btn-primary" onclick="handleClientApply('claude')">${escapeHtml(messages.connConfigure)}</button>
          </div>
        </div>

        <!-- Cursor -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellConnectionsAriaCursor || "Cursor Editor Integration")}">
          <div class="card-header">
            <strong style="color:var(--text-primary); font-size:var(--text-md);">${escapeHtml(messages.connCursorLabel)}</strong>
            <span class="status-pill status-ready">${escapeHtml(messages.connCursorType)}</span>
          </div>
          <div class="card-sub">
            ${escapeHtml(messages.shellConnectionsCursorDesc || "Workspace and editor client integration via local config.")}
            <div id="connCursorStatus" style="font-size:12px; margin-top:4px;">${escapeHtml(messages.shellConnectionsCheckingStatus || "Checking status…")}</div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${escapeHtml(messages.connRestartHint || "If this client was running, restart it or reconnect so the new configuration is loaded.")}</div>
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button class="btn-secondary" onclick="handleClientPreview('cursor')">${escapeHtml(messages.shellConnectionsBtnPreview || "Preview")}</button>
            <button class="btn-primary" onclick="handleClientApply('cursor')">${escapeHtml(messages.connConfigure)}</button>
          </div>
        </div>

        <!-- ChatGPT / OpenAI Tunnel -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellConnectionsAriaChatgpt || "ChatGPT Integration")}">
          <div class="card-header">
            <strong style="color:var(--text-primary); font-size:var(--text-md);">${escapeHtml(messages.connChatgptLabel)}</strong>
            <span class="status-pill status-info">${escapeHtml(messages.connChatgptType)}</span>
          </div>
          <div class="card-sub">
            ${escapeHtml(messages.shellConnectionsChatgptDesc || "Managed reverse tunnel for ChatGPT actions.")}
            <div id="connChatgptStatus" style="font-size:12px; margin-top:4px;">${escapeHtml(messages.shellConnectionsCheckingStatus || "Checking status…")}</div>
          </div>

          <!-- M3A P2 LIFECYCLE CONTROLS -->
          <div style="border-top:1px solid var(--border-subtle); margin-top:var(--space-3); padding-top:var(--space-3);">
            <div style="font-weight:600; font-size:var(--text-xs); text-transform:uppercase; margin-bottom:var(--space-2); color:var(--text-muted);">
              ${escapeHtml(messages.connChatgptLifecycleTitle)}
            </div>
            
            <div style="font-size:var(--text-xs); display:flex; flex-direction:column; gap:4px; margin-bottom:var(--space-3);">
              <div>${escapeHtml(messages.connChatgptDependencyLabel)}: <span id="tunnelDependencyStatus">${escapeHtml(messages.shellConnectionsStatusChecking || "checking…")}</span></div>
              <div>${escapeHtml(messages.connChatgptProfileLabel)}: <span id="tunnelProfileStatus">${escapeHtml(messages.shellConnectionsStatusChecking || "checking…")}</span></div>
              <div>${escapeHtml(messages.connChatgptBackendLabel)}: <span id="tunnelBackendStatus">${escapeHtml(messages.shellConnectionsStatusChecking || "checking…")}</span></div>
              <div>${escapeHtml(messages.connChatgptStateLabel)}: <span id="tunnelStateBadge" class="status-pill status-neutral">${escapeHtml(messages.shellConnectionsStatusUnknown || "unknown")}</span></div>
              <div>${escapeHtml(messages.connChatgptOwnershipLabel)}: <span id="tunnelOwnershipBadge" class="status-pill status-neutral">${escapeHtml(messages.shellConnectionsStatusUnknown || "unknown")}</span></div>
            </div>

            <div id="tunnelDetail" style="font-size:var(--text-xs); color:var(--text-muted); margin-bottom:var(--space-3);"></div>

            <div style="margin-bottom:var(--space-3);">
              <label for="tunnelConfirmInput" style="font-size:11px; display:block; margin-bottom:4px; color:var(--text-secondary);">
                ${escapeHtml(messages.connChatgptConfirmHint)}
              </label>
              <input type="text" id="tunnelConfirmInput" placeholder="${escapeHtml(messages.connChatgptConfirmPlaceholder)}" style="width:100%; max-width:240px; font-size:12px; padding:4px 8px;" />
            </div>

            <div style="display:flex; gap:var(--space-2); flex-wrap:wrap; margin-bottom:var(--space-2);">
              <button class="btn-primary" style="font-size:12px; padding:4px 10px;" onclick="handleTunnelStart()">${escapeHtml(messages.connChatgptActionStart)}</button>
              <button class="btn-secondary" style="font-size:12px; padding:4px 10px;" onclick="handleTunnelStop()">${escapeHtml(messages.connChatgptActionStop)}</button>
              <button class="btn-secondary" style="font-size:12px; padding:4px 10px;" onclick="handleTunnelRestart()">${escapeHtml(messages.connChatgptActionRestart)}</button>
              <button class="btn-secondary" style="font-size:12px; padding:4px 10px;" onclick="handleTunnelDoctor()">${escapeHtml(messages.connChatgptActionDoctor)}</button>
            </div>

            <div id="tunnelActionResult" style="font-size:var(--text-xs); margin-top:4px;"></div>
          </div>
        </div>

        <!-- Tailscale HTTPS /mcp -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellConnectionsAriaTailscale || "Tailscale Manual Integration")}">
          <div class="card-header">
            <strong id="connTailscaleLabel" style="color:var(--text-primary); font-size:var(--text-md);">${escapeHtml(messages.connTailscaleLabel)}</strong>
            <span class="status-pill status-neutral">${escapeHtml(messages.connTailscaleType)}</span>
          </div>
          <div class="card-sub">
            ${escapeHtml(messages.shellConnectionsTailscaleManual || "Manual Configuration")}
            <p style="font-size:12px; color:var(--text-secondary); margin-top:4px;">
              ${escapeHtml(messages.shellConnectionsTailscaleDesc || "End-to-end encrypted mesh remote access. Requires manual Tailscale Funnel / Serve configuration.")}
            </p>
          </div>
          <div style="margin-top:auto;">
            <a href="https://tailscale.com/kb/1223/funnel" target="_blank" rel="noopener noreferrer" class="card-action-link">
              ${escapeHtml(messages.shellConnectionsTailscaleDoc || "Tailscale Documentation ↗")}
            </a>
          </div>
        </div>
      </div>

      <div id="clientActionResult" style="display:none; margin-top:var(--space-4); font-size:12px;"></div>

      <!-- ACTIVE MCP CLIENT SESSIONS TABLE -->
      <h2 class="policy-group-title" style="margin-top:var(--space-5);">${escapeHtml(messages.shellConnectionsSessionsTitle || "Active Client Sessions")}</h2>
      <div class="data-table-container" role="region" aria-label="${escapeHtml(messages.shellConnectionsAriaSessions || "Active Client Sessions")}">
        <table class="data-table">
          <thead>
            <tr>
              <th>${escapeHtml(messages.shellConnectionsThClientName || "Client Name")}</th>
              <th>${escapeHtml(messages.shellConnectionsThHostAddr || "Host Address")}</th>
              <th>${escapeHtml(messages.shellConnectionsThTransport || "Transport Protocol")}</th>
              <th>${escapeHtml(messages.shellConnectionsThSessionId || "Session ID")}</th>
              <th>${escapeHtml(messages.shellConnectionsThStatus || "Status")}</th>
            </tr>
          </thead>
          <tbody id="clientSessions">
            <tr>
              <td colspan="5" style="text-align:center; color:var(--text-muted); padding:var(--space-4);">
                ${escapeHtml(messages.shellConnectionsNoSessions || "No active MCP client sessions announced yet.")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
}
