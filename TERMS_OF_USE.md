# WinHelm MCP Terms of Use & Security Disclaimer
# ข้อกำหนดการใช้งานและข้อจำกัดความรับผิดชอบด้านความปลอดภัย

**Last Updated / ปรับปรุงล่าสุด:** September 2026  
**License / สัญญาอนุญาต:** MIT License  

---

## 🇹🇭 ภาษาไทย (Thai Version)

### 1. บทนำและขอบเขต (Introduction & Scope)
WinHelm MCP เป็นซอฟต์แวร์โอเพนซอร์สที่ออกแบบมาเพื่อเชื่อมโยงความสามารถของโมเดลปัญญาประดิษฐ์ (AI Orchestrators / LLMs) เข้ากับการควบคุมและสั่งการระบบปฏิบัติการ Windows ผ่านโพรโทคอล Model Context Protocol (MCP)

การดาวน์โหลด, ติดตั้ง, หรือเปิดใช้งาน WinHelm MCP ถือว่าท่านยอมรับข้อกำหนดและเงื่อนไขทั้งหมดในเอกสารนี้

---

### 2. โมเดลความรับผิดชอบร่วมกัน (Shared Responsibility Model)
ความปลอดภัยของระบบเมื่อเชื่อมต่อกับปัญญาประดิษฐ์เป็นความรับผิดชอบร่วมกันระหว่างกลไกป้องกันของ WinHelm และการกำหนดค่าของผู้ดูแลระบบ:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   SHARED RESPONSIBILITY MATRIX                         │
├───────────────────────────────────┬────────────────────────────────────┤
│   ความรับผิดชอบของ WinHelm MCP    │  ความรับผิดชอบของผู้ดูแลระบบ / ผู้ใช้  │
├───────────────────────────────────┼────────────────────────────────────┤
│ ✔ กลไก Fail-Closed ป้องกันไดรฟ์ระบบ │ 🔹 การรักษาความลับของ authToken     │
│ ✔ Host Header Guard (DNS Rebinding│ 🔹 การเปิดพอร์ต / Tunneling ข้ามเน็ต │
│ ✔ การตรวจสอบ Path Traversal & UNC │ 🔹 สิทธิ์ของ Windows User ที่สั่งรัน   │
│ ✔ การซ่อน Credentials (Sanitizer) │ 🔹 การตรวจสอบคำสั่งก่อนให้ AI ทำงาน │
│ ✔ Ephemeral Session Cookie (15m)  │ 🔹 การตัดสินใจเปิดใช้ --system-exec   │
│ ✔ Audit Logging (logs/audit.log)  │ 🔹 การสำรองข้อมูลสำคัญในเครื่อง       │
└───────────────────────────────────┴────────────────────────────────────┘
```

1. **ความรับผิดชอบของผู้ดูแลระบบ (Administrator Responsibilities):**
   - **การตั้งค่าความปลอดภัยเครือข่าย:** หากเปิดการเชื่อมต่อผ่านอินเทอร์เน็ตสาธารณะ หรือใช้ Reverse Proxy / Cloudflare Tunnel / Tailscale Funnel ผู้ดูแลระบบ**ต้อง**กำหนดค่า `authToken` เสมอ และห้ามเปิดเผย Token สู่สาธารณะ
   - **หลักการสิทธิ์ขั้นต่ำ (Least Privilege):** ควรเปิดใช้งาน WinHelm ภายใต้ Windows User Account ทั่วไป หลีกเลี่ยงการเปิดใช้งานในฐานะ Local Administrator หรือ Domain Admin หากไม่จำเป็น
   - **การเปิดโหมดพิเศษ (`--system-exec` และ `allowedDirectories: ["*"]`):** ผู้ใช้งานรับทราบว่าการเปิดแฟล็กเหล่านี้เป็นการจงใจปลดล็อคข้อจำกัดเพื่อความสะดวกในการทำงาน ซึ่งผู้ใช้ต้องยอมรับความเสี่ยงด้วยตนเอง

2. **ความรับผิดชอบของ WinHelm (WinHelm Capabilities):**
   - WinHelm มีหน้าที่นำเสนอและบังคับใช้มาตรการป้องกันเชิงลึก (Defense-in-Depth) ตามที่ระบุไว้ใน [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)

---

### 3. การปฏิเสธการรับประกันและข้อจำกัดความรับผิด (Disclaimer & Limitation of Liability)
1. **ตามสภาพ ("AS IS"):** ซอฟต์แวร์นี้จัดทำขึ้นและส่งมอบ "ตามสภาพที่เป็นอยู่" (AS IS) ปราศจากการรับประกันในรูปแบบใดๆ ไม่ว่าโดยชัดแจ้งหรือโดยปริยาย
2. **ไม่มีความปลอดภัยที่สมบูรณ์ 100% (No Absolute Immunity):** ไม่มีระบบคอมพิวเตอร์ใดในโลกที่สามารถการันตีความปลอดภัยได้อย่างสมบูรณ์แบบต่อการโจมตีรูปแบบใหม่หรือความผิดพลาดในการตั้งค่าของผู้ใช้งาน
3. **การจำกัดความรับผิด:** ผู้พัฒนาและผู้มีส่วนร่วมในการพัฒนา WinHelm MCP จะไม่รับผิดชอบต่อความเสียหายใดๆ ทั้งทางตรง ทางอ้อม อุบัติเหตุ หรือผลสืบเนื่อง (รวมถึงแต่ไม่จำกัดเพียง การสูญหายของข้อมูล, ความเสียหายต่อระบบไฟล์, การหยุดชะงักทางธุรกิจ หรือการเข้าถึงโดยไม่ได้รับอนุญาต) ที่เกิดขึ้นจากการใช้งานหรือความไม่สามารถใช้งานซอฟต์แวร์นี้

---

## 🇬🇧 English Version

### 1. Introduction & Acceptance
WinHelm MCP is an open-source tool suite bridging Artificial Intelligence orchestrators with Windows operating system environments via the Model Context Protocol (MCP). By installing, downloading, or running WinHelm MCP, you agree to be bound by these terms.

---

### 2. Shared Responsibility Model
Operating an agentic interface safely requires a shared security partnership:

1. **WinHelm MCP's Scope of Responsibility:**
   - Enforcing fail-closed containment policies by default (`allowSystemExecution: false`).
   - Mitigating cross-origin DNS Rebinding attacks via strict Host header validation.
   - Defeating path traversal, UNC escapes, and symlink bypasses via canonical filesystem resolution.
   - Redacting secrets and tokens from console, logs, and outputs.
   - Enforcing ephemeral session lifecycles (15-minute sliding window) and timing-safe authentication.
   - Maintaining append-only structured audit logs (`logs/audit.log`).

2. **Administrator & Operator Scope of Responsibility:**
   - **Credential Hygiene:** Generating cryptographically strong `authToken` strings and preventing secret leakage in source control or public forums.
   - **Ingress Security:** Ensuring that public network exposure (via tunnels, port forwarding, or proxies) is strictly authenticated.
   - **Execution Context:** Running the application under least-privilege non-administrator Windows service accounts.
   - **Informed Consent for Overrides:** Explicitly accepting the security implications when opting into `--system-exec` or `allowedDirectories: ["*"]`.
   - **Backup & Recovery:** Maintaining regular, verified backups of critical data before granting autonomous file mutation capabilities to AI models.

---

### 3. Warranty Disclaimer & Limitation of Liability
1. **"AS IS" Provision:** The software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement.
2. **No Absolute Security:** No software or security architecture is completely impenetrable. Defensive mitigations reduce attack surfaces but do not substitute for comprehensive system hardening.
3. **Limitation of Liability:** In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

---

### 4. Prohibited Uses
You agree NOT to use WinHelm MCP to:
- Deploy, stage, or execute malicious software or unauthorized penetration tests on computers or networks without express written authorization from the system owner.
- Violate any applicable local, state, national, or international computer crime laws.
