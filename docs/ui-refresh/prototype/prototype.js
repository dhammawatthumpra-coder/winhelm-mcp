/**
 * WinHelm v1.4.1 Dashboard UI Refresh — Interactive Prototype Controller
 * 
 * Features:
 * - 10-state quick switcher for Owner / Coordinator review
 * - Responsive viewport width switcher (Desktop, Tablet 900px, Mobile 480px)
 * - Tab navigation router (Home, Approvals, Connections, Access, Activity, Settings, Advanced)
 * - Live Approval decision workflow with mandatory typed confirmation validation
 * - Admin lock/unlock authentication modal simulation with session countdown
 * - Theme switcher (Dark / Light / Auto)
 * - Localization toggle (EN / TH)
 */

let currentState = null;
let currentLocale = "en";
let currentTheme = "dark";
let adminCountdownInterval = null;
let approvalCountdownInterval = null;

const I18N_STRINGS = {
  en: {
    navHome: "Home",
    navApprovals: "Approvals",
    navConnections: "Connections",
    navAccess: "Access & Security",
    navActivity: "Activity",
    navSettings: "Settings",
    navAdvanced: "Advanced",
    navSetup: "Setup Assistant",
    adminLocked: "Admin Locked",
    adminUnlocked: "Admin Unlocked",
    remoteOff: "Remote Access: OFF",
    remoteOn: "Remote Access: ON",
    remoteAttention: "Remote Access: Needs Attention",
    ready: "Ready",
    needsAttention: "Needs Attention",
    offline: "Offline",
    automaticPorts: "Automatic",
    fixedPorts: "Fixed (Legacy)",
    safeProfile: "Safe Profile",
    balancedProfile: "Balanced Profile",
    powerProfile: "Power Profile",
    manualMode: "Manual Prompting",
    smartMode: "Smart Prompting",
    trustedMode: "Trusted Prompting",
    btnApprove: "Approve Action",
    btnDeny: "Deny Action",
    btnUnlock: "Unlock Admin",
    btnLock: "Lock Admin",
    copySuccess: "Copied to clipboard"
  },
  th: {
    navHome: "หน้าหลัก",
    navApprovals: "รายการอนุมัติ",
    navConnections: "การเชื่อมต่อ",
    navAccess: "ความปลอดภัยและสิทธิ์",
    navActivity: "บันทึกกิจกรรม",
    navSettings: "การตั้งค่า",
    navAdvanced: "ขั้นสูง / วินิจฉัย",
    navSetup: "ตัวช่วยติดตั้ง / ซ่อมแซม",
    adminLocked: "ล็อกสิทธิ์ผู้ดูแล",
    adminUnlocked: "ปลดล็อกสิทธิ์ผู้ดูแล",
    remoteOff: "การเข้าถึงระยะไกล: ปิดอยู่",
    remoteOn: "การเข้าถึงระยะไกล: เปิดใช้งาน",
    remoteAttention: "การเข้าถึงระยะไกล: ต้องตรวจสอบ",
    ready: "พร้อมทำงาน",
    needsAttention: "ต้องตรวจสอบ",
    offline: "ออฟไลน์",
    automaticPorts: "พอร์ตอัตโนมัติ",
    fixedPorts: "พอร์ตคงที่ (โหมดเดิม)",
    safeProfile: "โปรไฟล์ Safe (อ่านอย่างเดียว)",
    balancedProfile: "โปรไฟล์ Balanced (มาตรฐาน)",
    powerProfile: "โปรไฟล์ Power (เต็มรูปแบบ)",
    manualMode: "ถามยืนยันทุกครั้ง (Manual)",
    smartMode: "ถามเฉพาะความเสี่ยงสูง (Smart)",
    trustedMode: "ไว้ใจในโฟลเดอร์ที่ระบุ (Trusted)",
    btnApprove: "อนุมัติการทำงาน",
    btnDeny: "ปฏิเสธคำขอ",
    btnUnlock: "ปลดล็อกผู้ดูแล",
    btnLock: "ล็อกผู้ดูแล",
    copySuccess: "คัดลอกลงคลิปบอร์ดแล้ว"
  }
};

function t(key) {
  return (I18N_STRINGS[currentLocale] && I18N_STRINGS[currentLocale][key]) || key;
}

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", () => {
  setupStateSelector();
  setupViewportSwitcher();
  setupTabNavigation();
  setupTheme();
  setupLanguageToggle();
  setupModals();
  
  // Default to state 1: healthy_nominal
  applyState("healthy_nominal");

  // Handle URL hash if provided
  const hash = window.location.hash.replace("#", "");
  if (hash) {
    if (hash.startsWith("job_")) {
      applyState("pending_approval");
      showTab("approvals");
    } else if (["home", "approvals", "connections", "access", "activity", "settings", "advanced"].includes(hash)) {
      showTab(hash);
    }
  }
});

// Setup Reviewer State Selector
function setupStateSelector() {
  const select = document.getElementById("stateSelect");
  if (!select) return;

  select.innerHTML = "";
  Object.keys(PROTOTYPE_MOCK_STATES).forEach(key => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = PROTOTYPE_MOCK_STATES[key].label;
    select.appendChild(opt);
  });

  select.addEventListener("change", (e) => {
    applyState(e.target.value);
  });
}

// Setup Viewport Switcher
function setupViewportSwitcher() {
  const container = document.getElementById("viewportContainer");
  const buttons = document.querySelectorAll(".viewport-btn");

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const mode = btn.dataset.viewport;
      container.className = "prototype-viewport-container " + (mode === "desktop" ? "" : mode);
    });
  });
}

// Setup Tab Navigation
function setupTabNavigation() {
  const navItems = document.querySelectorAll(".nav-item[data-tab]");
  navItems.forEach(item => {
    item.addEventListener("click", () => {
      showTab(item.dataset.tab);
    });
  });

  // Mobile menu button
  const mobileBtn = document.getElementById("mobileMenuBtn");
  const sidebar = document.getElementById("appSidebar");
  if (mobileBtn && sidebar) {
    mobileBtn.addEventListener("click", () => {
      sidebar.classList.toggle("mobile-open");
    });
  }
}

function showTab(tabId) {
  // Update nav item active states
  document.querySelectorAll(".nav-item[data-tab]").forEach(item => {
    if (item.dataset.tab === tabId) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });

  // Update panels
  document.querySelectorAll(".panel").forEach(panel => {
    if (panel.id === `panel-${tabId}`) {
      panel.classList.add("active");
    } else {
      panel.classList.remove("active");
    }
  });

  // Close mobile sidebar if open
  const sidebar = document.getElementById("appSidebar");
  if (sidebar) sidebar.classList.remove("mobile-open");

  window.location.hash = tabId;
}

// Setup Theme
function setupTheme() {
  const themeBtn = document.getElementById("themeToggleBtn");
  const html = document.documentElement;

  // Read saved or default to dark
  currentTheme = localStorage.getItem("winhelm_proto_theme") || "dark";
  html.setAttribute("data-theme", currentTheme);
  updateThemeIcon();

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      currentTheme = currentTheme === "dark" ? "light" : "dark";
      html.setAttribute("data-theme", currentTheme);
      localStorage.setItem("winhelm_proto_theme", currentTheme);
      updateThemeIcon();
    });
  }
}

function updateThemeIcon() {
  const btn = document.getElementById("themeToggleBtn");
  if (!btn) return;
  btn.innerHTML = currentTheme === "dark" 
    ? `<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0zm0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13zm8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5zM3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8zm10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0zm-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0zm9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707zM4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708z"/></svg>`
    : `<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/></svg>`;
}

// Setup Language Toggle
function setupLanguageToggle() {
  const langBtn = document.getElementById("langToggleBtn");
  if (!langBtn) return;

  langBtn.addEventListener("click", () => {
    currentLocale = currentLocale === "en" ? "th" : "en";
    langBtn.textContent = currentLocale === "en" ? "EN" : "ไทย";
    renderLocaleText();
  });
}

function renderLocaleText() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });
  // Re-render current state to apply localized labels
  if (currentState) renderState(currentState);
}

// Apply Selected Mock State
function applyState(stateId) {
  const state = PROTOTYPE_MOCK_STATES[stateId];
  if (!state) return;

  currentState = JSON.parse(JSON.stringify(state)); // deep clone
  renderState(currentState);

  // Update dropdown value
  const select = document.getElementById("stateSelect");
  if (select && select.value !== stateId) {
    select.value = stateId;
  }

  // Update state description banner
  const descEl = document.getElementById("reviewerStateDesc");
  if (descEl) descEl.textContent = state.description;

  // If state is narrow_viewport, switch viewport to mobile
  if (stateId === "narrow_viewport") {
    const mobileBtn = document.querySelector('.viewport-btn[data-viewport="mobile"]');
    if (mobileBtn) mobileBtn.click();
    showTab("approvals");
  }
}

// Render Complete State to DOM
function renderState(state) {
  // 1. Header System Status Pill
  const statusPill = document.getElementById("headerStatusPill");
  if (statusPill) {
    statusPill.className = "header-status-pill " + (
      state.systemStatus === "Ready" ? "status-ready" :
      state.systemStatus === "Needs Attention" ? "status-attention" : "status-offline"
    );
    statusPill.innerHTML = `<span class="status-dot"></span> <span>${state.systemStatus}</span>`;
  }

  // 2. Admin Pill
  const adminBtn = document.getElementById("adminPillBtn");
  if (adminBtn) {
    if (state.adminLocked) {
      adminBtn.className = "admin-pill-btn";
      adminBtn.innerHTML = `<span>🔒</span> <span>${t("adminLocked")}</span>`;
    } else {
      adminBtn.className = "admin-pill-btn unlocked";
      const mins = Math.floor((state.adminSessionExpiresInSeconds || 900) / 60);
      adminBtn.innerHTML = `<span>🔓</span> <span>${t("adminUnlocked")} (${mins}m)</span>`;
    }
  }

  // 3. Urgent Attention Banner on Home
  const attentionBanner = document.getElementById("homeAttentionBanner");
  if (attentionBanner) {
    if (state.pendingApprovals.length > 0) {
      attentionBanner.style.display = "flex";
      attentionBanner.className = "banner banner-warning";
      attentionBanner.innerHTML = `
        <div class="banner-content">
          <span style="font-size:18px;">⚠️</span>
          <div>
            <strong>Action Required:</strong> ${state.pendingApprovals.length} pending tool execution requires your authorization.
            <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">
              Client: <code>${state.pendingApprovals[0].clientName}</code> · Tool: <code>${state.pendingApprovals[0].tool}</code>
            </div>
          </div>
        </div>
        <button class="banner-btn" onclick="showTab('approvals')">Review in Inbox</button>
      `;
    } else if (state.warning) {
      attentionBanner.style.display = "flex";
      attentionBanner.className = "banner " + (state.warning.type === "security" ? "banner-danger" : "banner-warning");
      attentionBanner.innerHTML = `
        <div class="banner-content">
          <span style="font-size:18px;">${state.warning.type === "security" ? "🛑" : "⚠️"}</span>
          <div>
            <strong>${state.warning.title}</strong>
            <div style="font-size:12px; margin-top:2px;">${state.warning.message}</div>
          </div>
        </div>
        ${state.warning.actionText ? `<button class="banner-btn" onclick="handleWarningAction('${state.warning.actionTarget}')">${state.warning.actionText}</button>` : ""}
      `;
    } else {
      attentionBanner.style.display = "none";
    }
  }

  // 4. Update 4 Core Posture Tiles on Home
  const tileApprovals = document.getElementById("homeTileApprovals");
  if (tileApprovals) {
    const count = state.pendingApprovals.length;
    tileApprovals.innerHTML = `
      <div class="card-header">
        <span class="card-label">Approvals Inbox</span>
        <span class="status-pill ${count > 0 ? 'status-attention' : 'status-ready'}">
          <span class="status-dot"></span> ${count} Pending
        </span>
      </div>
      <div class="card-value">${count} Action${count === 1 ? '' : 's'}</div>
      <div class="card-desc">${count > 0 ? 'Tool executions waiting for your approval' : 'All actions authorized. Inbox clean.'}</div>
      <a href="javascript:void(0)" onclick="showTab('approvals')" class="card-action-link">Open Inbox →</a>
    `;
  }

  const tileAccess = document.getElementById("homeTileAccess");
  if (tileAccess) {
    const profileLabel = state.profile.toUpperCase();
    const modeLabel = state.approvalMode.toUpperCase();
    tileAccess.innerHTML = `
      <div class="card-header">
        <span class="card-label">Access Posture</span>
        <span class="status-pill status-neutral">${profileLabel}</span>
      </div>
      <div class="card-value">${profileLabel} Profile</div>
      <div class="card-desc">Policy: <strong>${modeLabel} Prompting</strong><br><span style="font-size:11px; color:var(--text-muted);">Trusted never bypasses profile floors.</span></div>
      <a href="javascript:void(0)" onclick="showTab('access')" class="card-action-link">Review Security Policy →</a>
    `;
  }

  const tileRemote = document.getElementById("homeTileRemote");
  if (tileRemote) {
    const isOff = state.remoteAccess === "off";
    tileRemote.innerHTML = `
      <div class="card-header">
        <span class="card-label">Remote Access</span>
        <span class="status-pill ${isOff ? 'status-ready' : 'status-attention'}">
          <span class="status-dot"></span> ${isOff ? 'OFF (Local Only)' : 'ON (Public Ingress)'}
        </span>
      </div>
      <div class="card-value">${isOff ? 'Local Only' : 'Ingress Active'}</div>
      <div class="card-desc">${state.remoteAccessDetail}</div>
      <a href="javascript:void(0)" onclick="showTab('connections')" class="card-action-link">Configure Ingress →</a>
    `;
  }

  const tileClients = document.getElementById("homeTileClients");
  if (tileClients) {
    const activeClients = state.clients.filter(c => c.status === "connected");
    tileClients.innerHTML = `
      <div class="card-header">
        <span class="card-label">Client Ecosystem</span>
        <span class="status-pill status-ready">${activeClients.length} Live</span>
      </div>
      <div class="card-value">${activeClients.length} Connected</div>
      <div class="card-desc">
        ${state.clients.map(c => `<span style="display:inline-block; margin-right:8px; font-size:11px;">● ${c.name}</span>`).join('')}
      </div>
      <a href="javascript:void(0)" onclick="showTab('connections')" class="card-action-link">Manage Clients →</a>
    `;
  }

  // 5. Update Approvals Nav Badge
  const badge = document.getElementById("navApprovalsBadge");
  if (badge) {
    const count = state.pendingApprovals.length;
    badge.textContent = count;
    badge.style.display = count > 0 ? "inline-block" : "none";
  }

  // 6. Render Approvals Inbox Panel
  renderApprovalsPanel(state);

  // 7. Render Connections Panel
  renderConnectionsPanel(state);

  // 8. Render Access & Security Panel
  renderAccessPanel(state);

  // 9. Render Activity Panel
  renderActivityPanel();

  // 10. Render Advanced Diagnostics Panel
  renderAdvancedPanel(state);
}

// Render Approvals Panel
function renderApprovalsPanel(state) {
  const container = document.getElementById("approvalsQueue");
  if (!container) return;

  if (state.pendingApprovals.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding:var(--space-8); color:var(--text-muted);">
        <div style="font-size:32px; margin-bottom:var(--space-2);">✓</div>
        <div style="font-size:var(--text-md); font-weight:600; color:var(--text-primary);">No Pending Approvals</div>
        <div style="font-size:var(--text-xs); margin-top:4px;">When AI clients request sensitive or mutating actions, they will appear here for your review.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = state.pendingApprovals.map(job => {
    return `
      <div class="approval-card ${job.riskLevel === 'High' ? 'high-risk' : ''}" id="card_${job.id}">
        <div class="approval-header">
          <div class="approval-meta-left">
            <span class="risk-tag ${job.riskLevel}">${job.riskLevel} Risk</span>
            <strong style="color:var(--text-primary); font-size:var(--text-md);">${job.tool}</strong>
            <span style="color:var(--text-muted); font-size:var(--text-xs);">#${job.id}</span>
          </div>
          <div class="expiry-pill" id="expiry_${job.id}">
            ⏱ Expires in <span class="countdown-timer">${formatTime(job.expiresInSeconds)}</span>
          </div>
        </div>

        <div class="approval-details-grid">
          <div class="detail-label">Client / Caller:</div>
          <div class="detail-value"><strong>${job.clientName}</strong> ${job.clientPid ? `(PID ${job.clientPid})` : ''}</div>

          <div class="detail-label">Risk Rationale:</div>
          <div class="detail-value" style="color:var(--status-attention-text);">${job.riskReason}</div>

          <div class="detail-label">Action Target:</div>
          <div class="detail-value"><code>${escapeHtml(job.target)}</code></div>

          <div class="detail-label">Working Directory:</div>
          <div class="detail-value"><code>${escapeHtml(job.workingDirectory)}</code></div>
        </div>

        ${job.requiresConfirmation ? `
          <div class="mandatory-confirm-box">
            <label for="input_confirm_${job.id}">⚠️ Mandatory Safety Confirmation Required</label>
            <div style="margin-bottom:8px; color:var(--text-secondary);">This action can significantly alter files or execution state. Type <code>confirm</code> below to authorize:</div>
            <input type="text" class="mandatory-confirm-input" id="input_confirm_${job.id}" placeholder="Type 'confirm' here" autocomplete="off" />
            <div id="confirm_err_${job.id}" style="color:var(--status-offline-text); font-size:11px; margin-top:4px; display:none;">Please type 'confirm' exactly.</div>
          </div>
        ` : ''}

        <div style="margin-bottom:var(--space-4);">
          <button class="btn-secondary" style="font-size:12px; padding:4px 10px;" onclick="togglePayloadDrawer('${job.id}')">
            ▼ View Sanitized Technical Arguments (JSON)
          </button>
          <div class="payload-drawer" id="payload_${job.id}" style="display:none;">
${escapeHtml(JSON.stringify(job.argumentsPayload, null, 2))}
          </div>
        </div>

        <div class="approval-actions">
          <button class="btn-approve" onclick="handleApprove('${job.id}')">✓ ${t('btnApprove')}</button>
          <button class="btn-deny" onclick="handleDeny('${job.id}')">✕ ${t('btnDeny')}</button>
        </div>
      </div>
    `;
  }).join('');

  startApprovalCountdown(state.pendingApprovals);
}

function togglePayloadDrawer(jobId) {
  const el = document.getElementById(`payload_${jobId}`);
  if (el) el.style.display = el.style.display === "none" ? "block" : "none";
}

function handleApprove(jobId) {
  const job = currentState.pendingApprovals.find(j => j.id === jobId);
  if (!job) return;

  if (job.requiresConfirmation) {
    const input = document.getElementById(`input_confirm_${jobId}`);
    const err = document.getElementById(`confirm_err_${jobId}`);
    if (!input || input.value.trim().toLowerCase() !== "confirm") {
      if (err) err.style.display = "block";
      if (input) input.focus();
      return;
    }
  }

  // Remove from state
  currentState.pendingApprovals = currentState.pendingApprovals.filter(j => j.id !== jobId);
  
  // Log to activity
  MOCK_ACTIVITY_STREAM.unshift({
    id: "act_" + Date.now(),
    time: new Date().toLocaleTimeString(),
    category: "approvals",
    actor: "Owner",
    action: "approved",
    target: `${job.tool} #${job.id}`,
    status: "approved",
    detail: `Authorized via Web Dashboard: ${job.target}`
  });

  // Re-render
  renderState(currentState);
  showToast(`Action #${jobId} Approved Successfully!`);
}

function handleDeny(jobId) {
  const job = currentState.pendingApprovals.find(j => j.id === jobId);
  if (!job) return;

  currentState.pendingApprovals = currentState.pendingApprovals.filter(j => j.id !== jobId);

  MOCK_ACTIVITY_STREAM.unshift({
    id: "act_" + Date.now(),
    time: new Date().toLocaleTimeString(),
    category: "approvals",
    actor: "Owner",
    action: "denied",
    target: `${job.tool} #${job.id}`,
    status: "denied",
    detail: `Denied by Owner via Web Dashboard`
  });

  renderState(currentState);
  showToast(`Action #${jobId} Denied and Terminated.`);
}

function startApprovalCountdown(jobs) {
  if (approvalCountdownInterval) clearInterval(approvalCountdownInterval);
  approvalCountdownInterval = setInterval(() => {
    jobs.forEach(job => {
      if (job.expiresInSeconds > 0) {
        job.expiresInSeconds--;
        const el = document.getElementById(`expiry_${job.id}`);
        if (el) {
          el.innerHTML = `⏱ Expires in <span class="countdown-timer">${formatTime(job.expiresInSeconds)}</span>`;
        }
      }
    });
  }, 1000);
}

// Render Connections Panel
function renderConnectionsPanel(state) {
  const container = document.getElementById("connectionsClientGrid");
  if (!container) return;

  container.innerHTML = state.clients.map(client => {
    const isConn = client.status === "connected";
    const isNeedsAttn = client.status === "needs_attention";
    return `
      <div class="card">
        <div class="card-header">
          <strong style="color:var(--text-primary); font-size:var(--text-md);">${client.name}</strong>
          <span class="status-pill ${isConn ? 'status-ready' : isNeedsAttn ? 'status-attention' : 'status-neutral'}">
            <span class="status-dot"></span> ${client.status.replace('_', ' ').toUpperCase()}
          </span>
        </div>
        <div class="card-desc">
          Transport: <code>${client.transport}</code><br>
          ${client.pid ? `Host PID: <code>${client.pid}</code> · Uptime: ${client.uptime}` : 'No active process detected.'}
          ${client.error ? `<div style="color:var(--status-attention-text); margin-top:4px;">⚠️ ${client.error}</div>` : ''}
        </div>
        <div>
          <button class="btn-secondary" style="font-size:12px; padding:4px 10px;" onclick="handleClientAction('${client.id}')">
            ${isNeedsAttn ? 'Repair Configuration' : isConn ? 'Inspect Session' : 'Setup Client'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Remote Access status banner
  const remoteBanner = document.getElementById("connectionsRemoteStatus");
  if (remoteBanner) {
    const isOff = state.remoteAccess === "off";
    remoteBanner.className = "banner " + (isOff ? "banner-info" : "banner-warning");
    remoteBanner.innerHTML = `
      <div class="banner-content">
        <span style="font-size:18px;">${isOff ? "🔒" : "🌐"}</span>
        <div>
          <strong>${isOff ? t("remoteOff") : t("remoteOn")}</strong>
          <div style="font-size:12px; margin-top:2px;">
            ${isOff ? 'WinHelm is bound to local loopback (127.0.0.1). Local AI clients can connect without any network exposure.' : state.remoteAccessDetail}
          </div>
        </div>
      </div>
      <button class="banner-btn" onclick="toggleRemoteAccess()">
        ${isOff ? 'Enable Remote Ingress' : 'Disable Remote Ingress'}
      </button>
    `;
  }
}

// Render Access & Security Panel
function renderAccessPanel(state) {
  // Profiles
  const profileContainer = document.getElementById("profileCardsContainer");
  if (profileContainer) {
    const profiles = [
      { id: "safe", name: "Safe Profile", desc: "Read-only file access, codebase search, and system telemetry. Disallows file writes, deletions, or command execution." },
      { id: "balanced", name: "Balanced Profile (Default)", desc: "Standard developer capabilities. Sandboxed file editing within allowed folders. Requires confirmation for terminal commands." },
      { id: "power", name: "Power Profile", desc: "Full operating system control. Direct terminal commands and elevated file operations with host user permissions." }
    ];

    profileContainer.innerHTML = profiles.map(p => `
      <div class="policy-axis-card ${state.profile === p.id ? 'selected' : ''}" onclick="selectProfile('${p.id}')">
        <input type="radio" name="profile_opt" class="policy-radio" ${state.profile === p.id ? 'checked' : ''} />
        <div class="policy-axis-text">
          <strong>${p.name}</strong>
          <span>${p.desc}</span>
        </div>
      </div>
    `).join('');
  }

  // Approval Modes
  const approvalContainer = document.getElementById("approvalModeContainer");
  if (approvalContainer) {
    const modes = [
      { id: "manual", name: "Manual Prompting", desc: "WinHelm prompts for human approval on every single mutating or sensitive tool execution." },
      { id: "smart", name: "Smart Prompting (Recommended)", desc: "Prompts only on high-risk actions, actions crossing allowed folder boundaries, or irreversible changes." },
      { id: "trusted", name: "Trusted Prompting", desc: "Skips routine prompts for actions strictly within designated allowed folders. Never bypasses profile floors." }
    ];

    approvalContainer.innerHTML = modes.map(m => `
      <div class="policy-axis-card ${state.approvalMode === m.id ? 'selected' : ''}" onclick="selectApprovalMode('${m.id}')">
        <input type="radio" name="approval_opt" class="policy-radio" ${state.approvalMode === m.id ? 'checked' : ''} />
        <div class="policy-axis-text">
          <strong>${m.name}</strong>
          <span>${m.desc}</span>
        </div>
      </div>
    `).join('');
  }
}

// Render Activity Panel
function renderActivityPanel() {
  const container = document.getElementById("activityTimelineList");
  if (!container) return;

  container.innerHTML = MOCK_ACTIVITY_STREAM.map(item => `
    <div class="timeline-item">
      <div class="timeline-item-left">
        <span class="timeline-time">${item.time}</span>
        <span class="timeline-badge">${item.category.toUpperCase()}</span>
        <strong style="color:var(--text-primary);">${item.action}</strong>
        <span style="color:var(--text-secondary); font-size:var(--text-xs);">by ${item.actor}</span>
      </div>
      <div style="font-size:var(--text-xs); color:var(--text-muted);">
        ${item.detail}
      </div>
    </div>
  `).join('');
}

// Render Advanced Panel
function renderAdvancedPanel(state) {
  const portBadge = document.getElementById("advPortModeBadge");
  if (portBadge) {
    portBadge.textContent = state.portMode === "automatic" ? "Automatic (Tranche A Dynamic)" : "Fixed (Legacy Config)";
    portBadge.className = "status-pill " + (state.portMode === "automatic" ? "status-ready" : "status-neutral");
  }

  const endpointTable = document.getElementById("advEndpointsBody");
  if (endpointTable) {
    endpointTable.innerHTML = `
      <tr>
        <td><strong>Core MCP Loopback Endpoint</strong></td>
        <td><code>http://127.0.0.1:${state.ports.core}</code></td>
        <td><span class="status-pill status-ready"><span class="status-dot"></span> Active</span></td>
      </tr>
      <tr>
        <td><strong>R7 Subprocess Internal Target</strong></td>
        <td><code>http://127.0.0.1:${state.ports.r7}</code></td>
        <td><span class="status-pill status-ready"><span class="status-dot"></span> Bound</span></td>
      </tr>
      <tr>
        <td><strong>R8 Local Ingress Listener</strong></td>
        <td><code>http://127.0.0.1:${state.ports.r8}</code></td>
        <td><span class="status-pill status-ready"><span class="status-dot"></span> Bound</span></td>
      </tr>
      <tr>
        <td><strong>Port Allocation Generation ID</strong></td>
        <td><code>${state.ports.generation}</code></td>
        <td>Retries: ${state.ports.retries}</td>
      </tr>
    `;
  }
}

// Setup Modals
function setupModals() {
  // Admin Unlock Modal
  const adminBtn = document.getElementById("adminPillBtn");
  const adminModal = document.getElementById("adminUnlockModal");
  const adminClose = document.getElementById("closeAdminModal");
  const adminSubmit = document.getElementById("submitAdminCode");

  if (adminBtn && adminModal) {
    adminBtn.addEventListener("click", () => {
      if (!currentState.adminLocked) {
        // Toggle lock
        currentState.adminLocked = true;
        renderState(currentState);
        showToast("Admin session locked.");
      } else {
        adminModal.classList.add("open");
        const input = document.getElementById("modalAdminCodeInput");
        if (input) {
          input.value = "";
          input.focus();
        }
      }
    });
  }

  if (adminClose && adminModal) {
    adminClose.addEventListener("click", () => adminModal.classList.remove("open"));
  }

  if (adminSubmit && adminModal) {
    adminSubmit.addEventListener("click", () => {
      const input = document.getElementById("modalAdminCodeInput");
      if (input && input.value.trim().length > 0) {
        currentState.adminLocked = false;
        currentState.adminSessionExpiresInSeconds = 900;
        adminModal.classList.remove("open");
        renderState(currentState);
        showToast("Admin privileges unlocked for 15 minutes.");
      }
    });
  }

  // Setup Assistant Modal
  const setupBtn = document.getElementById("navSetupBtn");
  const setupModal = document.getElementById("setupAssistantModal");
  const setupClose = document.getElementById("closeSetupModal");

  if (setupBtn && setupModal) {
    setupBtn.addEventListener("click", () => setupModal.classList.add("open"));
  }
  if (setupClose && setupModal) {
    setupClose.addEventListener("click", () => setupModal.classList.remove("open"));
  }
}

// Helper: Format seconds to MM:SS
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Helper: Escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Toast Notification
function showToast(msg) {
  let toast = document.getElementById("protoToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "protoToast";
    toast.style.position = "fixed";
    toast.style.bottom = "24px";
    toast.style.right = "24px";
    toast.style.background = "#1e293b";
    toast.style.color = "#f8fafc";
    toast.style.padding = "10px 18px";
    toast.style.borderRadius = "8px";
    toast.style.border = "1px solid #475569";
    toast.style.boxShadow = "0 8px 24px rgba(0,0,0,0.4)";
    toast.style.fontSize = "13px";
    toast.style.fontWeight = "600";
    toast.style.zIndex = "9999";
    toast.style.transition = "opacity 0.2s ease";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = "1";
  setTimeout(() => { toast.style.opacity = "0"; }, 3000);
}

function handleWarningAction(target) {
  if (target === "set_balanced_profile") {
    currentState.profile = "balanced";
    currentState.terminalMode = "ask";
    currentState.warning = null;
    renderState(currentState);
    showToast("Profile reverted to Balanced.");
  } else if (target === "repair_client_cursor") {
    const cursor = currentState.clients.find(c => c.id === "cursor");
    if (cursor) {
      cursor.status = "connected";
      cursor.error = null;
      cursor.transport = "Streamable HTTP";
    }
    currentState.warning = null;
    renderState(currentState);
    showToast("Cursor configuration upgraded to v2 successfully.");
  }
}

function toggleRemoteAccess() {
  currentState.remoteAccess = currentState.remoteAccess === "off" ? "on" : "off";
  currentState.remoteAccessDetail = currentState.remoteAccess === "on" 
    ? "Tailscale HTTPS tunnel active: https://winhelm-node.tailnet.ts.net/mcp"
    : "Listening on 127.0.0.1 loopback only. Zero public exposure.";
  renderState(currentState);
  showToast(`Remote Access switched to ${currentState.remoteAccess.toUpperCase()}`);
}
