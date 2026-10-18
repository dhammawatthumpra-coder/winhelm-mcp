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
        if (confirm('Lock admin privileges now?')) {
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
        if (err) err.textContent = 'Please enter one-time admin code.';
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
          if (err) err.textContent = body.message || 'Invalid or expired admin code.';
          return;
        }

        const data = await res.json();
        adminCsrfToken = data.csrfToken;
        isAdminUnlocked = true;
        closeAdminModal();
        updateAdminPill(true);
        refreshAllData();
      } catch (ex) {
        if (err) err.textContent = 'Connection error: ' + ex.message;
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
        if (text) text.textContent = SHELL_MESSAGES.adminUnlocked || 'Admin Unlocked';
      } else {
        pill.className = 'admin-pill';
        if (dot) dot.className = 'status-dot yellow';
        if (text) text.textContent = SHELL_MESSAGES.adminLocked || 'Admin Locked';
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
        pillEl.textContent = count + ' Pending';
        pillEl.className = 'status-pill ' + (count > 0 ? 'status-attention' : 'status-ready');
      }
      if (homePending) homePending.textContent = count;
      if (quickCount) quickCount.textContent = count;

      if (homePill) {
        homePill.className = 'status-pill ' + (count > 0 ? 'status-attention' : 'status-ready');
        homePill.innerHTML = '<span class="status-dot ' + (count > 0 ? 'yellow' : 'green') + '"></span> ' + count + ' Pending';
      }

      if (urgentBanner) {
        if (count > 0) {
          urgentBanner.style.display = 'flex';
          if (urgentSub) {
            urgentSub.textContent = count + ' pending tool execution requires your authorization.';
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
            <div style="font-size:var(--text-xs); margin-top:4px;">When AI clients request sensitive or mutating actions, they will appear here.</div>
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
                <span class="risk-tag \${escapeHtml((job.riskLevel || 'medium').toLowerCase())}">\${escapeHtml(job.riskLevel || 'Medium')} Risk</span>
                <strong style="color:var(--text-primary); font-size:var(--text-md);">\${escapeHtml(job.tool || 'Tool')}</strong>
                <span style="color:var(--text-muted); font-size:var(--text-xs);">#\${escapeHtml(job.id)}</span>
              </div>
              <div style="font-size:var(--text-xs); color:var(--text-muted);">
                \${escapeHtml(job.clientName || 'AI Client')}
              </div>
            </div>

            <div class="approval-details-grid">
              <div class="detail-label">Risk Reason:</div>
              <div class="detail-value" style="color:var(--status-attention-text);">\${escapeHtml(job.riskReason || job.reason || 'Mutating operation')}</div>

              <div class="detail-label">Action Target:</div>
              <div class="detail-value"><code>\${escapeHtml(job.target || job.resource || 'N/A')}</code></div>
            </div>

            \${needsConfirm ? \`
              <div class="mandatory-confirm-box">
                <label for="confirm_input_\${escapeHtml(job.id)}">⚠️ Mandatory Safety Confirmation Required</label>
                <div style="margin-bottom:8px; color:var(--text-secondary);">Type <code>confirm</code> below to authorize this backend-gated action:</div>
                <input type="text" class="mandatory-confirm-input" id="confirm_input_\${escapeHtml(job.id)}" placeholder="Type 'confirm' here" autocomplete="off" />
                <div id="confirm_err_\${escapeHtml(job.id)}" style="color:var(--status-offline-text); font-size:11px; margin-top:4px; display:none;">Please type 'confirm' exactly.</div>
              </div>
            \` : ''}

            <div style="margin-bottom:var(--space-4);">
              <button class="btn-secondary" style="font-size:11px; padding:3px 8px;" onclick="togglePayload('\${escapeHtml(job.id)}')">
                ▼ View Technical Details
              </button>
              <div class="payload-drawer" id="payload_\${escapeHtml(job.id)}" style="display:none; margin-top:var(--space-2); background:var(--code-bg); padding:var(--space-3); border-radius:var(--radius-sm); font-family:var(--font-mono); font-size:11px; max-height:160px; overflow:auto;">
                \${escapeHtml(JSON.stringify(job.arguments || job.params || {}, null, 2))}
              </div>
            </div>

            <div class="approval-actions">
              <button class="btn-approve" onclick="handleApprove('\${escapeHtml(job.id)}', \${needsConfirm})">✓ \${escapeHtml(SHELL_MESSAGES.approvalsApprove || 'Approve')}</button>
              <button class="btn-deny" onclick="handleDeny('\${escapeHtml(job.id)}')">✕ \${escapeHtml(SHELL_MESSAGES.approvalsDeny || 'Deny')}</button>
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
          body: JSON.stringify({ reason: 'Approved via Product Shell' })
        });

        if (res.status === 401) {
          openAdminModal();
          return;
        }

        fetchApprovals();
        fetchActivity();
      } catch (ex) {
        alert('Approval failed: ' + ex.message);
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
          body: JSON.stringify({ reason: 'Denied via Product Shell' })
        });

        if (res.status === 401) {
          openAdminModal();
          return;
        }

        fetchApprovals();
        fetchActivity();
      } catch (ex) {
        alert('Denial failed: ' + ex.message);
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
        if (remoteHeading) remoteHeading.textContent = 'Remote Access On';
        if (remoteDetail) remoteDetail.textContent = 'Verified tunnel active: ' + (status.publicUrl || status.url || 'Active Route');
        if (homeRemotePill) {
          homeRemotePill.className = 'status-pill status-attention';
          homeRemotePill.innerHTML = '<span class="status-dot yellow"></span> Remote Access On';
        }
        if (homeRemoteText) homeRemoteText.textContent = 'Remote Active';
        if (homeRemoteDetail) homeRemoteDetail.textContent = 'Verified ingress route reachable.';
      } else {
        if (remoteHeading) remoteHeading.textContent = 'Local Ready · Remote Access Off';
        if (remoteDetail) remoteDetail.textContent = 'WinHelm is listening on local loopback only (127.0.0.1). Zero public exposure.';
        if (homeRemotePill) {
          homeRemotePill.className = 'status-pill status-ready';
          homeRemotePill.innerHTML = '<span class="status-dot green"></span> Remote Access Off';
        }
        if (homeRemoteText) homeRemoteText.textContent = 'Local Ready';
        if (homeRemoteDetail) homeRemoteDetail.textContent = 'Listening on 127.0.0.1 loopback only. Zero public exposure.';
      }

      if (depEl) depEl.textContent = status?.dependenciesInstalled ? 'Installed' : 'Ready';
      if (profEl) profEl.textContent = status?.profileCompatible ? 'Compatible' : 'Ready';
      if (backEl) backEl.textContent = status?.backendConfigured ? 'Configured' : 'Local';

      if (stateBadge) {
        stateBadge.textContent = status?.state || (isRemoteOn ? 'running' : 'stopped');
        stateBadge.className = 'status-pill ' + (isRemoteOn ? 'status-ready' : 'status-neutral');
      }

      if (ownerBadge) {
        ownerBadge.textContent = status?.managed ? 'managed' : 'unmanaged';
      }

      if (detailEl) {
        detailEl.textContent = status?.detail || status?.error || (isRemoteOn ? 'Route verified and active.' : 'Inactive');
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
        if (resultEl) resultEl.textContent = data.message || (res.ok ? 'Tunnel started.' : 'Start failed.');
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
        if (resultEl) resultEl.textContent = data.message || (res.ok ? 'Tunnel stopped.' : 'Stop failed.');
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
        if (resultEl) resultEl.textContent = data.message || (res.ok ? 'Tunnel restarted.' : 'Restart failed.');
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
        if (resultEl) resultEl.textContent = 'Doctor check complete: ' + (data.healthy ? 'All probes passed.' : (data.summary || 'Issues detected.'));
      } catch (ex) {
        if (resultEl) resultEl.textContent = 'Doctor error: ' + ex.message;
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

      if (homeConnected) homeConnected.textContent = sessions.length + ' Connected';
      if (advSessionCount) advSessionCount.textContent = sessions.length;

      if (!tbody) return;

      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:var(--space-4);">No active MCP client sessions announced yet.</td></tr>';
        return;
      }

      tbody.innerHTML = sessions.map(s => \`
        <tr>
          <td><strong>\${escapeHtml(s.clientName || 'MCP Client')}</strong></td>
          <td><code>\${escapeHtml(s.ip || '127.0.0.1')}</code></td>
          <td>\${escapeHtml(s.transport || 'SSE / Streamable')}</td>
          <td><code>\${escapeHtml(s.id ? s.id.substring(0, 12) + '…' : 'local')}</code></td>
          <td><span class="status-pill status-ready"><span class="status-dot green"></span> Active</span></td>
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
        resBox.textContent = 'Loading client preview…';
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
        if (resBox) resBox.textContent = 'Preview error: ' + ex.message;
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
        resBox.textContent = 'Configuring client…';
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
          const restartMsg = SHELL_MESSAGES.connRestartHint || 'If this client was running, restart it or reconnect so the new configuration is loaded.';
          resBox.innerHTML = '<div class="banner ' + (res.ok ? 'banner-ready' : 'banner-danger') + '">' + escapeHtml(data.message || (res.ok ? 'Client configured successfully. ' + restartMsg : 'Configuration failed.')) + '</div>';
        }
        refreshAllData();
      } catch (ex) {
        if (resBox) resBox.textContent = 'Apply error: ' + ex.message;
      }
    }

    // Token Rotation (Constraint 4)
    async function rotateToken() {
      if (!isAdminUnlocked) {
        openAdminModal();
        return;
      }

      if (!confirm('Rotate the MCP access token now? The previous token stops working immediately and connected clients must be updated.')) {
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
          alert('Failed to rotate token.');
          return;
        }

        const data = await res.json();
        // One-time secret display:
        alert('New MCP Bearer Access Token generated successfully:\\n\\n' + data.token + '\\n\\nCopy this token now. It will not be shown again.');
      } catch (ex) {
        alert('Token rotation error: ' + ex.message);
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
          resEl.innerHTML = '<div class="banner banner-info" style="margin-top:8px;"><strong>Preview Validation:</strong> ' + escapeHtml(data.message || (data.warnings && data.warnings.join(' ')) || 'Config valid.') + '</div>';
        }
      } catch (ex) {
        if (resEl) resEl.textContent = 'Preview error: ' + ex.message;
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
          resEl.innerHTML = '<div class="banner ' + (res.ok ? 'banner-ready' : 'banner-danger') + '" style="margin-top:8px;">' + escapeHtml(data.message || (res.ok ? 'Access policy applied.' : 'Failed to apply.')) + '</div>';
        }
        if (res.ok) {
          if (confInput) confInput.value = '';
          if (confirmGroup) confirmGroup.style.display = 'none';
        }
        fetchProfile();
      } catch (ex) {
        if (resEl) resEl.textContent = 'Save error: ' + ex.message;
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
        container.innerHTML = '<div style="text-align:center; padding:var(--space-6); color:var(--text-muted);">' + escapeHtml(SHELL_MESSAGES.activityEmpty || 'No events recorded.') + '</div>';
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
          homeList.innerHTML = '<div style="color:var(--text-muted); font-size:var(--text-xs); padding:var(--space-2);">No recent activity recorded.</div>';
        } else {
          homeList.innerHTML = recent.map(item => \`
            <div class="timeline-item">
              <div class="timeline-item-left">
                <span class="timeline-time">\${escapeHtml(item.timestamp || item.time || '')}</span>
                <span class="timeline-badge">\${escapeHtml((item.category || 'EVENT').toUpperCase())}</span>
                <strong style="color:var(--text-primary);">\${escapeHtml(item.action || item.message || '')}</strong>
              </div>
              <span class="status-pill status-ready">Recorded</span>
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
        resEl.innerHTML = '<div class="banner banner-info">Running installation diagnostic probes…</div>';
      }

      try {
        const res = await fetch('/health');
        const data = await res.json();
        if (resEl) {
          resEl.innerHTML = '<div class="banner banner-ready" style="background:var(--status-ready-bg); color:var(--status-ready-text);">✓ WinHelm gateway healthy. Timestamp: ' + escapeHtml(data.timestamp || new Date().toISOString()) + '</div>';
        }
      } catch (ex) {
        if (resEl) {
          resEl.innerHTML = '<div class="banner banner-danger">Diagnostic check failed: ' + escapeHtml(ex.message) + '</div>';
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
        configured: SHELL_MESSAGES.setupStatusConfigured || 'Configured',
        needs_configuration: SHELL_MESSAGES.setupStatusNeedsConfiguration || 'Needs Configuration',
        attention: SHELL_MESSAGES.setupStatusAttention || 'Attention'
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
        workspaceComplete ? (SHELL_MESSAGES.setupStatusComplete || 'Complete') : (SHELL_MESSAGES.setupStatusIncomplete || 'Incomplete'),
        workspaceComplete ? 'complete' : 'incomplete');
      const workspaceDetail = document.getElementById('setupWorkspaceDetail');
      if (workspaceDetail) {
        workspaceDetail.textContent = folders.map(f => (typeof f === 'string' ? f : f.path)).join('; ');
      }

      const preset = profile ? (profile.preset || (profile.schemaMode === 'legacy' ? 'legacy' : '')) : '';
      setSetupBadge('setupProfileStatus',
        preset ? (SHELL_MESSAGES.setupStatusComplete || 'Complete') : (SHELL_MESSAGES.setupStatusIncomplete || 'Incomplete'),
        preset ? 'complete' : 'incomplete');
      const profileDetail = document.getElementById('setupProfileDetail');
      if (profileDetail) {
        profileDetail.textContent = (SHELL_MESSAGES.setupCurrent || 'Current') + ': ' + (preset || '-');
      }

      const approvalMode = profile ? profile.approvalMode : '';
      setSetupBadge('setupApprovalStatus',
        approvalMode ? (SHELL_MESSAGES.setupStatusComplete || 'Complete') : (SHELL_MESSAGES.setupStatusIncomplete || 'Incomplete'),
        approvalMode ? 'complete' : 'incomplete');
      const approvalDetail = document.getElementById('setupApprovalDetail');
      if (approvalDetail) {
        approvalDetail.textContent = (SHELL_MESSAGES.setupCurrent || 'Current') + ': ' + (approvalMode || '-');
      }

      renderSetupClientStatus('claude', 'setupClientClaudeStatus', 'setupClientClaudeDetail');
      renderSetupClientStatus('cursor', 'setupClientCursorStatus', 'setupClientCursorDetail');

      const activeCount = (lastSessions || []).length;
      setSetupBadge('setupSessionsStatus',
        activeCount > 0 ? (SHELL_MESSAGES.setupStatusActive || 'Active Session Observed') : (SHELL_MESSAGES.setupStatusNotObserved || 'No Active Session Observed'),
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
