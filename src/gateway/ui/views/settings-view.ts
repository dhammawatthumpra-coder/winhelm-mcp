/**
 * WinHelm v1.4.1 Product Shell — Settings View
 * 
 * Ordinary low-risk user preferences (language, theme, notifications).
 * Dangerous options are strictly excluded.
 */

import { escapeHtml, type ShellRenderContext } from "../common.js";

export function renderSettingsView(ctx: ShellRenderContext): string {
  const { messages, locale } = ctx;

  return `
    <section id="panel-settings" class="panel" aria-labelledby="heading-settings">
      <div class="panel-header">
        <h1 id="heading-settings" class="panel-title">${escapeHtml(messages.settingsTitle)}</h1>
        <p class="panel-desc">${escapeHtml(messages.shellSettingsDesc)}</p>
      </div>

      <div class="card-grid-2">
        <!-- LOCALIZATION PREFERENCES -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellSettingsAriaLocale)}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.settingsLanguage)}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
            ${escapeHtml(messages.shellSettingsLangDesc)}
          </div>

          <div style="margin-bottom:var(--space-3);">
            <select id="settingLanguageSelect" style="width:100%; padding:8px;" onchange="handleLanguageChange(this.value)">
              <option value="en" ${locale === "en" ? "selected" : ""}>English (US)</option>
              <option value="th" ${locale === "th" ? "selected" : ""}>ภาษาไทย (Thai)</option>
            </select>
          </div>
        </div>

        <!-- THEME PREFERENCES -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellSettingsAriaTheme)}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.shellSettingsThemeTitle)}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
            ${escapeHtml(messages.shellSettingsThemeDesc)}
          </div>

          <div style="margin-bottom:var(--space-3);">
            <select id="settingThemeSelect" style="width:100%; padding:8px;" onchange="handleThemeChange(this.value)">
              <option value="system">${escapeHtml(messages.shellSettingsThemeSystem)}</option>
              <option value="dark">${escapeHtml(messages.shellSettingsThemeDark)}</option>
              <option value="light">${escapeHtml(messages.shellSettingsThemeLight)}</option>
            </select>
          </div>
        </div>

        <!-- NOTIFICATION PREFERENCES -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellSettingsAriaNotif)}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.shellSettingsNotifTitle)}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
            ${escapeHtml(messages.shellSettingsNotifDesc)}
          </div>

          <div style="display:flex; flex-direction:column; gap:var(--space-2);">
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
              <input type="checkbox" id="settingToastToggle" checked />
              <span>${escapeHtml(messages.shellSettingsNotifToast)}</span>
            </label>
          </div>
        </div>

        <!-- SECURITY SAFETY FLOOR NOTICE -->
        <div class="card" role="region" aria-label="${escapeHtml(messages.shellSettingsAriaFloor)}">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.shellSettingsContainmentTitle)}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary);">
            ${escapeHtml(messages.shellSettingsDangerNote)}
          </div>
        </div>
      </div>
    </section>
  `;
}
