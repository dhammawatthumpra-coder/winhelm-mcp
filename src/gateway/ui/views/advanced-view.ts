/**
 * WinHelm v1.4.1 Product Shell — Advanced Diagnostics View
 * 
 * Progressive disclosure of internal endpoints, dynamic port routing,
 * process generations, and preserved escape link to /dashboard.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderAdvancedView(ctx: ShellRenderContext): string {
  const { messages } = ctx;

  return `
    <section id="panel-advanced" class="panel" aria-labelledby="heading-advanced">
      <div class="panel-header">
        <h1 id="heading-advanced" class="panel-title">${escapeHtml(messages.navAdvanced)}</h1>
        <p class="panel-desc">Technical plumbing, dynamic routing targets, and diagnostic probes.</p>
      </div>

      <!-- TRANCHE A: DYNAMIC INTERNAL PORTS CARD -->
      <div class="card" style="margin-bottom:var(--space-5);" role="region" aria-label="Dynamic Internal Ports">
        <div class="card-header">
          <span class="card-label">Internal Port Routing (Tranche A)</span>
          <span id="advPortAllocationPill" class="status-pill status-ready">Automatic Mode</span>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
          WinHelm dynamically assigns internal loopback ports to prevent port conflicts with other local software.
        </div>

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Internal Endpoint Target</th>
                <th>Resolved Loopback Address</th>
                <th>Allocation State</th>
              </tr>
            </thead>
            <tbody id="advEndpointsTableBody">
              <tr>
                <td><strong>Core Loopback Gateway</strong></td>
                <td><code id="advCoreEndpoint">http://127.0.0.1:18820</code></td>
                <td><span class="status-pill status-ready">Active</span></td>
              </tr>
              <tr>
                <td><strong>R7 Subprocess Internal Target</strong></td>
                <td><code id="advR7Endpoint">http://127.0.0.1:18821</code></td>
                <td><span class="status-pill status-ready">Bound</span></td>
              </tr>
              <tr>
                <td><strong>R8 Local Ingress Listener</strong></td>
                <td><code id="advR8Endpoint">http://127.0.0.1:18822</code></td>
                <td><span class="status-pill status-ready">Bound</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- PROCESS RUNTIME TELEMETRY -->
      <div class="card" style="margin-bottom:var(--space-5);" role="region" aria-label="Process Telemetry">
        <div class="card-header">
          <span class="card-label">Host Process Telemetry</span>
          <span class="status-pill status-ready"><span class="status-dot green"></span> Healthy</span>
        </div>
        <div class="card-grid" style="margin-bottom:0;">
          <div>
            <div style="font-size:11px; color:var(--text-muted);">HOST PROCESS</div>
            <strong id="advProcessPid" style="font-size:16px;">Node.js Host</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">LOOPBACK INTERFACE</div>
            <strong style="font-size:16px;">127.0.0.1</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">ACTIVE SESSIONS</div>
            <strong id="advActiveSessionCount" style="font-size:16px;">0</strong>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted);">AUTHORIZATION PLANE</div>
            <strong style="font-size:16px;">Local AdminAuth</strong>
          </div>
        </div>
      </div>

      <!-- PRESERVED ENGINEERING MONITOR ESCAPE HATCH -->
      <div class="banner banner-info" role="region" aria-label="Legacy Dashboard Access">
        <div class="banner-content">
          <span aria-hidden="true" style="font-size:18px;">🛠️</span>
          <div>
            <strong>Preserved Engineering Dashboard (/dashboard)</strong>
            <div style="font-size:12px; margin-top:2px;">
              Need raw hardware metrics, low-level socket inspection, or complete tool lists?
              Access the preserved engineering monitor directly.
            </div>
          </div>
        </div>
        <a href="/dashboard" class="banner-btn" style="text-decoration:none;">
          Open Advanced / Diagnostics Monitor ↗
        </a>
      </div>
    </section>
  `;
}
