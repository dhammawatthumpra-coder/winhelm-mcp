/**
 * WinHelm v1.4.1 Dashboard UI Refresh — Prototype Mock Data Fixtures
 * 
 * Contains realistic, non-sensitive fixtures demonstrating the 10 required states:
 * 1. Healthy / no approvals / Remote Access Off
 * 2. Pending approval requiring attention
 * 3. Remote client connected
 * 4. Client needs attention
 * 5. Automatic Internal Ports healthy
 * 6. Fixed-port compatibility
 * 7. Admin locked
 * 8. Admin unlocked
 * 9. Security/config warning
 * 10. Narrow viewport
 */

const PROTOTYPE_MOCK_STATES = {
  // State 1: Healthy / no approvals / Remote Access Off
  healthy_nominal: {
    id: "healthy_nominal",
    label: "1. Healthy (Nominal / Remote Off)",
    description: "Standard daily state: WinHelm Ready, 0 pending approvals, Remote Access Off, Balanced Profile, Smart Prompting.",
    systemStatus: "Ready",
    systemStatusDetail: "All services operating normally on local loopback.",
    adminLocked: true,
    remoteAccess: "off",
    remoteAccessDetail: "Listening on 127.0.0.1 loopback only. Zero public exposure.",
    portMode: "automatic",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "gen_20261018_0984a1",
      retries: 0
    },
    profile: "balanced",
    approvalMode: "smart",
    terminalMode: "ask",
    notifications: "available",
    pendingApprovals: [],
    warning: null,
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "1h 12m" },
      { id: "cursor", name: "Cursor Editor", status: "connected", transport: "Streamable HTTP", pid: 8912, uptime: "45m" },
      { id: "chatgpt", name: "ChatGPT / OpenAI", status: "configured", transport: "Local Bridge", pid: null, uptime: null },
      { id: "gemini", name: "Google Gemini", status: "ready", transport: "Local Bridge", pid: null, uptime: null }
    ]
  },

  // State 2: Pending approval requiring attention
  pending_approval: {
    id: "pending_approval",
    label: "2. Pending Approval (Action Required)",
    description: "AI requested high-risk command execution outside boundary. Urgent banner shown on Home and badge on Approvals tab.",
    systemStatus: "Needs Attention",
    systemStatusDetail: "1 pending approval requires human authorization.",
    adminLocked: true,
    remoteAccess: "off",
    remoteAccessDetail: "Listening on 127.0.0.1 loopback only. Zero public exposure.",
    portMode: "automatic",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "gen_20261018_0984a1",
      retries: 0
    },
    profile: "balanced",
    approvalMode: "smart",
    terminalMode: "ask",
    notifications: "available",
    warning: null,
    pendingApprovals: [
      {
        id: "job_98412",
        clientName: "Claude Desktop",
        clientPid: 14220,
        tool: "execute_command",
        riskLevel: "High",
        riskReason: "Executes external command outside project root directory.",
        target: "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"npm run build\"",
        workingDirectory: "D:\\mcp\\projects\\webapp",
        requiresConfirmation: true,
        expiresInSeconds: 165,
        argumentsPayload: {
          command: "npm run build",
          shell: "powershell.exe",
          args: ["-NoProfile", "-ExecutionPolicy", "Bypass"],
          cwd: "D:\\mcp\\projects\\webapp",
          timeoutMs: 60000
        }
      }
    ],
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "1h 15m" },
      { id: "cursor", name: "Cursor Editor", status: "connected", transport: "Streamable HTTP", pid: 8912, uptime: "48m" },
      { id: "chatgpt", name: "ChatGPT / OpenAI", status: "configured", transport: "Local Bridge", pid: null, uptime: null },
      { id: "gemini", name: "Google Gemini", status: "ready", transport: "Local Bridge", pid: null, uptime: null }
    ]
  },

  // State 3: Remote client connected
  remote_connected: {
    id: "remote_connected",
    label: "3. Remote Access ON (Tailscale / Ingress)",
    description: "Remote Access is explicitly active via verified Tailscale HTTPS tunnel. Visible route and ingress URL.",
    systemStatus: "Ready",
    systemStatusDetail: "Core operational. Remote Access tunnel verified.",
    adminLocked: true,
    remoteAccess: "on",
    remoteAccessDetail: "Tailscale HTTPS tunnel active: https://winhelm-node.tailnet.ts.net/mcp",
    portMode: "automatic",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "gen_20261018_0984a1",
      retries: 0
    },
    profile: "balanced",
    approvalMode: "smart",
    terminalMode: "ask",
    notifications: "available",
    pendingApprovals: [],
    warning: null,
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "2h 05m" },
      { id: "chatgpt", name: "ChatGPT (Remote Tunnel)", status: "connected", transport: "Tailscale Ingress (100.64.0.12)", pid: null, uptime: "12m" },
      { id: "cursor", name: "Cursor Editor", status: "connected", transport: "Streamable HTTP", pid: 8912, uptime: "1h 38m" },
      { id: "gemini", name: "Google Gemini", status: "ready", transport: "Local Bridge", pid: null, uptime: null }
    ]
  },

  // State 4: Client needs attention
  client_needs_attention: {
    id: "client_needs_attention",
    label: "4. Client Needs Attention (Config Error)",
    description: "Cursor configuration path exists but points to outdated schema. One-click repair action available.",
    systemStatus: "Needs Attention",
    systemStatusDetail: "Cursor client config file requires schema upgrade.",
    adminLocked: true,
    remoteAccess: "off",
    remoteAccessDetail: "Listening on 127.0.0.1 loopback only. Zero public exposure.",
    portMode: "automatic",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "gen_20261018_0984a1",
      retries: 0
    },
    profile: "balanced",
    approvalMode: "smart",
    terminalMode: "ask",
    notifications: "available",
    pendingApprovals: [],
    warning: {
      type: "client",
      title: "Cursor Configuration Out of Date",
      message: "Cursor config at '%APPDATA%\\Cursor\\mcp.json' uses legacy v1 schema. Update config to restore full tool capabilities.",
      actionText: "Update Cursor Config",
      actionTarget: "repair_client_cursor"
    },
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "30m" },
      { id: "cursor", name: "Cursor Editor", status: "needs_attention", error: "Legacy schema detected in mcp.json", transport: "Unreachable", pid: null, uptime: null },
      { id: "chatgpt", name: "ChatGPT / OpenAI", status: "not_configured", transport: "None", pid: null, uptime: null },
      { id: "gemini", name: "Google Gemini", status: "ready", transport: "Local Bridge", pid: null, uptime: null }
    ]
  },

  // State 5: Automatic Internal Ports healthy
  auto_ports_healthy: {
    id: "auto_ports_healthy",
    label: "5. Automatic Ports (Tranche A Healthy)",
    description: "Demonstrates Tranche A dynamic allocation. Hidden from ordinary UI, fully detailed under Advanced.",
    systemStatus: "Ready",
    systemStatusDetail: "Tranche A dynamic internal port allocator running smoothly.",
    adminLocked: true,
    remoteAccess: "off",
    remoteAccessDetail: "Listening on 127.0.0.1 loopback only.",
    portMode: "automatic",
    ports: {
      core: 19410,
      r7: 19411,
      r8: 19412,
      generation: "gen_20261018_trancheA_alloc_01",
      retries: 0
    },
    profile: "balanced",
    approvalMode: "smart",
    terminalMode: "ask",
    notifications: "available",
    pendingApprovals: [],
    warning: null,
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "55m" },
      { id: "cursor", name: "Cursor Editor", status: "connected", transport: "Streamable HTTP", pid: 8912, uptime: "55m" }
    ]
  },

  // State 6: Fixed-port compatibility
  fixed_ports_legacy: {
    id: "fixed_ports_legacy",
    label: "6. Fixed-Port Mode (Compatibility)",
    description: "User pinned static ports in config. Advanced view shows explicit fixed configuration badge.",
    systemStatus: "Ready",
    systemStatusDetail: "Fixed port configuration active (Legacy compatibility mode).",
    adminLocked: true,
    remoteAccess: "off",
    remoteAccessDetail: "Listening on 127.0.0.1:18820 loopback only.",
    portMode: "fixed",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "fixed_pinned",
      retries: 0
    },
    profile: "balanced",
    approvalMode: "smart",
    terminalMode: "ask",
    notifications: "available",
    pendingApprovals: [],
    warning: null,
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "3h 10m" }
    ]
  },

  // State 7: Admin locked
  admin_locked: {
    id: "admin_locked",
    label: "7. Admin Locked (Read-Only)",
    description: "Daily read-only monitoring mode. Elevated mutations prompt for terminal admin-code.",
    systemStatus: "Ready",
    systemStatusDetail: "Protected local admin session is locked.",
    adminLocked: true,
    remoteAccess: "off",
    remoteAccessDetail: "Local loopback only.",
    portMode: "automatic",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "gen_20261018_0984a1",
      retries: 0
    },
    profile: "safe",
    approvalMode: "manual",
    terminalMode: "ask",
    notifications: "available",
    pendingApprovals: [],
    warning: null,
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "10m" }
    ]
  },

  // State 8: Admin unlocked
  admin_unlocked: {
    id: "admin_unlocked",
    label: "8. Admin Unlocked (Elevated Session)",
    description: "Active local admin session with remaining expiration timer. Allows policy mutation & token rotation.",
    systemStatus: "Ready",
    systemStatusDetail: "Admin session unlocked via local terminal authentication.",
    adminLocked: false,
    adminSessionExpiresInSeconds: 840,
    remoteAccess: "off",
    remoteAccessDetail: "Local loopback only.",
    portMode: "automatic",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "gen_20261018_0984a1",
      retries: 0
    },
    profile: "balanced",
    approvalMode: "smart",
    terminalMode: "ask",
    notifications: "available",
    pendingApprovals: [],
    warning: null,
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "15m" }
    ]
  },

  // State 9: Security/config warning
  security_warning: {
    id: "security_warning",
    label: "9. Security / Config Warning",
    description: "Full terminal privileges active on Power profile. Prominent yellow danger advisory banner displayed.",
    systemStatus: "Needs Attention",
    systemStatusDetail: "Elevated terminal execution mode active with Power profile.",
    adminLocked: false,
    adminSessionExpiresInSeconds: 620,
    remoteAccess: "off",
    remoteAccessDetail: "Local loopback only.",
    portMode: "automatic",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "gen_20261018_0984a1",
      retries: 0
    },
    profile: "power",
    approvalMode: "manual",
    terminalMode: "full",
    notifications: "available",
    pendingApprovals: [],
    warning: {
      type: "security",
      title: "Elevated Terminal Execution Active",
      message: "Terminal mode is set to 'full'. The AI client can run arbitrary commands with host user privileges. Review your allowed folders and approval mode.",
      actionText: "Switch to Balanced Profile",
      actionTarget: "set_balanced_profile"
    },
    clients: [
      { id: "claude", name: "Claude Desktop", status: "connected", transport: "SSE (Local)", pid: 14220, uptime: "40m" }
    ]
  },

  // State 10: Narrow viewport preview
  narrow_viewport: {
    id: "narrow_viewport",
    label: "10. Narrow Viewport / Mobile Layout",
    description: "Simulates tablet (768px) and mobile (480px) responsive reflow with collapsing drawer and card stacking.",
    systemStatus: "Needs Attention",
    systemStatusDetail: "Responsive test with 1 pending approval.",
    adminLocked: true,
    remoteAccess: "off",
    remoteAccessDetail: "Local loopback only.",
    portMode: "automatic",
    ports: {
      core: 18820,
      r7: 18821,
      r8: 18822,
      generation: "gen_20261018_0984a1",
      retries: 0
    },
    profile: "balanced",
    approvalMode: "smart",
    terminalMode: "ask",
    notifications: "available",
    pendingApprovals: [
      {
        id: "job_77102",
        clientName: "Cursor Editor",
        clientPid: 8912,
        tool: "write_file",
        riskLevel: "Medium",
        riskReason: "Overwrites configuration file in active workspace.",
        target: "D:\\mcp\\projects\\webapp\\src\\config.ts",
        workingDirectory: "D:\\mcp\\projects\\webapp",
        requiresConfirmation: false,
        expiresInSeconds: 240,
        argumentsPayload: {
          path: "src/config.ts",
          content: "// updated configuration\nexport const API_HOST = 'http://localhost:3000';",
          overwrite: true
        }
      }
    ],
    warning: null,
    clients: [
      { id: "cursor", name: "Cursor Editor", status: "connected", transport: "Streamable HTTP", pid: 8912, uptime: "15m" }
    ]
  }
};

const MOCK_ACTIVITY_STREAM = [
  { id: "act_1", time: "12:44:02", category: "approvals", actor: "Claude Desktop", action: "execute_command", target: "npm run build", status: "pending", detail: "Awaiting human authorization in Approvals inbox" },
  { id: "act_2", time: "12:41:19", category: "tools", actor: "Cursor Editor", action: "read_file", target: "D:\\mcp\\src\\gateway\\server.ts", status: "allowed", detail: "Read allowed directory under Smart policy" },
  { id: "act_3", time: "12:38:50", category: "security", actor: "Local Terminal", action: "admin_code_exchange", target: "Admin Session", status: "success", detail: "Session token granted for 15 minutes" },
  { id: "act_4", time: "12:35:10", category: "connections", actor: "Claude Desktop", action: "client_connected", target: "SSE Loopback (PID 14220)", status: "connected", detail: "Session established successfully" },
  { id: "act_5", time: "12:30:11", category: "system", actor: "WinHelm Daemon", action: "gateway_started", target: "Tranche A Dynamic Ports", status: "ready", detail: "Core:18820, R7:18821, R8:18822 allocated" },
  { id: "act_6", time: "12:20:10", category: "approvals", actor: "Owner", action: "approved", target: "write_file D:\\mcp\\src\\app.ts", status: "approved", detail: "Authorized via Web Dashboard" },
  { id: "act_7", time: "11:45:00", category: "approvals", actor: "Owner", action: "denied", target: "delete_file D:\\mcp\\temp.log", status: "denied", detail: "Denied by Owner (Outside scope)" }
];

const MOCK_TOOL_REGISTRY = [
  { name: "read_file", group: "Filesystem", risk: "Low", profile: "Safe", loaded: true, description: "Read file contents from allowed directories." },
  { name: "search_files", group: "Filesystem", risk: "Low", profile: "Safe", loaded: true, description: "Search for files by pattern or regex." },
  { name: "write_file", group: "Filesystem", risk: "Medium", profile: "Balanced", loaded: true, description: "Create or overwrite files within allowed directories." },
  { name: "edit_file", group: "Filesystem", risk: "Medium", profile: "Balanced", loaded: true, description: "Make precise surgical edits to file contents." },
  { name: "execute_command", group: "Execution", risk: "High", profile: "Power", loaded: true, description: "Run terminal commands with Windows user privileges." },
  { name: "get_system_telemetry", group: "System", risk: "Low", profile: "Safe", loaded: true, description: "Inspect host CPU, memory, and runtime metrics." },
  { name: "list_active_processes", group: "System", risk: "Low", profile: "Safe", loaded: true, description: "List currently running processes." }
];
