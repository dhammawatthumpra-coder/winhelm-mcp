# WinHelm MCP — Real-World Agent Workflows & Use Cases

This guide demonstrates concrete workflows for LLM coding agents (e.g. Claude Desktop, Cursor, Cline, Windsurf) using WinHelm tools across different profiles.

---

## Use Case 1: Autonomous Build, Test, and Self-Healing
**Recommended Profile:** `dev` (28 tools)

When an AI agent needs to compile a large project, monitor progress in the background, and fix build errors without blocking the conversation:

### Step 1: Start background build task
The agent starts the build asynchronously:

**Tool:** `terminal_task_start`
```json
{
  "command": "npm run build",
  "cwd": "D:\\Projects\\MyWebApp"
}
```
*WinHelm returns Task ID `a4f891b2` immediately.*

### Step 2: Poll live progress
The agent checks progress after 3 seconds:

**Tool:** `terminal_task_logs`
```json
{
  "task_id": "a4f891b2",
  "tail_lines": 15
}
```
*Output shows a TypeScript compilation error in `src/utils.ts:42`.*

### Step 3: Surgically fix the code
The agent patches the specific line without touching adjacent lines:

**Tool:** `file_edit`
```json
{
  "path": "D:\\Projects\\MyWebApp\\src\\utils.ts",
  "old_text": "const port = process.env.PORT || undefined;",
  "new_text": "const port = Number(process.env.PORT) || 8080;"
}
```

### Step 4: Verify test passes
The agent executes the test suite synchronously:

**Tool:** `terminal_run`
```json
{
  "command": "npm test",
  "cwd": "D:\\Projects\\MyWebApp"
}
```

---

## Use Case 2: System Health Inspection & Troubleshooting
**Recommended Profile:** `sysadmin` (37 tools)

When an AI agent is asked: *"Why is my Windows computer sluggish or why did my application crash?"*

### Step 1: Check hardware utilization
**Tool:** `system_info`
```json
{}
```
*Returns CPU utilization %, RAM usage (Total/Used/Free), OS version, and allowed drive capacities.*

### Step 2: Query GPU telemetry
**Tool:** `gpu_info`
```json
{}
```
*Returns NVIDIA GPU name, driver version, temperature, and VRAM utilization.*

### Step 3: Identify resource-heavy processes
**Tool:** `process_list`
```json
{
  "sort_by": "memory",
  "limit": 10
}
```
*Returns top 10 processes sorted by RAM usage.*

### Step 4: Query Windows Event Log for crashes
**Tool:** `eventlog_query`
```json
{
  "log_name": "Application",
  "level": "Error",
  "limit": 5
}
```
*Identifies exact exception codes, faulted module names, and crash timestamps.*

### Step 5: Notify the developer
**Tool:** `notification_send`
```json
{
  "title": "WinHelm Diagnostic Complete",
  "message": "Found memory leak in rogue node.exe process (PID 4120). Recommending process_kill.",
  "sound": true
}
```

---

## Use Case 3: Code Search & Automated PDF Report
**Recommended Profile:** `dev` (28 tools) or `full` (38 tools)

When an agent performs an audit and generates a client-ready PDF document:

### Step 1: High-speed code search across project
**Tool:** `file_search_ripgrep`
```json
{
  "query": "TODO|FIXME|SECURITY",
  "path": "D:\\mcp\\winhelm-mcp",
  "page_size": 20
}
```

### Step 2: Write markdown report
**Tool:** `file_write`
```json
{
  "path": "D:\\AuditReport.md",
  "content": "# Codebase Audit Report\n\nFound 3 unresolved TODOs in codebase..."
}
```

### Step 3: Compile report to PDF using native Chromium
**Tool:** `pdf_generate`
```json
{
  "source_path": "D:\\AuditReport.md",
  "pdf_path": "D:\\AuditReport.pdf",
  "title": "Security & Code Audit Report"
}
```
*Generates formatted, print-ready PDF using headless Microsoft Edge or Google Chrome.*

---

## Use Case 4: Safe File Operations & Archival
**Recommended Profile:** `dev` (25 tools) or `core` (15 tools)

Safe file management that avoids accidental permanent loss:

### Step 1: Zip backup before modifying
**Tool:** `archive_zip`
```json
{
  "source_dir": "D:\\Projects\\ImportantData",
  "zip_path": "D:\\Backups\\ImportantData-2026-09-27.zip"
}
```

### Step 2: Recycle old temporary files (safe delete)
**Tool:** `file_delete_safe`
```json
{
  "path": "D:\\Projects\\TempCache"
}
```
*Item is moved to Windows Recycle Bin where it can be restored if needed.*
