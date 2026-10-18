/**
 * WinHelm v1.4.1 Product Shell — Access & Security View
 * 
 * Comprehensible dual-axis policy governance:
 * Axis 1: Capability Profile (What is permitted)
 * Axis 2: Approval Mode (When human prompts are required)
 * 
 * Also houses privileged Security Credentials & MCP Access Token Rotation.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderAccessView(ctx: ShellRenderContext): string {
  const { messages } = ctx;

  return `
    <section id="panel-access" class="panel" aria-labelledby="heading-access">
      <div class="panel-header">
        <h1 id="heading-access" class="panel-title">${escapeHtml(messages.accessTitle)}</h1>
        <p class="panel-desc">${escapeHtml(messages.shellAccessDesc)}</p>
      </div>

      <!-- DUAL-AXIS GUIDANCE NOTE -->
      <div class="banner banner-info" role="region" aria-label="${escapeHtml(messages.shellAccessAriaGuidance)}">
        <div class="banner-content">
          <span aria-hidden="true" style="font-size:18px;">ℹ️</span>
          <div>
            <strong>${escapeHtml(messages.shellAccessModelTitle)}</strong>
            <div style="font-size:12px; margin-top:2px;">
              ${escapeHtml(messages.shellAccessModelDesc)}
            </div>
          </div>
        </div>
      </div>

      <!-- DUAL-AXIS SELECTION GRID -->
      <div class="card-grid-2">
        <!-- AXIS 1: CAPABILITY PROFILE -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellAccessAriaAxis1)}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.shellAccessAxis1Title)}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
            ${escapeHtml(messages.shellAccessAxis1Desc)}
          </div>

          <div style="margin-bottom:var(--space-3);">
            <label for="profilePresetSelect" style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">${escapeHtml(messages.shellAccessProfilePreset)}</label>
            <select id="profilePresetSelect" style="width:100%; padding:8px;" onchange="handlePresetChange(this.value)">
              <option value="safe">${escapeHtml(messages.shellAccessPresetSafe)}</option>
              <option value="balanced" selected>${escapeHtml(messages.shellAccessPresetBalanced)}</option>
              <option value="power">${escapeHtml(messages.shellAccessPresetPower)}</option>
            </select>
          </div>

          <div id="profilePresetDetails" style="font-size:12px; color:var(--text-muted); background:var(--bg-subtle); padding:var(--space-3); border-radius:var(--radius-sm); margin-bottom:var(--space-3);">
            <strong>${escapeHtml(messages.shellAccessPowerNoticeTitle)}</strong> ${escapeHtml(messages.shellAccessPowerNoticeBody)}
          </div>

          <div style="font-size:11px; color:var(--text-muted);">
            🛡️ <em>${escapeHtml(messages.shellAccessTerminalSafetyHint)}</em>
          </div>
        </div>

        <!-- AXIS 2: APPROVAL MODE -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellAccessAriaAxis2)}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.shellAccessAxis2Title)}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
            ${escapeHtml(messages.shellAccessAxis2Desc)}
          </div>

          <div style="margin-bottom:var(--space-3);">
            <label for="approvalModeSelect" style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">${escapeHtml(messages.shellAccessLabelApprovalMode)}</label>
            <select id="approvalModeSelect" style="width:100%; padding:8px;">
              <option value="manual">${escapeHtml(messages.shellAccessModeManual)}</option>
              <option value="smart" selected>${escapeHtml(messages.shellAccessModeSmart)}</option>
              <option value="trusted">${escapeHtml(messages.shellAccessModeTrusted)}</option>
            </select>
          </div>

          <div style="font-size:12px; color:var(--text-muted); background:var(--bg-subtle); padding:var(--space-3); border-radius:var(--radius-sm);">
            <strong>${escapeHtml(messages.shellAccessTrustedConstraintTitle)}</strong> ${escapeHtml(messages.shellAccessTrustedConstraintBody)}
          </div>
        </div>
      </div>

      <!-- ALLOWED WORKSPACE DIRECTORIES -->
      <div class="card" style="margin-top:var(--space-4);" role="region" aria-label="${escapeHtml(messages.shellAccessAriaFolders)}">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.foldersTitle)}</span>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
          ${escapeHtml(messages.shellAccessFoldersDesc)}
        </div>

        <div style="margin-bottom:var(--space-3);">
          <label for="profileFoldersInput" style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">
            ${escapeHtml(messages.shellAccessFoldersLabel)}
          </label>
          <textarea id="profileFoldersInput" rows="4" style="width:100%; font-family:var(--font-mono); font-size:12px; padding:8px;" placeholder="D:\\mcp&#10;C:\\Users\\csuti\\Projects:ro"></textarea>
        </div>

        <div class="form-group" id="accessConfirmGroup" style="display:none; margin-bottom:var(--space-3);">
          <label class="form-label" for="accessConfirmInput" style="display:block; font-size:12px; font-weight:600; color:var(--status-attention-text); margin-bottom:4px;">${escapeHtml(messages.shellAccessConfirmRequired)}</label>
          <div class="form-desc" style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${escapeHtml(messages.confirmType)}</div>
          <input type="text" id="accessConfirmInput" class="mandatory-confirm-input" style="width:100%; max-width:320px;" placeholder="confirm">
        </div>

        <div style="display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap;">
          <button class="btn-secondary" onclick="previewAccessConfig()">${escapeHtml(messages.accessPreview)}</button>
          <button class="btn-primary" onclick="saveAccessConfig()">${escapeHtml(messages.accessSave)}</button>
        </div>

        <div id="accessPreviewResult" style="margin-top:var(--space-3); font-size:12px;"></div>
      </div>

      <!-- PRIVILEGED SECURITY CREDENTIALS (Constraint 4) -->
      <div class="card" style="margin-top:var(--space-5); border-left:4px solid var(--accent-primary);" role="region" aria-label="${escapeHtml(messages.shellAccessAriaCredentials)}">
        <div class="card-header">
          <span class="card-label">${escapeHtml(messages.shellAccessCredTitle)}</span>
          <span class="status-pill status-attention">${escapeHtml(messages.shellAccessCredPill)}</span>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
          ${escapeHtml(messages.shellAccessCredDesc)}
        </div>

        <div style="margin-bottom:var(--space-3);">
          <label style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">${escapeHtml(messages.shellAccessCredActiveLabel)}</label>
          <div style="display:flex; align-items:center; gap:var(--space-2);">
            <code style="background:var(--code-bg); padding:6px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); flex:1; font-family:var(--font-mono); font-size:12px;">
              ••••••••••••••••••••••••••••••••••••••••••••••••
            </code>
            <button class="btn-secondary" style="font-size:12px;" onclick="rotateToken()">
              🔑 ${escapeHtml(messages.tokenRotate)}
            </button>
          </div>
        </div>

        <div id="tokenRotationNotice" style="font-size:11px; color:var(--text-muted);">
          ⚠️ ${escapeHtml(messages.shellAccessCredAdminNote)}
        </div>
      </div>
    </section>
  `;
}
