# WinHelm — Windows Native MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-blue.svg)](https://microsoft.com/windows)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-95%2F95%20passing-success.svg)]()
[![Protocol](https://img.shields.io/badge/MCP-1.9.0-purple.svg)](https://modelcontextprotocol.io/)

> **WinHelm MCP** — *The helm for your Windows workspace.*  
> A lightweight, production-grade Windows Native Model Context Protocol (MCP) server featuring a built-in Single-Process Web Gateway (Streamable HTTP `/mcp` + Server-Sent Events `/sse`), Real-Time Web Monitor Dashboard, 38 System Tools with Dynamic Profile Loading, and MCP File Preview Resource.

[📖 Tools Reference](docs/TOOLS.md) • [⚙️ Tool Profiles](docs/PROFILES.md) • [🛡️ Security Architecture](docs/SECURITY.md) • [💡 Agent Examples](docs/EXAMPLES.md) • [📝 Changelog](CHANGELOG.md) • [🤝 Contributing](CONTRIBUTING.md)

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [System Requirements](#system-requirements)
- [Architecture & Live Dashboard](#architecture--live-dashboard)
- [Quick Start](#quick-start)
- [Tool Profiles ("Load Only What You Need")](#tool-profiles-load-only-what-you-need)
- [Client Configuration](#client-configuration)
  - [Claude Desktop](#1-claude-desktop-claude_desktop_configjson)
  - [Cursor IDE](#2-cursor-ide)
  - [ChatGPT & OpenAI MCP Tunnel](#3-chatgpt--openai-mcp-tunnel-tunnel-client)
  - [Remote & Tailscale Connection](#4-remote--tailscale-connection)
- [Tools Overview (38 Tools)](#tools-overview-38-tools)
- [MCP Resources & Web Endpoints](#mcp-resources--web-endpoints)
- [Configuration & Environment Variables](#configuration--environment-variables)
- [Standalone Executable (`winhelm.exe`)](#standalone-executable-winhelmexe)
- [Documentation & Deep Dive](#documentation--deep-dive)
- [License](#license)

---

## Overview

**WinHelm** bridges the gap between AI assistants (Claude, Cursor, LibreChat, ChatGPT) and the Windows operating system. Unlike generic cross-platform servers, WinHelm is built from the ground up for Windows with:

- **Zero Gateway Overhead:** Native single-process Web Gateway supporting both modern Streamable HTTP (`/mcp`) and standard Server-Sent Events (`/sse`). No external proxy (`supergateway` or reverse proxy) required.
- **Safety First:** Accidental deletions go to the **Windows Recycle Bin** instead of permanent destruction. Dangerous commands (`format-volume`, `rmdir /s /q c:\`) are strictly blocked by default.
- **First-class Windows Integrations:** NVIDIA/WMI GPU telemetry, Windows Services management, native UTF-8 PowerShell runner, and headless Microsoft Edge PDF compilation.

---

## Key Features

1. **All-in-One Gateway & Web Monitor:**
   - **Streamable HTTP:** `http://<HOST>:8788/mcp` (Modern MCP standard)
   - **SSE Stream & POST:** `http://<HOST>:8788/sse` and `/message`
   - **Web Monitor Dashboard:** `http://<HOST>:8788/` (Interactive metrics, sessions, drives, memory, GPU, and live audit logs)
   - **Interactive File Viewer:** `http://<HOST>:8788/preview?path=...` (Rich Markdown & code viewer with syntax formatting)
   - **Health Check:** `http://<HOST>:8788/health`
2. **High-Observability Logging & Secret Masking:**
   - Microsecond execution timings with ANSI color-coded tags (`[HTTP]`, `[TOOL-START]`, `[TOOL-DONE]`, `[SECURITY]`).
   - Automatically sanitizes Bearer tokens, OpenAI/Anthropic/GitHub API keys (`sk-***`, `ghp_***`), and sensitive passwords before printing or writing logs.
3. **Background Daemon Task Engine:**
   - Execute long-running dev servers (`npm run dev`, `docker compose up`) as background tasks with detached PIDs, non-blocking logs streaming, and interactive stdin support.
4. **High-Performance Code Search (Ripgrep):**
   - Integrates `ripgrep` (`rg.exe`) for fast regex search with streaming pagination (`page`, `pageSize`, `hasMore`) to prevent context window overflow.
5. **Headless PDF Generation:**
   - Converts Markdown and HTML into clean PDF documents using pre-installed Microsoft Edge or Chrome without requiring heavy dependencies like Puppeteer.
6. **Tailscale & Remote Ready:**
   - Bind to `0.0.0.0` or Tailscale IP (`100.x.y.z`) with mandatory Bearer Token verification and rate limiting (120 req/min).

---

## System Requirements

| Component | Minimum Requirement | Recommended | Notes |
| :--- | :--- | :--- | :--- |
| **Operating System** | Windows 10 / 11 / Server 2019+ | Windows 11 (64-bit) | Native Win32 & PowerShell APIs |
| **Node.js** | Node.js >= 18.0.0 | Node.js 20+ LTS | Not required if using `dist/winhelm.exe` |
| **PowerShell** | Windows PowerShell 5.1 | PowerShell 7+ (pwsh) | Auto-detects pwsh with UTF-8 encoding |
| **PDF Engine** | Microsoft Edge | Pre-installed on Win 10/11 | Google Chrome is also auto-detected |
| **Search Engine** | Built-in recursive search | `ripgrep` (`rg.exe`) | Install via `winget install BurntSushi.ripgrep.MSVC` |
| **Privileges** | Standard User | Standard User | Administrator is only needed for `service:install` |

---

## Architecture & Dashboard

### System Architecture

```mermaid
flowchart TD
    Client["AI Client (Claude / Cursor / Remote)"]

    subgraph WinHelm["WinHelm Server (Port 8788)"]
        subgraph Gateway["Single-Process Unified Gateway"]
            MCP_HTTP["Streamable HTTP (/mcp)"]
            MCP_SSE["SSE Gateway (/sse, /message)"]
            Dashboard["Web Monitor (/ & /dashboard)"]
            PreviewUI["File Preview (/preview)"]
            Health["Health & Audit Export (/health, /api/monitor/*)"]
        end

        subgraph Security["Security & Governance"]
            AuthGuard["Bearer Token Authentication"]
            RateLimit["Rate Limiter (120 req/min)"]
            PathGuard["Allowed Directories Guard"]
            CmdGuard["Blocked Commands Guard"]
            Sanitizer["Secret Masking (API Keys / Passwords)"]
        end

        subgraph Engines["Core Engine Layer"]
            PSEngine["PowerShell UTF-8 Runner"]
            TaskEngine["Background Daemon Task Engine"]
            FSEngine["Filesystem & Safe Delete (Recycle Bin)"]
            SearchEngine["Ripgrep Streaming Engine"]
            PDFEngine["Edge / Chrome Headless PDF Engine"]
            SysEngine["System, GPU & Windows Services Inspector"]
        end
    end

    subgraph Windows["Windows Operating System"]
        Win32["Win32 Shell / Recycle Bin"]
        PowerShell["PowerShell CLI / Tasks"]
        WMI_NVIDIA["WMI & nvidia-smi Telemetry"]
        SCM["Windows Service Control Manager"]
    end

    Client <--> Gateway
    Gateway --> Security
    Security --> Engines
    Engines <--> Windows
```

### Web Monitor & Live Dashboard

Access the built-in real-time dashboard in your browser at `http://localhost:8788/`:

![WinHelm Live Dashboard](assets/dashboard.png)

#### Live Task Execution & Telemetry Streaming

![WinHelm Live Demo](assets/demo.gif)

#### Interactive File & Markdown Preview (`preview://file`)

Access syntax-highlighted code and rendered Markdown directly at `http://localhost:8788/preview?path=<filepath>`:

![WinHelm Interactive File Preview](assets/preview.png)

---

## Quick Start

### 1. Clone & Install

```powershell
git clone https://github.com/winhelm/winhelm-mcp.git
cd winhelm-mcp
npm install
npm run build
```

### 2. Start the Server

```powershell
# Start standard server on port 8788 (full profile)
npm start

# Or start with a lightweight profile for coding agents (dev) or small models (minimal)
node dist/index.js --profile dev

# Or customize port and bearer token via CLI flags
node dist/index.js --port 8788 --auth my-secret-token

# Or run in Read-Only mode (disallows file edits, deletions, and killing processes)
node dist/index.js --read-only
```

### 3. Verify Health Check

Visit `http://localhost:8788/health` in your browser. You should receive:
```json
{
  "status": "ok",
  "name": "winhelm-mcp",
  "version": "1.0.0",
  "readOnly": false,
  "uptime": 12.4
}
```

---

## Tool Profiles ("Load Only What You Need")

AI coding assistants perform much better when their context window isn't bloated with dozens of unneeded tool schemas. WinHelm implements a **Dynamic Profile System** so your agent sees only the tools it actually needs:

```powershell
# 1. Minimal Profile: 6 essential tools for small models (Haiku, Llama 8B, local LLMs)
winhelm --profile minimal

# 2. Core Profile: 15 essential tools (terminal, file read/write/edit/search/hash, process list, telemetry)
winhelm --profile core

# 3. Developer Profile: 28 tools (Core + background tasks, ripgrep, zip archives, HTTP requests, PDF reports, system open & file preview)
winhelm --profile dev

# 4. SysAdmin Profile: 37 tools (All Core + tasks, ripgrep, archives, services, event logs, network, process kill, desktop automation & preview — all except pdf_generate)
winhelm --profile sysadmin

# 5. Full Suite: All 38 tools + interactive preview resource (default)
winhelm --profile full
```

### Profile Inclusions

| Profile | Active Tools | Key Inclusions | Context Window Savings |
| :--- | :---: | :--- | :--- |
| **`minimal`** | **6** | `terminal_run`, `file_read`, `file_write`, `file_list`, `file_search`, `system_info` | 🟢 **~85% token reduction** |
| **`core`** | **15** | `terminal_run`, `file_read`, `file_write`, `file_edit`, `file_list`, `file_search`, `file_copy`, `file_move`, `file_tail`, `file_hash`, `file_delete_safe`, `system_info`, `gpu_info`, `process_list`, `port_check` | 🟢 **~60% token reduction** |
| **`dev`** | **28** | All Core + `terminal_task_*` (5 tasks), `file_search_ripgrep`, `archive_zip/unzip`, `http_ping/request`, `pdf_generate`, `system_open`, `preview://file` | 🟡 **~30% token reduction** |
| **`sysadmin`** | **37** | All tools except `pdf_generate`: Core + tasks, ripgrep, archives, services, event logs, network, process kill, desktop actions & preview | 🟠 Full Windows ops toolkit |
| **`full`** | **38** | All 38 tools + interactive HTML preview resource (default when omitted) | 🔵 Complete Windows control |

### Token Economics & Model Optimization

| Profile | Tools | Approx Context Tokens | Token Savings | Recommended Target Models & Use Cases |
| :--- | :---: | :---: | :---: | :--- |
| **`minimal`** | **6** | **~1,500** | 🟢 **−85%** | **Claude 3.5 Haiku, Llama 3 8B, local LLMs** or token-constrained pipelines |
| **`core`** | **15** | **~4,000** | 🟢 **−60%** | Everyday coding & file operations without background processes |
| **`dev`** | **28** | **~6,800** | 🟡 **−32%** | **Claude 3.7 Sonnet, GPT-4o, Cursor** full-stack software development |
| **`sysadmin`** | **37** | **~9,200** | 🟠 **−8%** | Headless server management, Windows DevOps, diagnostics & audit |
| **`full`** | **38** | **~10,000** | 🔵 **Baseline** | Complete Windows native desktop suite with PDF & HTML visual previews |

> **Pro Tip:** In `claude_desktop_config.json`, pass `["--profile", "dev"]` under `args` for software development, or `["--profile", "minimal"]` for Claude Haiku!

---

## Client Configuration

### 1. Claude Desktop (`claude_desktop_config.json`)

Path: `%APPDATA%\Claude\claude_desktop_config.json`

#### Option A: Remote / Local SSE Gateway (Recommended)
```json
{
  "mcpServers": {
    "winhelm": {
      "url": "http://127.0.0.1:8788/sse",
      "headers": {
        "Authorization": "Bearer my-secret-token"
      }
    }
  }
}
```

#### Option B: Direct Stdio / Node Process (Lightweight with Profile)
```json
{
  "mcpServers": {
    "winhelm": {
      "command": "node",
      "args": ["<PATH_TO_WINHELM>/dist/index.js", "--stdio", "--profile", "dev"],
      "env": {
        "MCP_ALLOWED_DIRECTORIES": "D:\\mcp,C:\\Projects"
      }
    }
  }
}
```
> **Context Optimization:** Supplying `"--profile", "dev"` restricts tools to 28 developer essentials, saving ~32% context tokens while preserving all coding, ripgrep, background task, PDF, archive, and preview capabilities.

#### Option C: Standalone Executable (`winhelm.exe`)
```json
{
  "mcpServers": {
    "winhelm": {
      "command": "<PATH_TO_WINHELM>\\dist\\winhelm.exe",
      "args": ["--stdio", "--profile", "dev"]
    }
  }
}
```

#### Option D: Per-Project Dedicated Config File (Isolated Profiles & Roots)
```json
{
  "mcpServers": {
    "winhelm-project-a": {
      "command": "winhelm",
      "args": ["--stdio", "--config", "D:\\mcp\\configs\\project-a.json"]
    }
  }
}
```
> **Multi-Instance Isolation:** Each project config file maintains its own isolated `allowedDirectories`, `profile`, and security rules without modifying the shared default `winhelm.config.json`. CLI overrides are session-only (`--no-persist` by default) to prevent instances from colliding.

---

### 2. Cursor IDE

In Cursor Settings (`Settings` -> `Features` -> `MCP` -> `Add new MCP server`):

- **Name:** `winhelm`
- **Type:** `sse`
- **URL:** `http://127.0.0.1:8788/sse`

*(If authentication is configured, add `"Authorization": "Bearer <YOUR_TOKEN>"` to the headers section).*

---

### 3. ChatGPT & OpenAI MCP Tunnel (`tunnel-client`)

WinHelm integrates seamlessly with OpenAI's official `tunnel-client` daemon, allowing ChatGPT to execute Windows commands, inspect files, and manage background tasks directly over a secure Cloudflare Tunnel:

#### Profile Configuration (`winhelm-mcp.yaml`)
```yaml
config_version: 1

control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "your-tunnel-id-here"
  api_key: "env:CONTROL_PLANE_API_KEY"

health:
  listen_addr: "127.0.0.1:18026"

admin_ui:
  open_browser: false

log:
  level: info
  format: json

mcp:
  commands:
    # Direct stdio connection with dev profile (~32% token savings for ChatGPT)
    - channel: main
      command: 'node D:/mcp/winhelm-mcp/dist/index.js --stdio --profile dev'
```

#### Running the Tunnel
```powershell
.\tunnel-client.exe run --profile-file winhelm-mcp.yaml
```
> **Purity Guard:** In `--stdio` mode, WinHelm routes all operational logs to `stderr`, leaving `stdout` purely for JSON-RPC messages to guarantee zero parsing errors on ChatGPT.

---

### 4. Remote & Tailscale Connection

WinHelm binds by default to `127.0.0.1` (localhost only). To allow secure cross-device access over private networks like Tailscale or WireGuard, bind to `0.0.0.0` or your Tailscale IP:

1. Retrieve your machine's Tailscale IP (e.g. `100.80.20.10`) or Tailscale Funnel domain (e.g. `https://your-node.ts.net`).
2. Start WinHelm with a strong token:
   ```powershell
   node dist/index.js --port 8788 --auth super-secure-token-here
   ```
3. Connect your mobile or remote Claude / Cursor / ChatGPT client:
   - **Streamable HTTP:** `http://100.80.20.10:8788/mcp`
   - **SSE Stream:** `http://100.80.20.10:8788/sse`
   - **Header:** `Authorization: Bearer super-secure-token-here`

#### Claude.ai Custom Connectors (URL Query Token)

Claude.ai Custom Connectors and certain web/mobile clients do not provide a UI field to enter custom HTTP headers (such as `Authorization: Bearer <token>`). WinHelm natively supports passing the authentication token directly via the URL query parameter:

- **Server URL:** `https://<your-tailnet-domain>.ts.net/mcp?token=<YOUR_AUTH_TOKEN>`
- **Authentication:** Select **`No sign-in`**
- **Transport (under Advanced):** Streamable HTTP (Default)

> 🔒 **Security Guarantee:** Passing the token in the URL query parameter still triggers full timing-safe cryptographic verification on the server, ensuring your Windows machine remains completely protected from unauthorized internet access without needing a complex OAuth setup.

---

## Tools Overview (38 Tools)

WinHelm provides 38 focused Windows native tools grouped across 6 functional categories. Each tool is loaded dynamically based on your active `--profile`:

| Category | Tools | In Profiles | Summary |
| :--- | :---: | :--- | :--- |
| **Terminal & Background Tasks** | 6 | `minimal` (run only), `core` (run only), `dev`, `sysadmin`, `full` | Synchronous PowerShell runner and detached daemon processes with live logs & stdin. |
| **Filesystem, Safe Delete & Archives** | 12 | `minimal` (read, write, list, search), `core` (10 tools), `dev` (all 12), `sysadmin` (all 12), `full` (all 12) | Surgical file edits, streaming tails, SHA-256 hashes, .NET zip archives, and **Recycle Bin safe delete**. |
| **Codebase Search, PDF & Preview** | 3 | `dev` (all 3), `sysadmin` (search & preview), `full` (all 3) | Streaming paginated `ripgrep` regex search (`query` parameter), headless Chromium PDF printer, and web previewer. |
| **Desktop, Clipboard & Toast** | 5 | `dev` (`system_open`), `sysadmin` (all 5), `full` (all 5) | Windows clipboard read/write, primary screen capture, system app launcher (`system_open`), and native Toast notifications. |
| **System, Processes & Services** | 9 | `minimal` (`system_info`), `core` (info, gpu, procs, port), `sysadmin` (all 9), `full` (all 9) | CPU/RAM/Drive telemetry, NVIDIA GPU stats, process list/kill, port inspector, event logs, and service control. |
| **Network & Connectivity** | 3 | `dev` (ping, req), `sysadmin` (all 3), `full` (all 3) | HTTP latency probe, full REST client (`http_request`), and local/Tailscale adapter inspector. |

📖 **See [docs/TOOLS.md](docs/TOOLS.md) for full parameter specifications, types, returns, and schemas.**

---

## MCP Resources & Web Endpoints

### MCP Resources

WinHelm exposes 1 dedicated Model Context Protocol resource:

| URI | MIME Type | Description |
| :--- | :--- | :--- |
| `preview://file` | `text/html;profile=mcp-app` | Dynamically renders rich HTML preview for Markdown and source code files with line numbers and syntax highlighting. |

---

### Gateway Web Endpoints

WinHelm hosts a full web application on a single port (default: `8788`):

- **`/` & `/dashboard`** — Real-time Web Monitor Dashboard (CPU, RAM, GPU, sessions, requests, live logs).
- **`/mcp`** — Streamable HTTP transport endpoint.
- **`/sse`** — Server-Sent Events transport endpoint for clients like Claude Desktop and Cursor.
- **`/message`** — POST endpoint for incoming JSON-RPC messages in SSE mode.
- **`/preview`** — Interactive browser file viewer (`/preview?path=D:\project\README.md`).
- **`/health`** — JSON health status and server uptime probe.
- **`/api/monitor/stats`** — JSON hardware and session statistics.
- **`/api/monitor/export?format=json|csv`** — Audit log export for security compliance.

---

## Configuration & Environment Variables

WinHelm loads configuration in the following order of precedence:
1. CLI Flags
2. Environment Variables
3. `winhelm.config.json`
4. Default settings

### Reference Table

| CLI Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--config <path>` | *N/A* | *auto* | Load configuration from a specific JSON file (for per-project multi-agent isolation). |
| `--stdio` | *N/A* | `false` | Run in standard I/O mode for local MCP clients (OpenAI tunnel-client, Claude, Cursor). |
| `--profile, -p <name>` | `WINHELM_PROFILE` | `full` | Tool profile to load: `minimal` (6), `core` (15), `dev` (28), `sysadmin` (37), or `full` (38). |
| `--tools <list>` | *N/A* | *auto* | Explicit comma-separated tools to load or `+tool`/`-tool` modifiers. |
| `--transport <type>` | `WINHELM_TRANSPORT` | `http` | Transport mode: `http` (Web Gateway + SSE) or `stdio`. |
| `--port <number>` | `PORT` | `8788` | Port number for the Web Gateway and MCP server. |
| `--host <string>` | `HOST` | `127.0.0.1` | Network interface to bind (`127.0.0.1` loopback default, `0.0.0.0` for LAN/Tailscale). |
| `--auth <token>` | `MCP_AUTH_TOKEN` | *none* | Bearer token for authentication. Rejects unauthenticated requests with HTTP 401. |
| `--read-only` | `MCP_READ_ONLY` | `false` | Enables read-only mode (blocks file writing, safe deletion, process killing, and service changes). |
| `--allowed-dirs <list>`| `MCP_ALLOWED_DIRECTORIES` | `[]` *(all)* | Comma-separated directory paths permitted for file access (e.g. `"D:\mcp,C:\Workspace"`). |
| `--no-persist` | *N/A* | `true` | Keep CLI overrides session-only without writing to `winhelm.config.json` (default). |
| `--persist` | *N/A* | `false` | Persist CLI overrides back to the active configuration file. |
| *N/A* | `MCP_BLOCKED_COMMANDS` | *(see below)* | Additional comma-separated commands to block from execution. |

### `winhelm.config.json`

Create or modify `winhelm.config.json` in your project root or `%USERPROFILE%\.winhelm\config.json`:

```json
{
  "blockedCommands": [
    "format-volume",
    "format-disk",
    "clear-disk",
    "stop-computer",
    "restart-computer",
    "rmdir /s /q c:\\",
    "del /f /s /q c:\\"
  ],
  "allowedDirectories": ["D:\\mcp", "C:\\Workspace"],
  "allowSystemExecution": true,
  "profile": "dev",
  "fileReadLineLimit": 2000,
  "defaultTimeoutMs": 60000,
  "telemetryEnabled": false,
  "authToken": null,
  "readOnly": false,
  "rateLimitWindowMs": 60000,
  "rateLimitMaxRequests": 120
}
```

> **Fail-Closed Security & Allowed Directories:** `allowedDirectories: []` blocks all filesystem operations by default for safety. You must explicitly configure target paths (e.g. `["D:\\mcp", "C:\\Workspace"]`).  
> **Whole-Drive Whitelist Tip:** You can supply `"D:\\"`, `"D:"`, or `"D"` in `allowedDirectories` to permit access to an entire volume safely.  
> **Wildcard Full-Drive Access (`["*"]`):** To permit access across all drives on your machine for personal development, supply `["*"]` or `["all"]`. ⚠️ **Security Warning:** Wildcard full access (`["*"]`) is strictly discouraged for unauthenticated or public-facing network exposures.

---

## Windows Background Service (Always-On Daemon)

WinHelm includes a built-in service manager using Windows Task Scheduler to run reliably in the background across system reboots:

```powershell
# Install as a persistent Windows Service (Run PowerShell as Administrator)
npm run service:install

# Check service status
npm run service:status

# Stop / Start the service
npm run service:stop
npm run service:start

# Uninstall the service
npm run service:uninstall
```

---

## Standalone Single-File Executable (`winhelm.exe`)

You can compile WinHelm into a standalone `.exe` (~2.6 MB) that requires **no Node.js installation** on target machines:

```powershell
npm run build:exe
```

The resulting executable will be generated at `dist/winhelm.exe`:

```powershell
# Run standalone executable with custom port
.\dist\winhelm.exe --port 9000 --auth my-token
```

---

## Security, Rate Limiting & Auditing

1. **Automatic Secret Redaction:**
   - Automatically sanitizes sensitive keys (`sk-...`, `ghp_...`, `Bearer ********`, and password values) from terminal output, dashboard UI, and log files.
2. **Built-in Rate Limiting (Sliding Window):**
   - Enforces a sliding window ceiling of 120 requests per minute per IP address, preventing runaway client loops.
3. **Auditing & Log Rotation:**
   - Logs are stored in `logs/winhelm-YYYY-MM-DD.log` (capped at 10 MB per file, auto-pruning logs older than 7 days).
   - Export audit logs anytime via browser or API:
     - `http://localhost:8788/api/monitor/export?format=json`
     - `http://localhost:8788/api/monitor/export?format=csv`

---

## Troubleshooting

### 1. Port Conflict (`EADDRINUSE: address already in use :::8788`)
- **Cause:** Another process or previous instance is using port 8788.
- **Solution:** Specify a different port using `--port`:
  ```powershell
  node dist/index.js --port 8790
  ```
  Or check which process is holding port 8788:
  ```powershell
  Get-NetTCPConnection -LocalPort 8788 | Select-Object OwningProcess
  ```

### 2. HTTP 401 Unauthorized
- **Cause:** WinHelm was started with `--auth <token>` or `MCP_AUTH_TOKEN`, but the MCP client didn't supply matching credentials.
- **Solution 1 (Clients with Custom Header Support):** Add the Bearer token header to your client configuration:
  ```json
  "headers": {
    "Authorization": "Bearer <YOUR_TOKEN>"
  }
  ```
- **Solution 2 (Claude.ai Custom Connectors without Header UI):** Append the token directly to the Server URL and select **No sign-in**:
  ```text
  https://<your-domain>/mcp?token=<YOUR_TOKEN>
  ```

### 3. PowerShell Execution Policy Restriction
- **Cause:** Windows blocks script execution (`File cannot be loaded because running scripts is disabled on this system`).
- **Solution:** Run with bypass flag:
  ```powershell
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  ```

### 4. Windows Service Installation Error (`Access is denied`)
- **Cause:** `npm run service:install` registers a task in Windows Task Scheduler, which requires elevated privileges.
- **Solution:** Open PowerShell as **Administrator** and re-run `npm run service:install`.

### 5. Tailscale / Remote Timeout
- **Cause:** Windows Defender Firewall is blocking inbound connections on port 8788.
- **Solution:** Allow port 8788 in Windows Firewall:
  ```powershell
  New-NetFirewallRule -DisplayName "WinHelm MCP Gateway" -Direction Inbound -LocalPort 8788 -Protocol TCP -Action Allow
  ```

### 6. PDF Generation Headless Browser Not Found
- **Cause:** Neither Microsoft Edge nor Google Chrome could be located in default system paths.
- **Solution:** Ensure Microsoft Edge is installed at its standard location (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) or install Google Chrome.

---

## Documentation & Deep Dive

For in-depth guides, architectural references, and developer guidelines, explore the `docs/` folder:

- 📖 **[Comprehensive Tools Reference](docs/TOOLS.md)**: Exhaustive documentation for all 38 tools, including parameter types, options, return formats, and JSON-RPC examples.
- ⚙️ **[Tool Profiles & Context Optimization](docs/PROFILES.md)**: Deep dive into the 5 built-in profiles (minimal, core, dev, sysadmin, full), custom `--tools` filtering, token economics, and LLM optimization recipes.
- 🛡️ **[Security Model & Architecture](docs/SECURITY.md)**: Deep dive into the 5-layer security model, path confinement, regex command blacklists, and secret masking.
- 💡 **[Real-World Agent Examples](docs/EXAMPLES.md)**: End-to-end workflows showing how AI agents build projects, troubleshoot Windows crashes, and generate executive PDFs.
- 📝 **[Changelog](CHANGELOG.md)**: Release notes and version history following Keep a Changelog.
- 🤝 **[Contributing Guide](CONTRIBUTING.md)**: Instructions for developing, running tests, and opening Pull Requests.

---

## License

This project is licensed under the [MIT License](LICENSE) — see the [LICENSE](LICENSE) file for details.  
Built cleanly from the ground up for the Windows Model Context Protocol developer community.

