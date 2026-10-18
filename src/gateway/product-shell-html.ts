/**
 * WinHelm v1.4.1 Product Shell Orchestrator
 * 
 * Modularized, zero-dependency, strict-CSP compliant Product Shell.
 * Decomposes UI into tokens, views, and client scripts under src/gateway/ui/.
 */

import { PROFILES, type ToolProfile } from "../config/profiles.js";
import { getRuntimeLocale, translate as t } from "../i18n/messages.js";
import { escapeHtml, type CrossTrancheAdapters, type ShellRenderContext } from "./ui/common.js";
import { renderProductShell } from "./ui/shell-layout.js";

export { escapeHtml };

export interface ProductShellSummary {
  schemaMode: "legacy" | "v2" | "invalid";
  preset?: string | null;
  modified?: boolean | null;
  terminalMode?: string | null;
  approvalMode?: string | null;
  focusJobId?: string | null;
  adapters?: CrossTrancheAdapters;
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

    // Phase 2 R2 i18n Keys
    shellHomeDesc: t("shell.home.desc"),
    shellHomeUrgentTitle: t("shell.home.urgent_title"),
    shellHomeUrgentReview: t("shell.home.urgent_inbox"),
    shellHomeApprovalsSub: t("shell.home.pending_desc"),
    shellHomeOpenInbox: t("shell.home.open_inbox"),
    shellHomePolicyDesc: t("shell.home.policy_desc"),
    shellHomeReviewPolicy: t("shell.home.review_policy"),
    shellHomeRemoteTitle: t("shell.home.remote_title"),
    shellHomeRemoteOff: t("shell.home.remote_off"),
    shellHomeRemoteOn: t("shell.home.remote_on"),
    shellHomeLocalReady: t("shell.home.local_ready"),
    shellHomeRemoteDetail: t("shell.home.local_ready_desc"),
    shellHomeConfigureIngress: t("shell.home.configure_ingress"),
    shellHomeViewClients: t("shell.home.view_clients"),
    shellHomeServerStatus: t("shell.home.server_status"),
    shellHomeServerInfo: t("shell.home.server_info"),
    shellHomeShortcutsTitle: t("shell.home.shortcuts"),
    shellHomeShortcutApprovals: t("shell.home.shortcut_approvals"),
    shellHomeShortcutConnections: t("shell.home.shortcut_connections"),
    shellHomeShortcutAccess: t("shell.home.shortcut_access"),

    shellApprovalsQueueTitle: t("shell.approvals.queue_title"),
    shellApprovalsHistoryTitle: t("shell.approvals.history_title"),
    shellApprovalsHistoryEmpty: t("shell.approvals.history_empty"),
    shellApprovalsEmptySub: t("shell.approvals.empty_sub"),
    shellApprovalsNativeReady: t("shell.approvals.native_ready"),
    shellApprovalsNativeReadyDesc: t("shell.approvals.native_ready_desc"),
    shellApprovalsNativeUnavailable: t("shell.approvals.native_unavailable"),
    shellApprovalsNativeUnavailableDesc: t("shell.approvals.native_unavailable_desc"),
    shellApprovalsNativeNeedsRepair: t("shell.approvals.native_needs_repair"),
    shellApprovalsNativeUnknown: t("shell.approvals.native_unknown"),

    shellAdvancedDesc: t("shell.advanced.desc"),
    shellAdvancedPortsTitle: t("shell.advanced.ports_title"),
    shellAdvancedPortsDesc: t("shell.advanced.ports_desc"),
    shellAdvancedPortsAutomatic: t("shell.advanced.ports_automatic"),
    shellAdvancedPortsFixed: t("shell.advanced.ports_fixed"),
    shellAdvancedPortsUnavailable: t("shell.advanced.ports_unavailable"),
    shellAdvancedPortsUnknown: t("shell.advanced.ports_unknown"),
    shellAdvancedTableTarget: t("shell.advanced.table_target"),
    shellAdvancedTableAddress: t("shell.advanced.table_address"),
    shellAdvancedTableState: t("shell.advanced.table_state"),
    shellAdvancedNoEndpoints: t("shell.advanced.no_endpoints"),
    shellAdvancedTelemetryTitle: t("shell.advanced.telemetry_title"),
    shellAdvancedLblHost: t("shell.advanced.lbl_host"),
    shellAdvancedLblLoopback: t("shell.advanced.lbl_loopback"),
    shellAdvancedLblSessions: t("shell.advanced.lbl_sessions"),
    shellAdvancedLblAuth: t("shell.advanced.lbl_auth"),
    shellAdvancedLegacyTitle: t("shell.advanced.legacy_title"),
    shellAdvancedLegacyDesc: t("shell.advanced.legacy_desc"),
    shellAdvancedLegacyLink: t("shell.advanced.legacy_link"),

    shellSetupCompanionTitle: t("shell.setup.companion_title"),
    shellSetupCompanionDesc: t("shell.setup.companion_desc"),
    shellSetupCompanionReady: t("shell.setup.companion_ready"),
    shellSetupCompanionAttention: t("shell.setup.companion_attention"),
    shellSetupCompanionUnavailable: t("shell.setup.companion_unavailable"),
    shellSetupCompanionUnknown: t("shell.setup.companion_unknown"),
    shellSetupCompanionLaunch: t("shell.setup.companion_launch"),
    shellSetupCompanionDiagnostics: t("shell.setup.companion_diagnostics"),
    shellSetupCompanionDisabledHint: t("shell.setup.companion_disabled_hint"),

    shellAccessDesc: t("shell.access.desc"),
    shellAccessModelTitle: t("shell.access.model_title"),
    shellAccessModelDesc: t("shell.access.model_desc"),
    shellAccessAxis1Title: t("shell.access.axis1_title"),
    shellAccessAxis1Desc: t("shell.access.axis1_desc"),
    shellAccessProfilePreset: t("shell.access.profile_preset"),
    shellAccessPresetSafe: t("shell.access.preset_safe"),
    shellAccessPresetBalanced: t("shell.access.preset_balanced"),
    shellAccessPresetPower: t("shell.access.preset_power"),
    shellAccessPowerNoticeTitle: t("shell.access.power_notice_title"),
    shellAccessPowerNoticeBody: t("shell.access.power_notice_body"),
    shellAccessTerminalSafetyHint: t("shell.access.terminal_safety_hint"),
    shellAccessAxis2Title: t("shell.access.axis2_title"),
    shellAccessAxis2Desc: t("shell.access.axis2_desc"),
    shellAccessModeManual: t("shell.access.mode_manual"),
    shellAccessModeSmart: t("shell.access.mode_smart"),
    shellAccessModeTrusted: t("shell.access.mode_trusted"),
    shellAccessTrustedConstraintTitle: t("shell.access.trusted_constraint_title"),
    shellAccessTrustedConstraintBody: t("shell.access.trusted_constraint_body"),
    shellAccessFoldersDesc: t("shell.access.folders_desc"),
    shellAccessFoldersLabel: t("shell.access.folders_label"),
    shellAccessCredTitle: t("shell.access.cred_title"),
    shellAccessCredPill: t("shell.access.cred_pill"),
    shellAccessCredDesc: t("shell.access.cred_desc"),
    shellAccessCredActiveLabel: t("shell.access.cred_active_label"),
    shellAccessCredAdminNote: t("shell.access.cred_admin_note"),

    shellSettingsDesc: t("shell.settings.desc"),
    shellSettingsLangDesc: t("shell.settings.lang_desc"),
    shellSettingsThemeTitle: t("shell.settings.theme_title"),
    shellSettingsThemeDesc: t("shell.settings.theme_desc"),
    shellSettingsThemeSystem: t("shell.settings.theme_system"),
    shellSettingsThemeDark: t("shell.settings.theme_dark"),
    shellSettingsThemeLight: t("shell.settings.theme_light"),
    shellSettingsNotifTitle: t("shell.settings.notif_title"),
    shellSettingsNotifDesc: t("shell.settings.notif_desc"),
    shellSettingsNotifToast: t("shell.settings.notif_toast"),
    shellSettingsDangerNote: t("shell.settings.danger_note"),

    shellActivityDesc: t("shell.activity.desc"),
    shellActivityExport: t("shell.activity.export"),

    shellModalCancel: t("shell.modal.cancel"),
    shellModalSecretWarning: t("shell.modal.secret_warning"),

    shellConnectionsDesc: t("shell.connections.desc"),
    shellConnectionsClaudeDesc: t("shell.connections.claude_desc"),
    shellConnectionsCursorDesc: t("shell.connections.cursor_desc"),
    shellConnectionsChatgptDesc: t("shell.connections.chatgpt_desc"),
    shellConnectionsTailscaleDesc: t("shell.connections.tailscale_desc"),
    shellConnectionsTailscaleManual: t("shell.connections.tailscale_manual"),
    shellConnectionsTailscaleDoc: t("shell.connections.tailscale_doc"),
    shellConnectionsBtnPreview: t("shell.connections.btn_preview"),
    shellConnectionsSessionsTitle: t("shell.connections.sessions_title"),
    shellConnectionsThClientName: t("shell.connections.th_client_name"),
    shellConnectionsThHostAddr: t("shell.connections.th_host_addr"),
    shellConnectionsThTransport: t("shell.connections.th_transport"),
    shellConnectionsThSessionId: t("shell.connections.th_session_id"),
    shellConnectionsThStatus: t("shell.connections.th_status"),
    shellConnectionsNoSessions: t("shell.connections.no_sessions"),
  };

  const clientScriptMessages = JSON.stringify(messages).replace(/</g, "\\u003c");

  const adapters: CrossTrancheAdapters = {
    nativeApproval: summary?.adapters?.nativeApproval ?? "unknown",
    dynamicPorts: summary?.adapters?.dynamicPorts ?? { mode: "unknown", endpoints: [] },
    setupAssistant: summary?.adapters?.setupAssistant ?? "unknown",
  };

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
    adapters,
  };

  return renderProductShell(context);
}

