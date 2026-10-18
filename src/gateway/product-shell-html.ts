/**
 * WinHelm v1.4.1 Product Shell Orchestrator
 * 
 * Modularized, zero-dependency, strict-CSP compliant Product Shell.
 * Decomposes UI into tokens, views, and client scripts under src/gateway/ui/.
 */

import { PROFILES, type ToolProfile } from "../config/profiles.js";
import { getRuntimeLocale, translate as t } from "../i18n/messages.js";
import { escapeHtml, type ShellRenderContext } from "./ui/common.js";
import { renderProductShell } from "./ui/shell-layout.js";

export { escapeHtml };

export interface ProductShellSummary {
  schemaMode: "legacy" | "v2" | "invalid";
  preset?: string | null;
  modified?: boolean | null;
  terminalMode?: string | null;
  approvalMode?: string | null;
  focusJobId?: string | null;
}

/**
 * Modern, accessible, zero-dependency Web Product Shell for WinHelm v1.4.1.
 * Served directly by Express without external CDN dependencies.
 */
export function getProductShellHtml(
  activeProfile: ToolProfile = "full",
  summary?: ProductShellSummary
): string {
  const profileDef = PROFILES[activeProfile] || PROFILES.full;
  const schemaMode = summary?.schemaMode ?? "legacy";
  const displayProfile =
    schemaMode === "v2"
      ? String(summary?.preset ?? "balanced")
      : profileDef.name;
  const isModified = summary?.modified === true;
  const terminalMode = summary?.terminalMode ?? "ask";
  const approvalMode = summary?.approvalMode ?? "manual";
  const focusJobId = summary?.focusJobId ?? "";
  const locale = getRuntimeLocale();

  const messages: Record<string, string> = {
    title: t("shell.title"),
    navOverview: t("shell.nav.overview"),
    navAccess: t("shell.nav.access"),
    navApprovals: t("shell.nav.approvals"),
    navActivity: t("shell.nav.activity"),
    navConnections: t("shell.nav.connections"),
    navSettings: t("shell.nav.settings"),
    navAdvanced: t("shell.nav.advanced"),
    statusRunning: t("shell.overview.status.running"),
    profileTitle: t("shell.overview.profile.title"),
    profileModified: t("shell.overview.profile.modified"),
    approvalTitle: t("shell.overview.approval.title"),
    pendingTitle: t("shell.overview.pending.title"),
    connectionsTitle: t("shell.overview.connections.title"),
    legacyBanner: t("shell.overview.legacy.banner"),
    warningsNone: t("shell.overview.warnings.none"),
    accessTitle: t("shell.access.title"),
    foldersTitle: t("shell.access.folders.title"),
    foldersEmpty: t("shell.access.folders.empty"),
    folderRead: t("shell.access.folders.read"),
    folderReadwrite: t("shell.access.folders.readwrite"),
    terminalTitle: t("shell.access.terminal.title"),
    terminalSafeDistinction: t("shell.access.terminal.safe_distinction"),
    accessPreview: t("shell.access.preview"),
    accessSave: t("shell.access.save"),
    approvalsTitle: t("shell.approvals.title"),
    approvalsEmpty: t("shell.approvals.empty"),
    approvalsApprove: t("shell.approvals.approve"),
    approvalsDeny: t("shell.approvals.deny"),
    approvalsClient: t("shell.approvals.client"),
    approvalsTool: t("shell.approvals.tool"),
    approvalsRisk: t("shell.approvals.risk"),
    approvalsTarget: t("shell.approvals.target"),
    approvalsDetails: t("shell.approvals.details"),
    approvalsPreview: t("shell.approvals.preview"),
    approvalsOnce: t("shell.approvals.once"),
    activityTitle: t("shell.activity.title"),
    activityEmpty: t("shell.activity.empty"),
    filterAll: t("shell.activity.filter.all"),
    filterTools: t("shell.activity.filter.tools"),
    filterSecurity: t("shell.activity.filter.security"),
    filterErrors: t("shell.activity.filter.errors"),
    activityAdvancedHint: t("shell.activity.advanced_hint"),
    connTitle: t("shell.connections.title"),
    connClaudeLabel: t("shell.connections.claude.label"),
    connClaudeType: t("shell.connections.claude.type"),
    connCursorLabel: t("shell.connections.cursor.label"),
    connCursorType: t("shell.connections.cursor.type"),
    connChatgptLabel: t("shell.connections.chatgpt.label"),
    connChatgptLifecycleTitle: t("shell.connections.chatgpt.lifecycle_title"),
    connChatgptDependencyLabel: t("shell.connections.chatgpt.dependency_label"),
    connChatgptProfileLabel: t("shell.connections.chatgpt.profile_label"),
    connChatgptBackendLabel: t("shell.connections.chatgpt.backend_label"),
    connChatgptStateLabel: t("shell.connections.chatgpt.state_label"),
    connChatgptOwnershipLabel: t("shell.connections.chatgpt.ownership_label"),
    connChatgptManaged: t("shell.connections.chatgpt.managed"),
    connChatgptExternal: t("shell.connections.chatgpt.external_unmanaged"),
    connChatgptActionStart: t("shell.connections.chatgpt.action_start"),
    connChatgptActionStop: t("shell.connections.chatgpt.action_stop"),
    connChatgptActionRestart: t("shell.connections.chatgpt.action_restart"),
    connChatgptActionDoctor: t("shell.connections.chatgpt.action_doctor"),
    connChatgptConfirmHint: t("shell.connections.chatgpt.confirm_hint"),
    connChatgptConfirmPlaceholder: t("shell.connections.chatgpt.confirm_placeholder"),
    connChatgptExternalNotice: t("shell.connections.chatgpt.external_notice"),
    connChatgptConfigureHint: t("shell.connections.chatgpt.configure_hint"),
    connChatgptRecoveryHint: t("shell.connections.chatgpt.recovery_hint"),
    connChatgptType: t("shell.connections.chatgpt.type"),
    connTailscaleLabel: t("shell.connections.tailscale.label"),
    connTailscaleType: t("shell.connections.tailscale.type"),
    connConfigure: t("shell.connections.configure"),
    connConnected: t("shell.connections.connected"),
    connNotConnected: t("shell.connections.not_connected"),
    settingsTitle: t("shell.settings.title"),
    settingsProfile: t("shell.settings.profile"),
    settingsApprovalMode: t("shell.settings.approval_mode"),
    settingsLanguage: t("shell.settings.language"),
    settingsToken: t("shell.settings.token"),
    settingsDangerousNotice: t("shell.settings.dangerous_notice"),
    settingsSave: t("shell.settings.save"),
    adminRequired: t("shell.admin.required"),
    adminHint: t("shell.admin.hint"),
    adminInstructions: t("dashboard.admin.instructions"),
    adminPlaceholder: t("shell.admin.placeholder"),
    adminUnlock: t("shell.admin.unlock"),
    adminUnlocked: t("shell.admin.status_unlocked"),
    adminLocked: t("shell.admin.status_locked"),
    approvalsNote: t("dashboard.approvals.note"),
    confirmType: t("confirm.type"),
    tokenConfirm: t("dashboard.token.confirm"),
    tokenRotate: t("dashboard.token.rotate"),
    tokenNew: t("dashboard.token.new"),
    tokenOnce: t("dashboard.token.once"),
    fullWarn: t("mode.full.warn"),
    navSetup: t("shell.nav.setup"),
    setupTitle: t("shell.setup.title"),
    setupDesc: t("shell.setup.desc"),
    setupRecheck: t("shell.setup.recheck"),
    setupLocked: t("shell.setup.locked"),
    setupStepWorkspace: t("shell.setup.step.workspace"),
    setupStepProfile: t("shell.setup.step.profile"),
    setupStepApproval: t("shell.setup.step.approval"),
    setupStepClient: t("shell.setup.step.client"),
    setupStepObserve: t("shell.setup.step.observe"),
    setupStepFirstAction: t("shell.setup.step.first_action"),
    setupStepOrientation: t("shell.setup.step.orientation"),
    setupStatusComplete: t("shell.setup.status.complete"),
    setupStatusIncomplete: t("shell.setup.status.incomplete"),
    setupStatusConfigured: t("shell.setup.status.configured"),
    setupStatusNeedsConfiguration: t("shell.setup.status.needs_configuration"),
    setupStatusAttention: t("shell.setup.status.attention"),
    setupStatusActive: t("shell.setup.status.active"),
    setupStatusNotObserved: t("shell.setup.status.not_observed"),
    setupCurrent: t("shell.setup.current"),
    setupOpenAccess: t("shell.setup.open_access"),
    setupOpenSettings: t("shell.setup.open_settings"),
    setupOpenConnections: t("shell.setup.open_connections"),
    setupOpenApprovals: t("shell.setup.open_approvals"),
    setupOpenActivity: t("shell.setup.open_activity"),
    setupFirstActionBody: t("shell.setup.first_action.body"),
    setupOrientationBody: t("shell.setup.orientation.body"),
    connRestartHint: t("shell.connections.restart_hint"),
  };

  const clientScriptMessages = JSON.stringify(messages).replace(/</g, "\\u003c");

  const context: ShellRenderContext = {
    activeProfile,
    schemaMode,
    preset: displayProfile,
    displayProfile,
    isModified,
    terminalMode,
    approvalMode,
    focusJobId,
    locale,
    messages,
    clientScriptMessages,
  };

  return renderProductShell(context);
}
