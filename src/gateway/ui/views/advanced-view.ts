/**
 * WinHelm v1.4.1 Product Shell — Advanced Diagnostics View
 * 
 * Progressive disclosure of internal endpoints, dynamic port routing,
 * process generations, and preserved escape link to /dashboard.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderAdvancedView(ctx: ShellRenderContext): string {
  const { messages } = ctx;
  const dynamicPorts = ctx.adapters?.dynamicPorts ?? { mode: "unknown", endpoints: [] };
  const portMode = dynamicPorts.mode;

  const modeBadgeText = portMode === "automatic"
    ? escapeHtml(messages.shellAdvancedPortsAutomatic)
    : portMode === "fixed"
    ? escapeHtml(messages.shellAdvancedPortsFixed)
    : escapeHtml(messages.shellAdvancedPortsUnknown);

  const modePillClass = (portMode === "unknown" || portMode === "unavailable") ? "status-pill status-neutral" : "status-pill status-ready";

  const endpoints = dynamicPorts.endpoints || [];
  let endpointsHtml = "";
  if (endpoints.length === 0) {
    endpointsHtml = `
      <tr>
        <td colspan="3" style="text-align:center; padding:var(--space-4); color:var(--text-muted);">
          ${escapeHtml(messages.shellAdvancedNoEndpoints)}
        </td>
      </tr>
    `;
  } else {
    endpointsHtml = endpoints.map((ep) => `
      <tr>
        <td><strong>${escapeHtml(ep.service)}</strong></td>
        <td><code>${escapeHtml(ep.url)}</code></td>
        <td><span class="status-pill status-ready">${escapeHtml(ep.status)}</span></td>
      </tr>
    `).join("");
  }

  return `
    <section id="panel-advanced" class="panel" aria-labelledby="heading-advanced">
      <div class="panel-header">
        <h1 id="heading-advanced" class="panel-title">${escapeHtml(messages.navAdvanced)}</h1>
        <p class="panel-desc">${escapeHtml(messages.shellAdvancedDesc)}</p>
      </div>

      <!-- TRANCHE A: DYNAMIC INTERNAL PORTS CARD (Blocker B Fix) -->
      <div class="card" style="margin-bottom:var(--space-5);" role="region" aria-label="${escapeHtml(messages.shellAdvancedAriaPorts)}">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellAdvancedPortsTitle)}</span>
          <span id="advPortAllocationPill" class="${modePillClass}">${modeBadgeText}</span>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
          ${escapeHtml(messages.shellAdvancedPortsDesc)}
        </div>

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml(messages.shellAdvancedTableTarget)}</th>
                <th>${escapeHtml(messages.shellAdvancedTableAddress)}</th>
                <th>${escapeHtml(messages.shellAdvancedTableState)}</th>
              </tr>
            </thead>
            <tbody id="advEndpointsTableBody">
              ${endpointsHtml}
            </tbody>
          </table>
        </div>
      </div>

      <!-- PROCESS RUNTIME TELEMETRY -->
      <div class="card" style="margin-bottom:var(--space-5);" role="region" aria-label="${escapeHtml(messages.shellAdvancedAriaTelemetry)}">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellAdvancedTelemetryTitle)}</span>
          <span class="status-pill status-ready"><span class="status-dot green"></span> ${escapeHtml(messages.shellAdvancedStatusHealthy)}</span>
        </div>
        <div class="card-grid" style="margin-bottom:0;">
          <div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(messages.shellAdvancedLblHost)}</div>
            <strong id="advProcessPid" style="font-size:16px;">${escapeHtml(messages.shellAdvancedHostNodejs)}</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(messages.shellAdvancedLblLoopback)}</div>
            <strong style="font-size:16px;">127.0.0.1</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(messages.shellAdvancedLblSessions)}</div>
            <strong id="advActiveSessionCount" style="font-size:16px;">0</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(messages.shellAdvancedLblAuth)}</div>
            <strong style="font-size:16px;">${escapeHtml(messages.shellAdvancedAuthAdminauth)}</strong>
          </div>
        </div>
      </div>

      <!-- PRESERVED ENGINEERING MONITOR ESCAPE HATCH -->
      <div class="banner banner-info" role="region" aria-label="${escapeHtml(messages.shellAdvancedAriaLegacy)}">
        <div class="banner-content">
          <span aria-hidden="true" style="font-size:18px;">🛠️</span>
          <div>
            <strong>${escapeHtml(messages.shellAdvancedLegacyTitle)}</strong>
            <div style="font-size:12px; margin-top:2px;">
              ${escapeHtml(messages.shellAdvancedLegacyDesc)}
            </div>
          </div>
        </div>
        <a href="/dashboard" class="banner-btn" style="text-decoration:none;">
          ${escapeHtml(messages.shellAdvancedLegacyLink)}
        </a>
      </div>
    </section>
  `;
}
