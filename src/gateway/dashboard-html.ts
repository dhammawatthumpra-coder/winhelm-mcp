import { PROFILES, type ToolProfile } from "../config/profiles.js";

/**
 * Lightweight, zero-dependency, self-contained Web Monitor Dashboard for WinHelm.
 * Served directly by Express without external CDN dependencies.
 */
export function getDashboardHtml(activeProfile: ToolProfile = "full"): string {
  const profileDef = PROFILES[activeProfile] || PROFILES.full;
  const activeTools = profileDef.tools;
  const activeCount = activeTools.length;

  const renderTool = (name: string, color: string) => {
    const isAct = activeTools.includes(name);
    if (isAct) {
      return `<div class="tool-item"><span class="tool-dot" style="background: ${color};"></span> ${name}</div>`;
    }
    return `<div class="tool-item inactive" title="Not loaded in ${profileDef.name} profile"><span class="tool-dot" style="background: #4b5563;"></span> <span style="text-decoration: line-through; opacity: 0.6;">${name}</span></div>`;
  };

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
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-area">
        <h2>⚡ WinHelm</h2>
        <span class="status-badge"><span class="pulse-dot"></span> LIVE MONITOR</span>
        <span class="status-badge" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.4); text-transform: uppercase;">PROFILE: ${profileDef.name.toUpperCase()} (${activeCount} TOOLS)</span>
      </div>
      <div class="header-controls">
        <label class="toggle-label">
          <input type="checkbox" id="autoRefresh" checked> Auto-refresh (2.5s)
        </label>
        <button id="btnRefresh" onclick="fetchData()">🔄 Refresh</button>
        <button onclick="window.open('/api/monitor/export?format=json')">📥 Export JSON</button>
        <button onclick="window.open('/api/monitor/export?format=csv')">📥 Export CSV</button>
        <button id="btnClear" onclick="clearLogs()">🗑️ Clear</button>
      </div>
    </header>

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
        <div class="card-title" style="margin-bottom: 0;">Registered Tools (${activeCount} Active in ${profileDef.name} Profile / 38 Total)</div>
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
      <div class="tools-grid">
        <!-- Terminal & Tasks -->
        ${renderTool("terminal_run", "#10b981")}
        ${renderTool("terminal_task_start", "#8b5cf6")}
        ${renderTool("terminal_task_list", "#8b5cf6")}
        ${renderTool("terminal_task_logs", "#8b5cf6")}
        ${renderTool("terminal_task_send", "#8b5cf6")}
        ${renderTool("terminal_task_kill", "#8b5cf6")}
        <!-- Filesystem & Archives -->
        ${renderTool("file_read", "#3b82f6")}
        ${renderTool("file_write", "#3b82f6")}
        ${renderTool("file_edit", "#3b82f6")}
        ${renderTool("file_list", "#3b82f6")}
        ${renderTool("file_search", "#3b82f6")}
        ${renderTool("file_delete_safe", "#3b82f6")}
        ${renderTool("file_move", "#3b82f6")}
        ${renderTool("file_copy", "#3b82f6")}
        ${renderTool("archive_zip", "#3b82f6")}
        ${renderTool("archive_unzip", "#3b82f6")}
        ${renderTool("file_tail", "#3b82f6")}
        ${renderTool("file_hash", "#3b82f6")}
        <!-- Search & Documents -->
        ${renderTool("file_search_ripgrep", "#f59e0b")}
        ${renderTool("pdf_generate", "#f59e0b")}
        ${renderTool("file_preview", "#f59e0b")}
        <!-- Desktop, Clipboard & Toast -->
        ${renderTool("clipboard_get", "#ec4899")}
        ${renderTool("clipboard_set", "#ec4899")}
        ${renderTool("screen_capture", "#ec4899")}
        ${renderTool("system_open", "#ec4899")}
        ${renderTool("notification_send", "#ec4899")}
        <!-- System, Hardware & Services -->
        ${renderTool("system_info", "#06b6d4")}
        ${renderTool("gpu_info", "#06b6d4")}
        ${renderTool("process_list", "#06b6d4")}
        ${renderTool("process_kill", "#06b6d4")}
        ${renderTool("port_check", "#06b6d4")}
        ${renderTool("eventlog_query", "#06b6d4")}
        ${renderTool("service_list", "#06b6d4")}
        ${renderTool("service_status", "#06b6d4")}
        ${renderTool("service_control", "#06b6d4")}
        <!-- Network & Probe -->
        ${renderTool("http_ping", "#14b8a6")}
        ${renderTool("http_request", "#14b8a6")}
        ${renderTool("network_info", "#14b8a6")}
        <!-- MCP Resource -->
        ${renderResource()}
      </div>
    </div>
  </div>

  <script>
    let currentFilter = 'all';
    let logsCache = [];

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
        const detail = log.detail ? log.detail.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '-';

        return \`
          <tr>
            <td style="color: var(--text-muted)">\${formatTime(log.timestamp)}</td>
            <td><span class="badge \${badgeClass}">\${typeLabel}</span></td>
            <td style="font-weight: 600; color: #fff;">\${log.title}</td>
            <td style="color: #cbd5e1; word-break: break-all;">\${detail}</td>
            <td style="color: var(--text-muted)">\${duration}</td>
            <td><span class="status-tag \${statusClass}">\${log.status || 'OK'}</span></td>
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
                  <span>Drive \${d.Name}:</span>
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
                  <span>\${g.name}</span>
                  <span style="color: \${tempColor};">\${tempText}</span>
                </div>
                \${g.memoryTotalMB ? \`
                  <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); margin-top: 4px;">
                    <span>VRAM: \${g.memoryUsedMB} MB / \${g.memoryTotalMB} MB</span>
                    <span>Driver: \${g.driverVersion || 'N/A'}</span>
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

    // Auto-refresh interval
    setInterval(() => {
      if (document.getElementById('autoRefresh').checked) {
        fetchData();
      }
    }, 2500);

    // Initial fetch (exchange token first if provided in URL)
    exchangeTokenIfNeeded().then(() => fetchData());
  </script>
</body>
</html>`;
}
