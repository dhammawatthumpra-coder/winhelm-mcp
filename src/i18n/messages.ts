export type SupportedLocale = "en" | "th";

export const EN_MESSAGES = {
  "mode.full.warn":
    "The AI can run any command without asking and has the same rights as your Windows account",
  "approve.expiry":
    "The command will not run after this expires",
  "confirm.type":
    'Type "confirm" to continue',

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
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;

export const TH_MESSAGES: Record<MessageKey, string> = {
  "mode.full.warn":
    "AI สามารถรันคำสั่งใดก็ได้โดยไม่ถาม และมีสิทธิ์เท่ากับบัญชี Windows ของคุณ",
  "approve.expiry":
    "หมดเวลาแล้วจะไม่รันคำสั่งนี้",
  "confirm.type":
    'พิมพ์ "ยืนยัน" เพื่อดำเนินการต่อ',

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
