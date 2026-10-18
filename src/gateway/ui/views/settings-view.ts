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
        <p class="panel-desc">Everyday application preferences and presentation options.</p>
      </div>

      <div class="card-grid-2">
        <!-- LOCALIZATION PREFERENCES -->
        <div class="card" role="region" aria-label="Localization Preferences">
          <div class="card-header">
            <span class="card-label">${escapeHtml(messages.settingsLanguage)}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
            Select interface language. Both English and Thai catalogs maintain 100% key parity.
          </div>

          <div style="margin-bottom:var(--space-3);">
            <select id="settingLanguageSelect" style="width:100%; padding:8px;" onchange="handleLanguageChange(this.value)">
              <option value="en" ${locale === "en" ? "selected" : ""}>English (US)</option>
              <option value="th" ${locale === "th" ? "selected" : ""}>ภาษาไทย (Thai)</option>
            </select>
          </div>
        </div>

        <!-- THEME PREFERENCES -->
        <div class="card" role="region" aria-label="Theme Preferences">
          <div class="card-header">
            <span class="card-label">Appearance & Theme</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
            Choose visual theme or follow operating system preferences.
          </div>

          <div style="margin-bottom:var(--space-3);">
            <select id="settingThemeSelect" style="width:100%; padding:8px;" onchange="handleThemeChange(this.value)">
              <option value="system">System Default (Auto)</option>
              <option value="dark">Dark Theme</option>
              <option value="light">Light Theme</option>
            </select>
          </div>
        </div>

        <!-- NOTIFICATION PREFERENCES -->
        <div class="card" role="region" aria-label="Notification Preferences">
          <div class="card-header">
            <span class="card-label">Desktop Notifications</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:var(--space-3);">
            Control Windows desktop alerts for pending approvals.
          </div>

          <div style="display:flex; flex-direction:column; gap:var(--space-2);">
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
              <input type="checkbox" id="settingToastToggle" checked />
              <span>Show Windows Desktop Toast notifications for high-risk actions</span>
            </label>
          </div>
        </div>

        <!-- SECURITY SAFETY FLOOR NOTICE -->
        <div class="card" role="region" aria-label="Security Safety Floor">
          <div class="card-header">
            <span class="card-label">Security Containment Floor</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary);">
            Dangerous terminal mode is not permitted in product settings.
            All terminal execution is governed by current Capability Profile and Approval Mode.
          </div>
        </div>
      </div>
    </section>
  `;
}
