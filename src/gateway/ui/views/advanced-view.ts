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
    ? escapeHtml(messages.shellAdvancedPortsAutomatic || "Automatic Mode")
    : portMode === "fixed"
    ? escapeHtml(messages.shellAdvancedPortsFixed || "Fixed Mode")
    : escapeHtml(messages.shellAdvancedPortsUnknown || "Not yet integrated / Unavailable");

  const modePillClass = (portMode === "unknown" || portMode === "unavailable") ? "status-pill status-neutral" : "status-pill status-ready";

  const endpoints = dynamicPorts.endpoints || [];
  let endpointsHtml = "";
  if (endpoints.length === 0) {
    endpointsHtml = `
      <tr>
        <td colspan="3" style="text-align:center; padding:var(--space-4); color:var(--text-muted);">
          ${escapeHtml(messages.shellAdvancedNoEndpoints || "Endpoint topology will be resolved dynamically when Tranche A integration is active.")}
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
        <p class="panel-desc">${escapeHtml(messages.shellAdvancedDesc || "Technical plumbing, dynamic routing targets, and diagnostic probes.")}</p>
      </div>

      <!-- TRANCHE A: DYNAMIC INTERNAL PORTS CARD (Blocker B Fix) -->
      <div class="card" style="margin-bottom:var(--space-5);" role="region" aria-label="Dynamic Internal Ports">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellAdvancedPortsTitle || "Internal Port Routing (Tranche A)")}</span>
          <span id="advPortAllocationPill" class="${modePillClass}">${modeBadgeText}</span>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
          ${escapeHtml(messages.shellAdvancedPortsDesc || "WinHelm dynamically assigns internal loopback ports to prevent port conflicts with other local software.")}
        </div>

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml(messages.shellAdvancedTableTarget || "Internal Endpoint Target")}</th>
                <th>${escapeHtml(messages.shellAdvancedTableAddress || "Resolved Loopback Address")}</th>
                <th>${escapeHtml(messages.shellAdvancedTableState || "Allocation State")}</th>
              </tr>
            </thead>
            <tbody id="advEndpointsTableBody">
              ${endpointsHtml}
            </tbody>
          </table>
        </div>
      </div>

      <!-- PROCESS RUNTIME TELEMETRY -->
      <div class="card" style="margin-bottom:var(--space-5);" role="region" aria-label="Process Telemetry">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellAdvancedTelemetryTitle || "Host Process Telemetry")}</span>
          <span class="status-pill status-ready"><span class="status-dot green"></span> Healthy</span>
        </div>
        <div class="card-grid" style="margin-bottom:0;">
          <div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(messages.shellAdvancedLblHost || "HOST PROCESS")}</div>
            <strong id="advProcessPid" style="font-size:16px;">Node.js Host</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(messages.shellAdvancedLblLoopback || "LOOPBACK INTERFACE")}</div>
            <strong style="font-size:16px;">127.0.0.1</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(messages.shellAdvancedLblSessions || "ACTIVE SESSIONS")}</div>
            <strong id="advActiveSessionCount" style="font-size:16px;">0</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(messages.shellAdvancedLblAuth || "AUTHORIZATION PLANE")}</div>
            <strong style="font-size:16px;">Local AdminAuth</strong>
          </div>
        </div>
      </div>

      <!-- PRESERVED ENGINEERING MONITOR ESCAPE HATCH -->
      <div class="banner banner-info" role="region" aria-label="Legacy Dashboard Access">
        <div class="banner-content">
          <span aria-hidden="true" style="font-size:18px;">🛠️</span>
          <div>
            <strong>${escapeHtml(messages.shellAdvancedLegacyTitle || "Preserved Engineering Dashboard (/dashboard)")}</strong>
            <div style="font-size:12px; margin-top:2px;">
              ${escapeHtml(messages.shellAdvancedLegacyDesc || "Need raw hardware metrics, low-level socket inspection, or complete tool lists? Access the preserved engineering monitor directly.")}
            </div>
          </div>
        </div>
        <a href="/dashboard" class="banner-btn" style="text-decoration:none;">
          ${escapeHtml(messages.shellAdvancedLegacyLink || "Open Advanced / Diagnostics Monitor ↗")}
        </a>
      </div>
    </section>
  `;
}
