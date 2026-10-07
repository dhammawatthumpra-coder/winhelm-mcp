export type SupportedLocale = "en" | "th";

export const EN_MESSAGES = {
  "mode.full.warn":
    "The AI can run any command without asking and has the same rights as your Windows account",
  "approve.expiry":
    "The command will not run after this expires",
  "confirm.type":
    'Type "confirm" to continue',
  "notify.approval.title":
    "WinHelm approval required",
  "notify.approval.body":
    "An AI action is waiting for your approval in WinHelm.",
  "notify.approval.action":
    "Open WinHelm",
  "dashboard.admin.locked":
    "Locked · local admin code required",
  "dashboard.admin.unlocked":
    "Unlocked · local admin session",
  "dashboard.admin.instructions":
    "Run winhelm admin-code in a local terminal, then enter the one-time code here. The admin credential is separate from MCP authentication. Never paste the code into an AI chat.",
  "dashboard.admin.placeholder":
    "One-time admin code",
  "dashboard.admin.unlock":
    "Unlock",
  "dashboard.admin.code_hint":
    'Enter the one-time code from "winhelm admin-code".',
  "dashboard.admin.loading":
    "Unlock completed. Loading current permissions…",
  "dashboard.approvals.title":
    "Approval Jobs",
  "dashboard.approvals.note":
    "Pending approvals are local-only. Arguments are displayed as text, never rendered as HTML/Markdown.",
  "dashboard.approvals.empty":
    "No approval jobs.",
  "dashboard.approvals.approve":
    "Approve",
  "dashboard.approvals.deny":
    "Deny",
  "dashboard.approvals.arguments":
    "Arguments",
  "dashboard.approvals.folders":
    "Folders",
  "dashboard.approvals.noFolder":
    "no matching folder",
  "dashboard.approvals.provenance":
    "Recent session activity",
  "dashboard.approvals.showPreview":
    "Show text preview",
  "dashboard.approvals.hidePreview":
    "Hide text preview",
  "dashboard.clients.title":
    "Connected MCP Clients",
  "dashboard.clients.note":
    "Client names are supplied by the connecting client and are displayed as text only.",
  "dashboard.clients.empty":
    "No session has announced clientInfo yet.",
  "dashboard.clients.loading":
    "Loading…",
  "dashboard.token.title":
    "MCP Access Token",
  "dashboard.token.note":
    "Rotating replaces the bearer token immediately: clients still using the old token fail on their next request. Dashboard session cookies issued earlier stay valid for up to 15 minutes.",
  "dashboard.token.rotate":
    "Rotate token",
  "dashboard.token.confirm":
    "Rotate the MCP access token now? The previous token stops working immediately.",
  "dashboard.token.loading":
    "Rotating…",
  "dashboard.token.new":
    "New token (shown once) — copy it into your MCP clients:",
  "dashboard.token.once":
    "It will not be shown again. Store it in a password manager, not in this chat.",
  "dashboard.teach.title":
    "Test and teach your AI",
  "dashboard.teach.intro":
    "Run one of these prompts in your AI app, then watch the Activity & Execution Stream further down this page until the first successful call appears.",
  "dashboard.teach.examples":
    "Example prompts",
  "dashboard.teach.example1":
    "Use WinHelm to list the files in my workspace folder.",
  "dashboard.teach.example2":
    "Use WinHelm to read the first 20 lines of a log file on my PC.",
  "dashboard.teach.instructions":
    "Instructions for the AI",
  "dashboard.teach.instructionText":
    "When I mention files, apps or processes on my computer, use the WinHelm tools. They run on my real Windows PC, not a sandbox. If a tool result contains userAction, tell me what it says instead of working around it.",
  "dashboard.teach.claudeTip":
    "Claude Desktop can answer from its own sandbox instead of WinHelm. In one measured run, 0 of 6 natural prompts reached WinHelm, while an explicit prompt containing \"ใช้ mcp\" reached it 1 of 1 with the full schema. Adding \"ใช้ mcp\" or \"ผ่าน WinHelm\" is worth trying; it is not a guarantee.",
  "dashboard.teach.sandboxHint":
    "If the AI still answers from a sandbox, try turning off \"Code execution and file creation\" in that app's settings. This is an observation from testing, not a guarantee.",
  "dashboard.teach.copy":
    "Copy",
  "dashboard.teach.copied":
    "Copied.",
  "dashboard.teach.copyFailed":
    "Copy failed — select the text and copy it manually.",

  "action.folder.readwrite":
    "Choose a readwrite folder or change its permission in WinHelm settings.",
  "action.folder.allowed":
    "Choose a path inside an allowed WinHelm folder.",
  "action.path.alias":
    "Use a full path or @alias/... for one of the configured WinHelm folders.",
  "action.safe.cwd":
    "Choose a readwrite WinHelm folder as cwd or change Terminal mode locally.",
  "action.terminal.change":
    "Change Terminal mode in WinHelm settings.",
  "action.terminal.safe_command":
    "Use command_run for supported package-manager operations or change Terminal mode locally.",
  "action.approve.command":
    "Approve this command in WinHelm.",
  "action.approve.terminal":
    "Approve this terminal action in WinHelm.",
  "action.tool.enable":
    "Enable this tool in WinHelm permissions.",
  "action.approve.generic":
    "Approve this action in WinHelm.",

  "action.approval.review_before_retry":
    "Review the WinHelm job details before retrying.",
  "action.approval.denied":
    "Do not retry unless the user explicitly asks you to try again.",
  "action.approval.expired":
    "Ask the user whether they want to submit the action again.",
  "action.approval.cancelled":
    "Do not retry automatically.",
  "action.approval.use_status":
    "Use winhelm_job_status instead of re-running the original tool.",
  "action.approval.resolve_pending":
    "Resolve or deny an existing pending WinHelm approval before retrying.",
  "action.approval.review_recent":
    "Review recent WinHelm jobs before attempting this action again.",
  "action.job.check_id":
    "Check the jobId and do not use a jobId from another session.",
  "action.job.review":
    "Review the WinHelm job before retrying.",
  "action.config.repair":
    "Open WinHelm to repair the configuration before retrying.",
  "action.command.allowed":
    "Use an allowed direct executable, change Terminal mode locally, or use terminal_run when shell semantics are required.",
  "action.network.target":
    "Use a permitted network target or change WinHelm network settings where appropriate.",
  "action.error.review":
    "Review the error details and adjust the request or WinHelm settings before retrying.",

  "shell.title":
    "WinHelm | Control Center",
  "shell.nav.overview":
    "Overview",
  "shell.nav.access":
    "Access",
  "shell.nav.approvals":
    "Approvals",
  "shell.nav.activity":
    "Activity",
  "shell.nav.connections":
    "Connections",
  "shell.nav.settings":
    "Settings",
  "shell.nav.advanced":
    "Advanced / Diagnostics",
  "shell.overview.status.running":
    "Running",
  "shell.overview.status.stopped":
    "Stopped",
  "shell.overview.profile.title":
    "Capability Profile",
  "shell.overview.profile.modified":
    "Modified",
  "shell.overview.approval.title":
    "Approval Mode",
  "shell.overview.pending.title":
    "Pending Approvals",
  "shell.overview.connections.title":
    "Client Connections",
  "shell.overview.legacy.banner":
    "Legacy configuration active. Upgrade to schema v2 in Access & Settings for granular policy enforcement.",
  "shell.overview.warnings.none":
    "System operating within normal parameters.",
  "shell.access.title":
    "Folder Access & Terminal Policy",
  "shell.access.folders.title":
    "Approved Workspace Folders",
  "shell.access.folders.empty":
    "No specific workspace folders configured.",
  "shell.access.folders.read":
    "Read-only",
  "shell.access.folders.readwrite":
    "Read-Write",
  "shell.access.terminal.title":
    "Terminal Containment",
  "shell.access.terminal.safe_distinction":
    "Note: Safe Profile restricts available tool schemas; terminal mode controls execution safety.",
  "shell.access.preview":
    "Preview Access Changes",
  "shell.access.save":
    "Apply Access Changes",
  "shell.approvals.title":
    "Pending Approvals",
  "shell.approvals.empty":
    "No pending approval requests.",
  "shell.approvals.approve":
    "Approve",
  "shell.approvals.deny":
    "Deny",
  "shell.approvals.client":
    "Client",
  "shell.approvals.tool":
    "Tool",
  "shell.approvals.risk":
    "Risk",
  "shell.approvals.target":
    "Target",
  "shell.approvals.details":
    "Details",
  "shell.approvals.preview":
    "Text Preview",
  "shell.approvals.once":
    "Approvals execute exactly once upon decision.",
  "shell.activity.title":
    "Recent Activity",
  "shell.activity.empty":
    "No activity recorded yet.",
  "shell.activity.filter.all":
    "All",
  "shell.activity.filter.tools":
    "Tools",
  "shell.activity.filter.security":
    "Security",
  "shell.activity.filter.errors":
    "Errors",
  "shell.activity.advanced_hint":
    "Detailed telemetry and raw logs are available in Advanced / Diagnostics.",
  "shell.connections.title":
    "Client Connections",
  "shell.connections.claude.label":
    "Claude Desktop",
  "shell.connections.claude.type":
    "First-Class",
  "shell.connections.cursor.label":
    "Cursor",
  "shell.connections.cursor.type":
    "First-Class",
  "shell.connections.chatgpt.label":
    "ChatGPT / OpenAI Tunnel",
  "shell.connections.chatgpt.type":
    "First-Class Target",
  "shell.connections.tailscale.label":
    "Tailscale HTTPS /mcp",
  "shell.connections.tailscale.type":
    "Advanced / Manual",
  "shell.connections.configure":
    "Configure",
  "shell.connections.connected":
    "Connected",
  "shell.connections.not_connected":
    "Not Connected",
  "shell.settings.title":
    "Settings",
  "shell.settings.profile":
    "Capability Profile",
  "shell.settings.approval_mode":
    "Approval Mode",
  "shell.settings.language":
    "Language",
  "shell.settings.token":
    "Access Token",
  "shell.settings.dangerous_notice":
    "Dangerous terminal mode is not permitted in product settings. Use Advanced Dashboard if required.",
  "shell.settings.save":
    "Save Settings",
  "shell.admin.required":
    "Admin Unlock Required",
  "shell.admin.hint":
    "Run 'winhelm admin-code' in your terminal and enter the one-time code here.",
  "shell.admin.placeholder":
    "Enter one-time admin code",
  "shell.admin.unlock":
    "Unlock",
  "shell.admin.status_unlocked":
    "Admin Unlocked",
  "shell.admin.status_locked":
    "Read-Only (Locked)",
  "shell.nav.setup":
    "Setup",
  "shell.setup.title":
    "Guided Setup",
  "shell.setup.desc":
    "Complete first-run configuration without editing JSON. This checklist derives its status from live backend state.",
  "shell.setup.recheck":
    "Recheck Status",
  "shell.setup.locked":
    "Unlock the admin session (top right) to load live setup status.",
  "shell.setup.step.workspace":
    "Workspace Folders",
  "shell.setup.step.profile":
    "Capability Profile",
  "shell.setup.step.approval":
    "Approval Mode",
  "shell.setup.step.client":
    "Connect Claude Desktop or Cursor",
  "shell.setup.step.observe":
    "Connection Observation",
  "shell.setup.step.first_action":
    "First Safe Action",
  "shell.setup.step.orientation":
    "Where Things Live",
  "shell.setup.status.complete":
    "Complete",
  "shell.setup.status.incomplete":
    "Incomplete",
  "shell.setup.status.configured":
    "Configured",
  "shell.setup.status.needs_configuration":
    "Needs Configuration",
  "shell.setup.status.attention":
    "Attention",
  "shell.setup.status.active":
    "Active Session Observed",
  "shell.setup.status.not_observed":
    "No Active Session Observed",
  "shell.setup.current":
    "Current",
  "shell.setup.open_access":
    "Open Access",
  "shell.setup.open_settings":
    "Open Settings",
  "shell.setup.open_connections":
    "Open Connections",
  "shell.setup.open_approvals":
    "Open Approvals",
  "shell.setup.open_activity":
    "Open Activity",
  "shell.setup.first_action.body":
    "In your connected client, ask: \u201cUse WinHelm to list the files in my workspace folder.\u201d This is instruction text only; the browser never executes MCP tools.",
  "shell.setup.orientation.body":
    "Approve or deny pending tool actions under Approvals. Review every tool call and security event under Activity.",
  "shell.connections.restart_hint":
    "If this client was running, restart it or reconnect so the new configuration is loaded.",
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;

export const TH_MESSAGES: Record<MessageKey, string> = {
  "mode.full.warn":
    "AI สามารถรันคำสั่งใดก็ได้โดยไม่ถาม และมีสิทธิ์เท่ากับบัญชี Windows ของคุณ",
  "approve.expiry":
    "หมดเวลาแล้วจะไม่รันคำสั่งนี้",
  "confirm.type":
    'พิมพ์ "ยืนยัน" เพื่อดำเนินการต่อ',
  "notify.approval.title":
    "WinHelm ต้องการการอนุมัติ",
  "notify.approval.body":
    "มีคำสั่งจาก AI รอการอนุมัติของคุณใน WinHelm",
  "notify.approval.action":
    "เปิด WinHelm",
  "dashboard.admin.locked":
    "ล็อกอยู่ · ต้องใช้รหัสผู้ดูแลในเครื่อง",
  "dashboard.admin.unlocked":
    "ปลดล็อกแล้ว · เซสชันผู้ดูแลในเครื่อง",
  "dashboard.admin.instructions":
    "รัน winhelm admin-code ในเทอร์มินัลบนเครื่องนี้ แล้วกรอกรหัสใช้ครั้งเดียวที่นี่ รหัสผู้ดูแลแยกจากรหัส MCP และห้ามวางรหัสลงในแชต AI",
  "dashboard.admin.placeholder":
    "รหัสผู้ดูแลใช้ครั้งเดียว",
  "dashboard.admin.unlock":
    "ปลดล็อก",
  "dashboard.admin.code_hint":
    'กรอกรหัสใช้ครั้งเดียวจาก "winhelm admin-code"',
  "dashboard.admin.loading":
    "ปลดล็อกแล้ว กำลังโหลดสิทธิ์ปัจจุบัน…",
  "dashboard.approvals.title":
    "งานที่รออนุมัติ",
  "dashboard.approvals.note":
    "งานที่รออนุมัติดูได้เฉพาะในเครื่องนี้ และอาร์กิวเมนต์แสดงเป็นข้อความเท่านั้น ไม่เรนเดอร์เป็น HTML/Markdown",
  "dashboard.approvals.empty":
    "ไม่มีงานที่รออนุมัติ",
  "dashboard.approvals.approve":
    "อนุมัติ",
  "dashboard.approvals.deny":
    "ปฏิเสธ",
  "dashboard.approvals.arguments":
    "อาร์กิวเมนต์",
  "dashboard.approvals.folders":
    "โฟลเดอร์",
  "dashboard.approvals.noFolder":
    "ไม่ตรงกับโฟลเดอร์ใด",
  "dashboard.approvals.provenance":
    "กิจกรรมล่าสุดของเซสชัน",
  "dashboard.approvals.showPreview":
    "ดูตัวอย่างข้อความ",
  "dashboard.approvals.hidePreview":
    "ซ่อนตัวอย่างข้อความ",
  "dashboard.clients.title":
    "ไคลเอนต์ MCP ที่เชื่อมต่อ",
  "dashboard.clients.note":
    "ชื่อไคลเอนต์มาจากตัวไคลเอนต์ที่เชื่อมต่อ และแสดงเป็นข้อความเท่านั้น",
  "dashboard.clients.empty":
    "ยังไม่มี session ที่แจ้ง clientInfo",
  "dashboard.clients.loading":
    "กำลังโหลด…",
  "dashboard.token.title":
    "โทเคนสำหรับเชื่อมต่อ MCP",
  "dashboard.token.note":
    "การหมุนจะเปลี่ยน bearer token ทันที ไคลเอนต์ที่ยังใช้โทเคนเดิมจะล้มเหลวในคำขอถัดไป ส่วนคุกกี้เซสชันของ Dashboard ที่ออกไว้ก่อนหน้าจะยังใช้ได้ไม่เกิน 15 นาที",
  "dashboard.token.rotate":
    "หมุนโทเคน",
  "dashboard.token.confirm":
    "หมุนโทเคน MCP ตอนนี้หรือไม่? โทเคนเดิมจะใช้ไม่ได้ทันที",
  "dashboard.token.loading":
    "กำลังหมุนโทเคน…",
  "dashboard.token.new":
    "โทเคนใหม่ (แสดงครั้งเดียว) — คัดลอกไปตั้งค่าในไคลเอนต์ MCP:",
  "dashboard.token.once":
    "จะไม่แสดงอีก ควรเก็บในโปรแกรมจัดการรหัสผ่าน ไม่ใช่ในแชตนี้",
  "dashboard.teach.title":
    "ทดลองและสอน AI ของคุณ",
  "dashboard.teach.intro":
    "ลองพิมพ์ประโยคตัวอย่างเหล่านี้ในแอป AI แล้วดู Activity & Execution Stream ด้านล่างของหน้านี้จนเห็นการเรียกที่สำเร็จครั้งแรก",
  "dashboard.teach.examples":
    "ประโยคตัวอย่าง",
  "dashboard.teach.example1":
    "ใช้ WinHelm ลิสต์ไฟล์ในโฟลเดอร์ workspace ของฉัน",
  "dashboard.teach.example2":
    "ใช้ WinHelm อ่าน 20 บรรทัดแรกของไฟล์ log ในเครื่องของฉัน",
  "dashboard.teach.instructions":
    "คำแนะนำสำหรับ AI",
  "dashboard.teach.instructionText":
    "เมื่อฉันพูดถึงไฟล์ โปรแกรม หรือโพรเซสในคอมพิวเตอร์ของฉัน ให้ใช้เครื่องมือ WinHelm ซึ่งทำงานบน Windows เครื่องจริงของฉัน ไม่ใช่ sandbox และถ้าผลลัพธ์มี userAction ให้บอกฉันตามนั้น ห้ามหาทางเลี่ยง",
  "dashboard.teach.claudeTip":
    "Claude Desktop อาจตอบจาก sandbox ของตัวเองแทน WinHelm จากการวัดหนึ่งครั้ง มี 0 จาก 6 prompt ปกติที่ไปถึง WinHelm ส่วน prompt ที่ระบุ \"ใช้ mcp\" ชัดเจนไปถึง 1 จาก 1 เมื่อใช้ full schema การเติม \"ใช้ mcp\" หรือ \"ผ่าน WinHelm\" จึงควรลอง แต่ไม่ใช่การรับประกัน",
  "dashboard.teach.sandboxHint":
    "ถ้า AI ยังตอบจาก sandbox ลองปิดตัวเลือก \"Code execution and file creation\" ในการตั้งค่าแอปนั้น นี่เป็นข้อสังเกตจากการทดสอบ ไม่ใช่การรับประกัน",
  "dashboard.teach.copy":
    "คัดลอก",
  "dashboard.teach.copied":
    "คัดลอกแล้ว",
  "dashboard.teach.copyFailed":
    "คัดลอกไม่สำเร็จ — เลือกข้อความแล้วคัดลอกเอง",

  "action.folder.readwrite":
    "เลือกโฟลเดอร์ที่อนุญาตให้อ่านและเขียน หรือเปลี่ยนสิทธิ์โฟลเดอร์ใน WinHelm",
  "action.folder.allowed":
    "เลือก path ที่อยู่ภายในโฟลเดอร์ที่อนุญาตใน WinHelm",
  "action.path.alias":
    "ใช้ path เต็ม หรือ @alias/... โดยอ้างโฟลเดอร์ WinHelm ที่ตั้งค่าไว้",
  "action.safe.cwd":
    "เลือกโฟลเดอร์ WinHelm ที่อ่านและเขียนได้เป็น cwd หรือเปลี่ยนโหมด Terminal ในเครื่อง",
  "action.terminal.change":
    "เปลี่ยนโหมด Terminal ในการตั้งค่า WinHelm",
  "action.terminal.safe_command":
    "ใช้ command_run สำหรับ package manager ที่รองรับ หรือเปลี่ยนโหมด Terminal ในเครื่อง",
  "action.approve.command":
    "อนุมัติคำสั่งนี้ใน WinHelm",
  "action.approve.terminal":
    "อนุมัติการทำงานผ่าน Terminal นี้ใน WinHelm",
  "action.tool.enable":
    "เปิดใช้เครื่องมือนี้ใน Permissions ของ WinHelm",
  "action.approve.generic":
    "อนุมัติการทำงานนี้ใน WinHelm",

  "action.approval.review_before_retry":
    "ตรวจรายละเอียดงานใน WinHelm ก่อนลองใหม่",
  "action.approval.denied":
    "อย่าลองใหม่ เว้นแต่ผู้ใช้จะขอให้ลองอีกครั้งอย่างชัดเจน",
  "action.approval.expired":
    "ถามผู้ใช้ว่าต้องการส่งคำขอนี้ใหม่หรือไม่",
  "action.approval.cancelled":
    "อย่าลองใหม่โดยอัตโนมัติ",
  "action.approval.use_status":
    "ใช้ winhelm_job_status แทนการเรียก tool เดิมซ้ำ",
  "action.approval.resolve_pending":
    "จัดการหรือปฏิเสธคำขออนุมัติ WinHelm ที่ค้างอยู่ก่อนลองใหม่",
  "action.approval.review_recent":
    "ตรวจงาน WinHelm ล่าสุดก่อนลองทำรายการนี้อีกครั้ง",
  "action.job.check_id":
    "ตรวจ jobId และอย่าใช้ jobId ที่มาจาก session อื่น",
  "action.job.review":
    "ตรวจงานใน WinHelm ก่อนลองใหม่",
  "action.config.repair":
    "เปิด WinHelm เพื่อแก้การตั้งค่าให้ถูกต้องก่อนลองใหม่",
  "action.command.allowed":
    "ใช้ executable แบบ direct ที่อนุญาต เปลี่ยนโหมด Terminal ในเครื่อง หรือใช้ terminal_run เมื่อต้องใช้ shell semantics",
  "action.network.target":
    "ใช้ปลายทางเครือข่ายที่อนุญาต หรือปรับการตั้งค่าเครือข่ายของ WinHelm เมื่อเหมาะสม",
  "action.error.review":
    "ตรวจรายละเอียดข้อผิดพลาด แล้วปรับคำขอหรือการตั้งค่า WinHelm ก่อนลองใหม่",

  "shell.title":
    "WinHelm | ศูนย์ควบคุม",
  "shell.nav.overview":
    "ภาพรวม",
  "shell.nav.access":
    "การเข้าถึง",
  "shell.nav.approvals":
    "การอนุมัติ",
  "shell.nav.activity":
    "กิจกรรม",
  "shell.nav.connections":
    "การเชื่อมต่อ",
  "shell.nav.settings":
    "การตั้งค่า",
  "shell.nav.advanced":
    "ขั้นสูง / การวินิจฉัย",
  "shell.overview.status.running":
    "กำลังทำงาน",
  "shell.overview.status.stopped":
    "หยุดทำงาน",
  "shell.overview.profile.title":
    "โพรไฟล์ความสามารถ",
  "shell.overview.profile.modified":
    "ปรับแต่งเพิ่มเติม",
  "shell.overview.approval.title":
    "โหมดการอนุมัติ",
  "shell.overview.pending.title":
    "รายการรออนุมัติ",
  "shell.overview.connections.title":
    "การเชื่อมต่อไคลเอนต์",
  "shell.overview.legacy.banner":
    "กำลังใช้การกำหนดค่าแบบเดิม อัปเกรดเป็น schema v2 ในเมนูการเข้าถึงและการตั้งค่าเพื่อการบังคับใช้นโยบายที่ละเอียดขึ้น",
  "shell.overview.warnings.none":
    "ระบบกำลังทำงานตามขอบเขตและพารามิเตอร์ปกติ",
  "shell.access.title":
    "การเข้าถึงโฟลเดอร์และนโยบายเทอร์มินัล",
  "shell.access.folders.title":
    "โฟลเดอร์เวิร์กสเปซที่ได้รับอนุมัติ",
  "shell.access.folders.empty":
    "ยังไม่ได้ระบุโฟลเดอร์เวิร์กสเปซเฉพาะ",
  "shell.access.folders.read":
    "อ่านอย่างเดียว",
  "shell.access.folders.readwrite":
    "อ่าน-เขียน",
  "shell.access.terminal.title":
    "การควบคุมเทอร์มินัล",
  "shell.access.terminal.safe_distinction":
    "หมายเหตุ: โพรไฟล์ Safe จำกัด schema เครื่องมือที่แสดง ส่วนโหมดเทอร์มินัลควบคุมความปลอดภัยในการรันคำสั่ง",
  "shell.access.preview":
    "ดูตัวอย่างการเปลี่ยนแปลงสิทธิ์",
  "shell.access.save":
    "บันทึกการเปลี่ยนแปลงสิทธิ์",
  "shell.approvals.title":
    "รายการที่รอการอนุมัติ",
  "shell.approvals.empty":
    "ไม่มีคำขอที่รอการอนุมัติ",
  "shell.approvals.approve":
    "อนุมัติ",
  "shell.approvals.deny":
    "ปฏิเสธ",
  "shell.approvals.client":
    "ไคลเอนต์",
  "shell.approvals.tool":
    "เครื่องมือ",
  "shell.approvals.risk":
    "ความเสี่ยง",
  "shell.approvals.target":
    "เป้าหมาย",
  "shell.approvals.details":
    "รายละเอียด",
  "shell.approvals.preview":
    "ดูตัวอย่างข้อความ",
  "shell.approvals.once":
    "การตัดสินใจมีผลและทำงานเพียงครั้งเดียวตามลำดับ",
  "shell.activity.title":
    "กิจกรรมล่าสุด",
  "shell.activity.empty":
    "ยังไม่มีกิจกรรมที่บันทึกไว้",
  "shell.activity.filter.all":
    "ทั้งหมด",
  "shell.activity.filter.tools":
    "เครื่องมือ",
  "shell.activity.filter.security":
    "ความปลอดภัย",
  "shell.activity.filter.errors":
    "ข้อผิดพลาด",
  "shell.activity.advanced_hint":
    "สามารถดูข้อมูลการทำงานเชิงลึกและล็อกดิบได้ที่ ขั้นสูง / การวินิจฉัย",
  "shell.connections.title":
    "การเชื่อมต่อไคลเอนต์",
  "shell.connections.claude.label":
    "Claude Desktop",
  "shell.connections.claude.type":
    "ระดับหนึ่ง (First-Class)",
  "shell.connections.cursor.label":
    "Cursor",
  "shell.connections.cursor.type":
    "ระดับหนึ่ง (First-Class)",
  "shell.connections.chatgpt.label":
    "ChatGPT / OpenAI Tunnel",
  "shell.connections.chatgpt.type":
    "เป้าหมายระดับหนึ่ง (First-Class Target)",
  "shell.connections.tailscale.label":
    "Tailscale HTTPS /mcp",
  "shell.connections.tailscale.type":
    "ขั้นสูง / กำหนดเอง (Advanced/Manual)",
  "shell.connections.configure":
    "กำหนดค่า",
  "shell.connections.connected":
    "เชื่อมต่อแล้ว",
  "shell.connections.not_connected":
    "ไม่ได้เชื่อมต่อ",
  "shell.settings.title":
    "การตั้งค่า",
  "shell.settings.profile":
    "โพรไฟล์ความสามารถ",
  "shell.settings.approval_mode":
    "โหมดการอนุมัติ",
  "shell.settings.language":
    "ภาษา",
  "shell.settings.token":
    "โทเค็นการเข้าถึง",
  "shell.settings.dangerous_notice":
    "ไม่อนุญาตให้เลือกโหมดเทอร์มินัล Dangerous ในการตั้งค่าปกติ หากจำเป็นต้องใช้ให้ไปที่แดชบอร์ดขั้นสูง",
  "shell.settings.save":
    "บันทึกการตั้งค่า",
  "shell.admin.required":
    "จำเป็นต้องปลดล็อกสิทธิ์ผู้ดูแล",
  "shell.admin.hint":
    "รัน 'winhelm admin-code' ในเทอร์มินัล แล้วใส่รหัสที่ได้รับที่นี่",
  "shell.admin.placeholder":
    "ใส่รหัสผู้ดูแลแบบใช้ครั้งเดียว",
  "shell.admin.unlock":
    "ปลดล็อก",
  "shell.admin.status_unlocked":
    "ปลดล็อกผู้ดูแลแล้ว",
  "shell.admin.status_locked":
    "อ่านอย่างเดียว (ล็อกอยู่)",
  "shell.nav.setup":
    "การตั้งค่าเริ่มต้น",
  "shell.setup.title":
    "การตั้งค่าแบบแนะนำ",
  "shell.setup.desc":
    "ทำการตั้งค่าครั้งแรกให้เสร็จโดยไม่ต้องแก้ไฟล์ JSON เอง รายการนี้อ่านสถานะจาก backend จริงเสมอ",
  "shell.setup.recheck":
    "ตรวจสถานะอีกครั้ง",
  "shell.setup.locked":
    "ปลดล็อกเซสชันผู้ดูแล (มุมขวาบน) เพื่อโหลดสถานะการตั้งค่าจริง",
  "shell.setup.step.workspace":
    "โฟลเดอร์เวิร์กสเปซ",
  "shell.setup.step.profile":
    "โพรไฟล์ความสามารถ",
  "shell.setup.step.approval":
    "โหมดการอนุมัติ",
  "shell.setup.step.client":
    "เชื่อมต่อ Claude Desktop หรือ Cursor",
  "shell.setup.step.observe":
    "การสังเกตการเชื่อมต่อ",
  "shell.setup.step.first_action":
    "การใช้งานปลอดภัยครั้งแรก",
  "shell.setup.step.orientation":
    "ส่วนต่าง ๆ อยู่ที่ไหน",
  "shell.setup.status.complete":
    "ครบถ้วน",
  "shell.setup.status.incomplete":
    "ยังไม่ครบถ้วน",
  "shell.setup.status.configured":
    "กำหนดค่าแล้ว",
  "shell.setup.status.needs_configuration":
    "ต้องกำหนดค่า",
  "shell.setup.status.attention":
    "ต้องตรวจสอบ",
  "shell.setup.status.active":
    "ตรวจพบเซสชันที่ใช้งานอยู่",
  "shell.setup.status.not_observed":
    "ยังไม่พบเซสชันที่ใช้งานอยู่",
  "shell.setup.current":
    "ปัจจุบัน",
  "shell.setup.open_access":
    "เปิดหน้าการเข้าถึง",
  "shell.setup.open_settings":
    "เปิดหน้าการตั้งค่า",
  "shell.setup.open_connections":
    "เปิดหน้าการเชื่อมต่อ",
  "shell.setup.open_approvals":
    "เปิดหน้าการอนุมัติ",
  "shell.setup.open_activity":
    "เปิดหน้ากิจกรรม",
  "shell.setup.first_action.body":
    "ในไคลเอนต์ที่เชื่อมต่อแล้ว ลองสั่งว่า \u201cใช้ WinHelm ลิสต์ไฟล์ในโฟลเดอร์เวิร์กสเปซของฉัน\u201d ข้อความนี้เป็นคำแนะนำเท่านั้น เบราว์เซอร์ไม่เรียกเครื่องมือ MCP เอง",
  "shell.setup.orientation.body":
    "อนุมัติหรือปฏิเสธการทำงานที่รออยู่ในหน้าการอนุมัติ และตรวจทุกการเรียกเครื่องมือรวมถึงเหตุการณ์ด้านความปลอดภัยในหน้ากิจกรรม",
  "shell.connections.restart_hint":
    "หากไคลเอนต์นี้เปิดค้างอยู่ ให้รีสตาร์ตหรือเชื่อมต่อใหม่เพื่อโหลดการกำหนดค่าใหม่",
};

export const MESSAGE_CATALOGS: Record<
  SupportedLocale,
  Record<MessageKey, string>
> = {
  en: EN_MESSAGES,
  th: TH_MESSAGES,
};

export function resolveLocale(input?: string | null): SupportedLocale {
  const value = (input ?? "").trim().toLowerCase();
  if (value === "th" || value.startsWith("th-")) return "th";
  if (value === "en" || value.startsWith("en-")) return "en";
  return "en";
}

let configuredLocale: SupportedLocale = "en";

export function setConfiguredLocale(input?: string | null): SupportedLocale {
  configuredLocale = resolveLocale(input);
  return configuredLocale;
}

export function getRuntimeLocale(): SupportedLocale {
  return process.env.WINHELM_LOCALE
    ? resolveLocale(process.env.WINHELM_LOCALE)
    : configuredLocale;
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
    .map((match) => match[1])
    .sort();
}

export function translate(
  key: MessageKey,
  vars: Record<string, string | number> = {},
  locale: SupportedLocale = getRuntimeLocale()
): string {
  const template =
    MESSAGE_CATALOGS[locale]?.[key] ??
    EN_MESSAGES[key];

  return template.replace(
    /\{([a-zA-Z0-9_]+)\}/g,
    (_match, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name])
        : `{${name}}`
  );
}

export function validateI18nCatalogs(): string[] {
  const issues: string[] = [];
  const englishKeys = Object.keys(EN_MESSAGES).sort();
  const thaiKeys = Object.keys(TH_MESSAGES).sort();

  if (JSON.stringify(englishKeys) !== JSON.stringify(thaiKeys)) {
    issues.push("th/en key sets differ");
  }

  for (const key of englishKeys as MessageKey[]) {
    const en = EN_MESSAGES[key];
    const th = TH_MESSAGES[key];

    if (!en?.trim()) issues.push(`empty en message: ${key}`);
    if (!th?.trim()) issues.push(`empty th message: ${key}`);

    const enPlaceholders = placeholders(en);
    const thPlaceholders = placeholders(th);
    if (
      JSON.stringify(enPlaceholders) !==
      JSON.stringify(thPlaceholders)
    ) {
      issues.push(
        `placeholder mismatch: ${key} en=[${enPlaceholders.join(",")}] th=[${thPlaceholders.join(",")}]`
      );
    }
  }

  return issues;
}
