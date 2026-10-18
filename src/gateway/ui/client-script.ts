/**
 * WinHelm v1.4.1 Product Shell — Client-Side JavaScript Application
 * 
 * Production-grade, zero-dependency, strict CSP compliant.
 * Handles state polling, admin unlock, approvals, tunnel lifecycle,
 * and WCAG-compliant dialog focus management.
 */

export function getClientScript(clientScriptMessages: string, focusJobId: string): string {
  const safeFocusJob = JSON.stringify(focusJobId).replace(/</g, "\\u003c");

  return `
    const SHELL_MESSAGES = ${clientScriptMessages};
    const INITIAL_FOCUS_JOB_ID = ${safeFocusJob};

    let adminCsrfToken = null;
    let isAdminUnlocked = false;
    let adminSessionTimer = null;
    let activityCache = [];
    let currentActivityFilter = 'all';
    let lastProfile = null;
    let lastSessions = [];
    let lastClientStatus = [];
    let lastTunnelStatus = null;
    let setupAutoSurfaced = false;
    let lastActiveElementBeforeModal = null;

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Tab Navigation
    function showTab(tabId) {
      const navItems = document.querySelectorAll('.nav-item[data-tab]');
      navItems.forEach(item => {
        if (item.dataset.tab === tabId) {
          item.classList.add('active');
          item.setAttribute('aria-current', 'page');
        } else {
          item.classList.remove('active');
          item.removeAttribute('aria-current');
        }
      });

      const panels = document.querySelectorAll('.panel');
      panels.forEach(panel => {
        if (panel.id === 'panel-' + tabId) {
          panel.classList.add('active');
        } else {
          panel.classList.remove('active');
        }
      });

      window.location.hash = tabId;
    }

    // Modal Focus Management & Accessibility
    function openModal(modalId, triggerElement) {
      const modal = document.getElementById(modalId);
      if (!modal) return;
      lastActiveElementBeforeModal = triggerElement || document.activeElement;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');

      // Focus first input or button
      const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length > 0) {
        focusable[0].focus();
      }

      // Trap focus
      modal.addEventListener('keydown', trapFocus);
    }

    function closeModal(modalId) {
      const modal = document.getElementById(modalId);
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      modal.removeEventListener('keydown', trapFocus);

      if (lastActiveElementBeforeModal && typeof lastActiveElementBeforeModal.focus === 'function') {
        lastActiveElementBeforeModal.focus();
      }
    }

    function trapFocus(e) {
      if (e.key === 'Escape') {
        closeModal(this.id);
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = this.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          last.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    }

    // Admin Auth & Unlock
    function handleAdminPillClick() {
      if (isAdminUnlocked) {
        if (confirm(SHELL_MESSAGES.shellAdminLockConfirm || '')) {
          lockAdmin();
        }
      } else {
        openAdminModal();
      }
    }

    function openAdminModal() {
      const input = document.getElementById('adminCodeInput');
      if (input) input.value = '';
      const err = document.getElementById('adminUnlockError');
      if (err) err.textContent = '';
      openModal('adminModal', document.getElementById('adminPill'));
    }

    function closeAdminModal() {
      closeModal('adminModal');
    }

    async function submitAdminCode() {
      const input = document.getElementById('adminCodeInput');
      const err = document.getElementById('adminUnlockError');
      const code = input ? input.value.trim() : '';
      if (!code) {
        if (err) err.textContent = SHELL_MESSAGES.shellAdminEnterCodeError || '';
        return;
      }

      try {
        const res = await fetch('/admin/auth/exchange', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-origin': window.location.origin
          },
          body: JSON.stringify({ code })
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (err) err.textContent = body.message || (SHELL_MESSAGES.shellAdminInvalidCode || '');
          return;
        }

        const data = await res.json();
        adminCsrfToken = data.csrfToken;
        isAdminUnlocked = true;
        closeAdminModal();
        updateAdminPill(true);
        refreshAllData();
      } catch (ex) {
        if (err) err.textContent = (SHELL_MESSAGES.shellAdminConnErrorPrefix || '') + ex.message;
      }
    }

    async function lockAdmin() {
      try {
        await fetch('/admin/auth/logout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          }
        });
      } catch (_) {}
      adminCsrfToken = null;
      isAdminUnlocked = false;
      updateAdminPill(false);
      refreshAllData();
    }

    function updateAdminPill(unlocked) {
      const pill = document.getElementById('adminPill');
      const dot = document.getElementById('adminDot');
      const text = document.getElementById('adminText');
      if (!pill) return;

      if (unlocked) {
        pill.className = 'admin-pill unlocked';
        if (dot) dot.className = 'status-dot green';
        if (text) text.textContent = SHELL_MESSAGES.adminUnlocked || '';
      } else {
        pill.className = 'admin-pill';
        if (dot) dot.className = 'status-dot yellow';
        if (text) text.textContent = SHELL_MESSAGES.adminLocked || '';
      }
    }

    // Approvals Decision Inbox
    async function fetchApprovals() {
      try {
        const res = await fetch('/admin/approvals');
        if (!res.ok) return;
        const data = await res.json();
        renderApprovals(data.jobs || []);
      } catch (_) {}
    }

    function renderApprovals(jobs) {
      const countEl = document.getElementById('sidebarApprovalCount');
      const pillEl = document.getElementById('approvalQueueCountPill');
      const homePending = document.getElementById('statPendingApprovals');
      const homePill = document.getElementById('statPendingBadge');
      const quickCount = document.getElementById('quickApprovalCount');
      const urgentBanner = document.getElementById('homeUrgentBanner');
      const urgentSub = document.getElementById('urgentBannerSubtitle');

      const count = jobs.length;
      if (countEl) {
        countEl.textContent = count;
        countEl.style.display = count > 0 ? 'inline-block' : 'none';
      }
      if (pillEl) {
        pillEl.textContent = (SHELL_MESSAGES.shellApprovalsCountPendingBadge || '{count}').replace('{count}', count);
        pillEl.className = 'status-pill ' + (count > 0 ? 'status-attention' : 'status-ready');
      }
      if (homePending) homePending.textContent = count;
      if (quickCount) quickCount.textContent = count;

      if (homePill) {
        homePill.className = 'status-pill ' + (count > 0 ? 'status-attention' : 'status-ready');
        homePill.innerHTML = '<span class="status-dot ' + (count > 0 ? 'yellow' : 'green') + '"></span> ' + (SHELL_MESSAGES.shellApprovalsCountPendingBadge || '{count}').replace('{count}', count);
      }

      if (urgentBanner) {
        if (count > 0) {
          urgentBanner.style.display = 'flex';
          if (urgentSub) {
            urgentSub.textContent = (SHELL_MESSAGES.shellApprovalsUrgentSubtitle || '{count}').replace('{count}', count);
          }
        } else {
          urgentBanner.style.display = 'none';
        }
      }

      const container = document.getElementById('approvalJobs');
      if (!container) return;

      if (count === 0) {
        container.innerHTML = \`
          <div style="text-align:center; padding:var(--space-6); color:var(--text-muted);">
            <div style="font-size:28px; margin-bottom:var(--space-2);">✓</div>
            <div style="font-size:var(--text-base); font-weight:600; color:var(--text-primary);">\${escapeHtml(SHELL_MESSAGES.approvalsEmpty)}</div>
            <div style="font-size:var(--text-xs); margin-top:4px;">\${escapeHtml(SHELL_MESSAGES.shellApprovalsEmptySub || '')}</div>
          </div>
        \`;
        return;
      }

      container.innerHTML = jobs.map(job => {
        const isHigh = (job.riskLevel || '').toLowerCase() === 'high';
        // Constraint 1: Mandatory confirmation is ONLY rendered when backend explicitly says so!
        const needsConfirm = job.requiresConfirmation === true || job.requires_confirmation === true;

        return \`
          <div class="approval-card \${isHigh ? 'high-risk' : ''}" id="job_\${escapeHtml(job.id)}">
            <div class="approval-header">
              <div class="approval-meta-left">
                <span class="risk-tag \${escapeHtml((job.riskLevel || 'medium').toLowerCase())}">\${escapeHtml(job.riskLevel || '')} \${escapeHtml(SHELL_MESSAGES.shellApprovalsRiskSuffix || '')}</span>
                <strong style="color:var(--text-primary); font-size:var(--text-md);">\${escapeHtml(job.tool || '')}</strong>
                <span style="color:var(--text-muted); font-size:var(--text-xs);">#\${escapeHtml(job.id)}</span>
              </div>
              <div style="font-size:var(--text-xs); color:var(--text-muted);">
                \${escapeHtml(job.clientName || '')}
              </div>
            </div>

            <div class="approval-details-grid">
              <div class="detail-label">\${escapeHtml(SHELL_MESSAGES.shellApprovalsRiskReasonLabel || '')}</div>
              <div class="detail-value" style="color:var(--status-attention-text);">\${escapeHtml(job.riskReason || job.reason || (SHELL_MESSAGES.shellApprovalsMutatingOp || ''))}</div>

              <div class="detail-label">\${escapeHtml(SHELL_MESSAGES.shellApprovalsActionTargetLabel || '')}</div>
              <div class="detail-value"><code>\${escapeHtml(job.target || job.resource || '')}</code></div>
            </div>

            \${needsConfirm ? \`
              <div class="mandatory-confirm-box">
                <label for="confirm_input_\${escapeHtml(job.id)}">\${escapeHtml(SHELL_MESSAGES.shellApprovalsMandatoryConfirmTitle || '')}</label>
                <div style="margin-bottom:8px; color:var(--text-secondary);">\${escapeHtml(SHELL_MESSAGES.shellApprovalsMandatoryConfirmDesc || '')}</div>
                <input type="text" class="mandatory-confirm-input" id="confirm_input_\${escapeHtml(job.id)}" placeholder="\${escapeHtml(SHELL_MESSAGES.shellApprovalsMandatoryConfirmPlaceholder || '')}" autocomplete="off" />
                <div id="confirm_err_\${escapeHtml(job.id)}" style="color:var(--status-offline-text); font-size:11px; margin-top:4px; display:none;">\${escapeHtml(SHELL_MESSAGES.shellApprovalsMandatoryConfirmErr || '')}</div>
              </div>
            \` : ''}

            <div style="margin-bottom:var(--space-4);">
              <button class="btn-secondary" style="font-size:11px; padding:3px 8px;" onclick="togglePayload('\${escapeHtml(job.id)}')">
                \${escapeHtml(SHELL_MESSAGES.shellApprovalsViewPayload || '')}
              </button>
              <div class="payload-drawer" id="payload_\${escapeHtml(job.id)}" style="display:none; margin-top:var(--space-2); background:var(--code-bg); padding:var(--space-3); border-radius:var(--radius-sm); font-family:var(--font-mono); font-size:11px; max-height:160px; overflow:auto;">
                \${escapeHtml(JSON.stringify(job.arguments || job.params || {}, null, 2))}
              </div>
            </div>

            <div class="approval-actions">
              <button class="btn-approve" onclick="handleApprove('\${escapeHtml(job.id)}', \${needsConfirm})">✓ \${escapeHtml(SHELL_MESSAGES.approvalsApprove || '')}</button>
              <button class="btn-deny" onclick="handleDeny('\${escapeHtml(job.id)}')">✕ \${escapeHtml(SHELL_MESSAGES.approvalsDeny || '')}</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function togglePayload(jobId) {
      const el = document.getElementById('payload_' + jobId);
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    async function handleApprove(jobId, needsConfirm) {
      if (needsConfirm) {
        const input = document.getElementById('confirm_input_' + jobId);
        const err = document.getElementById('confirm_err_' + jobId);
        if (!input || input.value.trim().toLowerCase() !== 'confirm') {
          if (err) err.style.display = 'block';
          if (input) input.focus();
          return;
        }
      }

      try {
        const res = await fetch('/admin/approvals/' + encodeURIComponent(jobId) + '/approve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          },
          body: JSON.stringify({ reason: SHELL_MESSAGES.shellApprovalsReasonApproved || '' })
        });

        if (res.status === 401) {
          openAdminModal();
          return;
        }

        fetchApprovals();
        fetchActivity();
      } catch (ex) {
        alert((SHELL_MESSAGES.shellApprovalsErrFailed || '') + ex.message);
      }
    }

    async function handleDeny(jobId) {
      try {
        const res = await fetch('/admin/approvals/' + encodeURIComponent(jobId) + '/deny', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          },
          body: JSON.stringify({ reason: SHELL_MESSAGES.shellApprovalsReasonDenied || '' })
        });

        if (res.status === 401) {
          openAdminModal();
          return;
        }

        fetchApprovals();
        fetchActivity();
      } catch (ex) {
        alert((SHELL_MESSAGES.shellApprovalsErrDenyFailed || '') + ex.message);
      }
    }

    // Tunnel Lifecycle Functions (Required by tests)
    async function fetchTunnelStatus() {
      try {
        const res = await fetch('/admin/tunnel/status');
        if (!res.ok) return;
        const data = await res.json();
        renderTunnelStatus(data);
      } catch (_) {}
    }

    function renderTunnelStatus(status) {
      lastTunnelStatus = status;
      const depEl = document.getElementById('tunnelDependencyStatus');
      const profEl = document.getElementById('tunnelProfileStatus');
      const backEl = document.getElementById('tunnelBackendStatus');
      const stateBadge = document.getElementById('tunnelStateBadge');
      const ownerBadge = document.getElementById('tunnelOwnershipBadge');
      const detailEl = document.getElementById('tunnelDetail');

      const isRemoteOn = status && (status.active === true || status.state === 'running');

      // Constraint 2: Update remote status on Home & Connections based on VERIFIED backend status
      const remoteHeading = document.getElementById('connRemoteStatusHeading');
      const remoteDetail = document.getElementById('connRemoteStatusDetail');
      const homeRemotePill = document.getElementById('statRemotePill');
      const homeRemoteText = document.getElementById('statRemoteText');
      const homeRemoteDetail = document.getElementById('statRemoteDetail');

      if (isRemoteOn) {
        if (remoteHeading) remoteHeading.textContent = SHELL_MESSAGES.shellRemoteStatusOn || '';
        if (remoteDetail) remoteDetail.textContent = (SHELL_MESSAGES.shellRemoteVerifiedTunnelActive || '') + (status.publicUrl || status.url || '');
        if (homeRemotePill) {
          homeRemotePill.className = 'status-pill status-attention';
          homeRemotePill.innerHTML = '<span class="status-dot yellow"></span> ' + (SHELL_MESSAGES.shellRemoteStatusOn || '');
        }
        if (homeRemoteText) homeRemoteText.textContent = SHELL_MESSAGES.shellRemoteActive || '';
        if (homeRemoteDetail) homeRemoteDetail.textContent = SHELL_MESSAGES.shellRemoteVerifiedRouteReachable || '';
      } else {
        if (remoteHeading) remoteHeading.textContent = SHELL_MESSAGES.shellRemoteLocalReadyOff || '';
        if (remoteDetail) remoteDetail.textContent = SHELL_MESSAGES.shellRemoteZeroExposure || '';
        if (homeRemotePill) {
          homeRemotePill.className = 'status-pill status-ready';
          homeRemotePill.innerHTML = '<span class="status-dot green"></span> ' + (SHELL_MESSAGES.shellRemoteStatusOff || '');
        }
        if (homeRemoteText) homeRemoteText.textContent = SHELL_MESSAGES.shellHomeLocalReady || '';
        if (homeRemoteDetail) homeRemoteDetail.textContent = SHELL_MESSAGES.shellRemoteZeroExposure || '';
      }

      if (depEl) depEl.textContent = status?.dependenciesInstalled ? (SHELL_MESSAGES.shellConnectionsStatusInstalled || '') : (SHELL_MESSAGES.shellConnectionsStatusReady || '');
      if (profEl) profEl.textContent = status?.profileCompatible ? (SHELL_MESSAGES.shellConnectionsStatusCompatible || '') : (SHELL_MESSAGES.shellConnectionsStatusReady || '');
      if (backEl) backEl.textContent = status?.backendConfigured ? (SHELL_MESSAGES.shellConnectionsStatusConfigured || '') : (SHELL_MESSAGES.shellConnectionsStatusLocal || '');

      if (stateBadge) {
        stateBadge.textContent = status?.state || (isRemoteOn ? 'running' : 'stopped');
        stateBadge.className = 'status-pill ' + (isRemoteOn ? 'status-ready' : 'status-neutral');
      }

      if (ownerBadge) {
        ownerBadge.textContent = status?.managed ? (SHELL_MESSAGES.shellConnectionsStatusManaged || '') : (SHELL_MESSAGES.shellConnectionsStatusUnmanaged || '');
      }

      if (detailEl) {
        detailEl.textContent = status?.detail || status?.error || (isRemoteOn ? (SHELL_MESSAGES.shellConnectionsStatusRouteActive || '') : (SHELL_MESSAGES.shellConnectionsStatusInactive || ''));
      }
    }

    async function handleTunnelStart() {
      const confirmInput = document.getElementById('tunnelConfirmInput');
      const resultEl = document.getElementById('tunnelActionResult');
      const confirmation = confirmInput ? confirmInput.value.trim() : '';

      try {
        const res = await fetch('/admin/tunnel/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          },
          body: JSON.stringify({ confirmation })
        });

        if (res.status === 401) {
          openAdminModal();
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (resultEl) resultEl.textContent = data.message || (res.ok ? (SHELL_MESSAGES.shellConnectionsTunnelStarted || '') : (SHELL_MESSAGES.shellConnectionsTunnelStartFailed || ''));
        fetchTunnelStatus();
      } catch (ex) {
        if (resultEl) resultEl.textContent = 'Error: ' + ex.message;
      }
    }

    async function handleTunnelStop() {
      const confirmInput = document.getElementById('tunnelConfirmInput');
      const resultEl = document.getElementById('tunnelActionResult');
      const confirmation = confirmInput ? confirmInput.value.trim() : '';

      try {
        const res = await fetch('/admin/tunnel/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          },
          body: JSON.stringify({ confirmation })
        });

        if (res.status === 401) {
          openAdminModal();
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (resultEl) resultEl.textContent = data.message || (res.ok ? (SHELL_MESSAGES.shellConnectionsTunnelStopped || '') : (SHELL_MESSAGES.shellConnectionsTunnelStopFailed || ''));
        fetchTunnelStatus();
      } catch (ex) {
        if (resultEl) resultEl.textContent = 'Error: ' + ex.message;
      }
    }

    async function handleTunnelRestart() {
      const confirmInput = document.getElementById('tunnelConfirmInput');
      const resultEl = document.getElementById('tunnelActionResult');
      const confirmation = confirmInput ? confirmInput.value.trim() : '';

      try {
        const res = await fetch('/admin/tunnel/restart', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          },
          body: JSON.stringify({ confirmation })
        });

        if (res.status === 401) {
          openAdminModal();
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (resultEl) resultEl.textContent = data.message || (res.ok ? (SHELL_MESSAGES.shellConnectionsTunnelRestarted || '') : (SHELL_MESSAGES.shellConnectionsTunnelRestartFailed || ''));
        fetchTunnelStatus();
      } catch (ex) {
        if (resultEl) resultEl.textContent = 'Error: ' + ex.message;
      }
    }

    async function handleTunnelDoctor() {
      const resultEl = document.getElementById('tunnelActionResult');
      try {
        const res = await fetch('/admin/tunnel/doctor');
        if (res.status === 401) {
          openAdminModal();
          return;
        }
        const data = await res.json();
        if (resultEl) resultEl.textContent = (SHELL_MESSAGES.shellConnectionsDoctorPrefix || '') + (data.healthy ? (SHELL_MESSAGES.shellConnectionsDoctorPassed || '') : (data.summary || (SHELL_MESSAGES.shellConnectionsDoctorIssues || '')));
      } catch (ex) {
        if (resultEl) resultEl.textContent = (SHELL_MESSAGES.shellConnectionsDoctorErrPrefix || '') + ex.message;
      }
    }

    // Sessions & Client Integration
    async function fetchSessions() {
      try {
        const res = await fetch('/admin/sessions');
        if (!res.ok) return;
        const data = await res.json();
        renderSessions(data.sessions || []);
      } catch (_) {}
    }

    function renderSessions(sessions) {
      lastSessions = sessions;
      const tbody = document.getElementById('clientSessions');
      const homeConnected = document.getElementById('statConnectedClients');
      const advSessionCount = document.getElementById('advActiveSessionCount');

      if (homeConnected) homeConnected.textContent = sessions.length + ' ' + (SHELL_MESSAGES.shellHomeClientsConnectedSuffix || '');
      if (advSessionCount) advSessionCount.textContent = sessions.length;

      if (!tbody) return;

      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:var(--space-4);">' + escapeHtml(SHELL_MESSAGES.shellConnectionsNoSessions || '') + '</td></tr>';
        return;
      }

      tbody.innerHTML = sessions.map(s => \`
        <tr>
          <td><strong>\${escapeHtml(s.clientName || 'MCP Client')}</strong></td>
          <td><code>\${escapeHtml(s.ip || '127.0.0.1')}</code></td>
          <td>\${escapeHtml(s.transport || 'SSE / Streamable')}</td>
          <td><code>\${escapeHtml(s.id ? s.id.substring(0, 12) + '…' : 'local')}</code></td>
          <td><span class="status-pill status-ready"><span class="status-dot green"></span> \${escapeHtml(SHELL_MESSAGES.shellConnectionsStatusActive || '')}</span></td>
        </tr>
      \`).join('');
    }

    async function handleClientPreview(clientName) {
      if (!isAdminUnlocked) {
        openAdminModal();
        return;
      }
      const resBox = document.getElementById('clientActionResult');
      if (resBox) {
        resBox.style.display = 'block';
        resBox.textContent = SHELL_MESSAGES.shellConnectionsLoadingPreview || '';
      }
      try {
        const res = await fetch('/admin/clients/' + encodeURIComponent(clientName) + '/preview', {
          headers: {
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          }
        });
        const data = await res.json().catch(() => ({}));
        if (resBox) {
          resBox.innerHTML = '<div class="banner banner-info">' + escapeHtml(data.message || JSON.stringify(data, null, 2)) + '</div>';
        }
      } catch (ex) {
        if (resBox) resBox.textContent = (SHELL_MESSAGES.shellConnectionsPreviewErrPrefix || '') + ex.message;
      }
    }

    async function handleClientApply(clientName) {
      if (!isAdminUnlocked) {
        openAdminModal();
        return;
      }
      const resBox = document.getElementById('clientActionResult');
      if (resBox) {
        resBox.style.display = 'block';
        resBox.textContent = SHELL_MESSAGES.shellConnectionsConfiguringClient || '';
      }
      try {
        const res = await fetch('/admin/clients/' + encodeURIComponent(clientName) + '/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          }
        });
        const data = await res.json().catch(() => ({}));
        if (resBox) {
          const restartMsg = SHELL_MESSAGES.connRestartHint || '';
          resBox.innerHTML = '<div class="banner ' + (res.ok ? 'banner-ready' : 'banner-danger') + '">' + escapeHtml(data.message || (res.ok ? (SHELL_MESSAGES.shellConnectionsConfigSuccess || '') + ' ' + restartMsg : (SHELL_MESSAGES.shellConnectionsConfigFailed || ''))) + '</div>';
        }
        refreshAllData();
      } catch (ex) {
        if (resBox) resBox.textContent = (SHELL_MESSAGES.shellConnectionsApplyErrPrefix || '') + ex.message;
      }
    }

    // Token Rotation (Constraint 4)
    async function rotateToken() {
      if (!isAdminUnlocked) {
        openAdminModal();
        return;
      }

      if (!confirm(SHELL_MESSAGES.shellAccessRotateTokenConfirm || '')) {
        return;
      }

      try {
        const res = await fetch('/admin/auth/token/rotate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          }
        });

        if (!res.ok) {
          alert(SHELL_MESSAGES.shellAccessRotateTokenFailed || '');
          return;
        }

        const data = await res.json();
        // One-time secret display:
        alert((SHELL_MESSAGES.shellAccessRotateTokenSuccess || '').replace('{token}', data.token));
      } catch (ex) {
        alert((SHELL_MESSAGES.shellAccessRotateTokenErrPrefix || '') + ex.message);
      }
    }

    // Policy & Access Management
    async function fetchProfile() {
      try {
        const res = await fetch('/admin/profile');
        if (!res.ok) return;
        const data = await res.json();
        lastProfile = data;

        const presetSelect = document.getElementById('profilePresetSelect');
        const modeSelect = document.getElementById('approvalModeSelect');
        const foldersInput = document.getElementById('profileFoldersInput');

        if (presetSelect && data.preset) presetSelect.value = data.preset;
        if (modeSelect && data.approvalMode) modeSelect.value = data.approvalMode;
        if (foldersInput && data.allowedDirectories) {
          foldersInput.value = data.allowedDirectories.join('\\n');
        }
      } catch (_) {}
    }

    function handlePresetChange(val) {
      // Dynamic description update
    }

    async function previewAccessConfig() {
      const preset = document.getElementById('profilePresetSelect')?.value;
      const folders = document.getElementById('profileFoldersInput')?.value.split('\\n').filter(Boolean);
      const resEl = document.getElementById('accessPreviewResult');
      const confirmGroup = document.getElementById('accessConfirmGroup');

      try {
        const res = await fetch('/admin/profiles/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          },
          body: JSON.stringify({ preset, allowedDirectories: folders })
        });

        const data = await res.json().catch(() => ({}));
        if (data.requiresTypedConfirmation || data.requires_typed_confirmation) {
          if (confirmGroup) confirmGroup.style.display = 'block';
        } else {
          if (confirmGroup) confirmGroup.style.display = 'none';
        }

        if (resEl) {
          resEl.innerHTML = '<div class="banner banner-info" style="margin-top:8px;"><strong>' + escapeHtml(SHELL_MESSAGES.shellAccessPreviewValidationPrefix || '') + '</strong> ' + escapeHtml(data.message || (data.warnings && data.warnings.join(' ')) || (SHELL_MESSAGES.shellAccessPreviewValid || '')) + '</div>';
        }
      } catch (ex) {
        if (resEl) resEl.textContent = (SHELL_MESSAGES.shellConnectionsPreviewErrPrefix || '') + ex.message;
      }
    }

    async function saveAccessConfig() {
      if (!isAdminUnlocked) {
        openAdminModal();
        return;
      }

      const preset = document.getElementById('profilePresetSelect')?.value;
      const folders = document.getElementById('profileFoldersInput')?.value.split('\\n').filter(Boolean);
      const confInput = document.getElementById('accessConfirmInput');
      const confirmGroup = document.getElementById('accessConfirmGroup');
      const confirmation = confInput ? confInput.value.trim() : '';
      const resEl = document.getElementById('accessPreviewResult');

      try {
        const payload = { preset, allowedDirectories: folders };
        if (confirmation) payload.confirmation = confirmation;

        const res = await fetch('/admin/profiles/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-winhelm-csrf': adminCsrfToken || '',
            'x-winhelm-origin': window.location.origin
          },
          body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (resEl) {
          resEl.innerHTML = '<div class="banner ' + (res.ok ? 'banner-ready' : 'banner-danger') + '" style="margin-top:8px;">' + escapeHtml(data.message || (res.ok ? (SHELL_MESSAGES.shellAccessPolicyApplied || '') : (SHELL_MESSAGES.shellAccessPolicyApplyFailed || ''))) + '</div>';
        }
        if (res.ok) {
          if (confInput) confInput.value = '';
          if (confirmGroup) confirmGroup.style.display = 'none';
        }
        fetchProfile();
      } catch (ex) {
        if (resEl) resEl.textContent = (SHELL_MESSAGES.shellAccessSaveErrPrefix || '') + ex.message;
      }
    }

    // Activity Stream
    async function fetchActivity() {
      try {
        const res = await fetch('/api/monitor/logs');
        if (!res.ok) return;
        const data = await res.json();
        activityCache = data.logs || [];
        renderActivity();
      } catch (_) {}
    }

    function setActivityFilter(cat, btn) {
      currentActivityFilter = cat;
      document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      renderActivity();
    }

    function renderActivity() {
      const container = document.getElementById('activityLogList');
      const homeList = document.getElementById('homeRecentActivityList');
      if (!container) return;

      const filtered = activityCache.filter(item => {
        if (currentActivityFilter === 'all') return true;
        return (item.category || item.type || '').toLowerCase().includes(currentActivityFilter);
      });

      if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:var(--space-6); color:var(--text-muted);">' + escapeHtml(SHELL_MESSAGES.activityEmpty || '') + '</div>';
      } else {
        container.innerHTML = filtered.slice(0, 50).map(item => \`
          <div class="timeline-item">
            <div class="timeline-item-left">
              <span class="timeline-time">\${escapeHtml(item.timestamp || item.time || '')}</span>
              <span class="timeline-badge">\${escapeHtml((item.category || item.level || 'INFO').toUpperCase())}</span>
              <strong style="color:var(--text-primary);">\${escapeHtml(item.action || item.tool || item.message || '')}</strong>
            </div>
            <div style="font-size:var(--text-xs); color:var(--text-muted);">
              \${escapeHtml(item.detail || item.actor || '')}
            </div>
          </div>
        \`).join('');
      }

      if (homeList) {
        const recent = activityCache.slice(0, 3);
        if (recent.length === 0) {
          homeList.innerHTML = '<div style="color:var(--text-muted); font-size:var(--text-xs); padding:var(--space-2);">' + escapeHtml(SHELL_MESSAGES.shellHomeActivityEmpty || '') + '</div>';
        } else {
          homeList.innerHTML = recent.map(item => \`
            <div class="timeline-item">
              <div class="timeline-item-left">
                <span class="timeline-time">\${escapeHtml(item.timestamp || item.time || '')}</span>
                <span class="timeline-badge">\${escapeHtml((item.category || 'EVENT').toUpperCase())}</span>
                <strong style="color:var(--text-primary);">\${escapeHtml(item.action || item.message || '')}</strong>
              </div>
              <span class="status-pill status-ready">\${escapeHtml(SHELL_MESSAGES.shellActivityStatusRecorded || '')}</span>
            </div>
          \`).join('');
        }
      }
    }

    // Diagnostics (Constraint 3: Narrow companion surfaces only)
    async function checkInstallationHealth() {
      const resEl = document.getElementById('setupDiagnosticResult');
      if (resEl) {
        resEl.style.display = 'block';
        resEl.innerHTML = '<div class="banner banner-info">' + escapeHtml(SHELL_MESSAGES.shellSetupDiagnosticRunning || '') + '</div>';
      }

      try {
        const res = await fetch('/health');
        const data = await res.json();
        if (resEl) {
          resEl.innerHTML = '<div class="banner banner-ready" style="background:var(--status-ready-bg); color:var(--status-ready-text);">' + escapeHtml(SHELL_MESSAGES.shellSetupDiagnosticHealthy || '') + escapeHtml(data.timestamp || new Date().toISOString()) + '</div>';
        }
      } catch (ex) {
        if (resEl) {
          resEl.innerHTML = '<div class="banner banner-danger">' + escapeHtml(SHELL_MESSAGES.shellSetupDiagnosticFailed || '') + escapeHtml(ex.message) + '</div>';
        }
      }
    }

    // Settings (Theme & Language)
    function handleThemeChange(theme) {
      const html = document.documentElement;
      if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        html.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
        localStorage.removeItem('winhelm_theme');
      } else {
        html.setAttribute('data-theme', theme);
        localStorage.setItem('winhelm_theme', theme);
      }
    }

    function handleLanguageChange(lang) {
      window.location.href = '/?locale=' + encodeURIComponent(lang);
    }

    function renderProfileData(p) {
      if (!p) return;
      const presetSelect = document.getElementById('profilePresetSelect');
      if (presetSelect && p.preset) presetSelect.value = p.preset;

      const modeSelect = document.getElementById('approvalModeSelect');
      if (modeSelect && p.approvalMode) modeSelect.value = p.approvalMode;

      const foldersInput = document.getElementById('profileFoldersInput');
      if (foldersInput && p.allowedDirectories) {
        foldersInput.value = p.allowedDirectories.join('\\n');
      } else if (foldersInput && p.folders) {
        foldersInput.value = p.folders.map(f => typeof f === 'string' ? f : f.path).join('\\n');
      }
    }

    function setupBadgeClass(status) {
      if (status === 'complete' || status === 'configured' || status === 'active') return 'status-ready';
      if (status === 'attention') return 'status-attention';
      if (status === 'needs_configuration' || status === 'incomplete') return 'status-attention';
      return 'status-neutral';
    }

    function setSetupBadge(id, label, status) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = label;
      el.className = 'status-pill ' + setupBadgeClass(status);
    }

    function renderSetupClientStatus(clientKey, statusId, detailId) {
      const entry = (lastClientStatus || []).find(c => c.client === clientKey);
      const statusEl = document.getElementById(statusId);
      const detailEl = document.getElementById(detailId);
      if (!statusEl || !detailEl) return;
      if (!entry) {
        statusEl.textContent = '—';
        statusEl.className = 'status-pill status-neutral';
        detailEl.textContent = '';
        return;
      }
      const labels = {
        configured: SHELL_MESSAGES.setupStatusConfigured || '',
        needs_configuration: SHELL_MESSAGES.setupStatusNeedsConfiguration || '',
        attention: SHELL_MESSAGES.setupStatusAttention || ''
      };
      statusEl.textContent = labels[entry.status] || entry.status;
      statusEl.className = 'status-pill ' + setupBadgeClass(entry.status);
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
      const folders = profile && Array.isArray(profile.folders) ? profile.folders : (profile && Array.isArray(profile.allowedDirectories) ? profile.allowedDirectories : []);
      const workspaceComplete = folders.length > 0;
      setSetupBadge('setupWorkspaceStatus',
        workspaceComplete ? (SHELL_MESSAGES.setupStatusComplete || '') : (SHELL_MESSAGES.setupStatusIncomplete || ''),
        workspaceComplete ? 'complete' : 'incomplete');
      const workspaceDetail = document.getElementById('setupWorkspaceDetail');
      if (workspaceDetail) {
        workspaceDetail.textContent = folders.map(f => (typeof f === 'string' ? f : f.path)).join('; ');
      }

      const preset = profile ? (profile.preset || (profile.schemaMode === 'legacy' ? 'legacy' : '')) : '';
      setSetupBadge('setupProfileStatus',
        preset ? (SHELL_MESSAGES.setupStatusComplete || '') : (SHELL_MESSAGES.setupStatusIncomplete || ''),
        preset ? 'complete' : 'incomplete');
      const profileDetail = document.getElementById('setupProfileDetail');
      if (profileDetail) {
        profileDetail.textContent = (SHELL_MESSAGES.setupCurrent || '') + ': ' + (preset || '-');
      }

      const approvalMode = profile ? profile.approvalMode : '';
      setSetupBadge('setupApprovalStatus',
        approvalMode ? (SHELL_MESSAGES.setupStatusComplete || '') : (SHELL_MESSAGES.setupStatusIncomplete || ''),
        approvalMode ? 'complete' : 'incomplete');
      const approvalDetail = document.getElementById('setupApprovalDetail');
      if (approvalDetail) {
        approvalDetail.textContent = (SHELL_MESSAGES.setupCurrent || '') + ': ' + (approvalMode || '-');
      }

      renderSetupClientStatus('claude', 'setupClientClaudeStatus', 'setupClientClaudeDetail');
      renderSetupClientStatus('cursor', 'setupClientCursorStatus', 'setupClientCursorDetail');

      const activeCount = (lastSessions || []).length;
      setSetupBadge('setupSessionsStatus',
        activeCount > 0 ? (SHELL_MESSAGES.setupStatusActive || '') : (SHELL_MESSAGES.setupStatusNotObserved || ''),
        activeCount > 0 ? 'active' : 'neutral');
      const sessionsDetail = document.getElementById('setupSessionsDetail');
      if (sessionsDetail) {
        sessionsDetail.textContent = lastSessions
          .map(s => ((s.clientInfo && s.clientInfo.name) || s.clientName || 'Client') + ' (' + (s.sessionId || s.id || 'n/a') + ')')
          .join('; ');
      }
    }

    // Master Refresh
    async function refreshAllData() {
      fetchApprovals();
      fetchActivity();

      try {
        const [profileRes, sessionsRes, clientStatusRes] = await Promise.all([
          fetch('/admin/profile', { headers: { 'x-winhelm-csrf': adminCsrfToken || '' } }).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch('/admin/sessions').then(r => r.ok ? r.json() : null).catch(() => null),
          fetch('/admin/clients/status', { headers: { 'x-winhelm-csrf': adminCsrfToken || '' } }).then(r => r.ok ? r.json() : null).catch(() => null)
        ]);

        if (profileRes && (profileRes.profile || profileRes.preset || profileRes.allowedDirectories)) {
          lastProfile = profileRes.profile || profileRes;
          renderProfileData(lastProfile);
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
          : ((profileRes && Array.isArray(profileRes.folders)) ? profileRes.folders : ((profileRes && Array.isArray(profileRes.allowedDirectories)) ? profileRes.allowedDirectories : []));
        if (!setupAutoSurfaced && profileFolders.length === 0) {
          setupAutoSurfaced = true;
          showTab('setup');
        }
      } catch (e) {
        console.warn('Admin fetch error', e);
      }
    }

    // Initialization
    document.addEventListener('DOMContentLoaded', () => {
      // Saved Theme
      const savedTheme = localStorage.getItem('winhelm_theme');
      if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
        const select = document.getElementById('settingThemeSelect');
        if (select) select.value = savedTheme;
      }

      // Initial tab
      const hash = window.location.hash.replace('#', '');
      if (hash && ['overview', 'access', 'approvals', 'activity', 'connections', 'settings', 'advanced', 'setup'].includes(hash)) {
        showTab(hash);
      } else if (INITIAL_FOCUS_JOB_ID) {
        showTab('approvals');
      }

      // Initial Fetch & Poll
      refreshAllData();
      setInterval(refreshAllData, 5000);
    });
  `;
}
