<#
.SYNOPSIS
    เริ่มต้น WinHelm MCP Server และเปิด Tailscale Funnel ในอีกหน้าต่าง/แท็บอัตโนมัติ

.DESCRIPTION
    1. เริ่มต้นรัน D:\mcp\winhelm-mcp\start.ps1 ในหน้าต่าง/แท็บแรก
    2. รอจนกระทั่ง WinHelm MCP Server พร้อมทำงาน (Health Check บนพอร์ต 8788 ผ่าน)
    3. เปิด Tailscale Funnel ในอีกหน้าต่าง/แท็บ: tailscale funnel --https=443 http://127.0.0.1:8788

.PARAMETER Port
    พอร์ตของ WinHelm MCP Server (ค่าเริ่มต้น: 8788)

.PARAMETER FunnelPort
    พอร์ต HTTPS สาธารณะสำหรับ Tailscale Funnel (ค่าเริ่มต้น: 443)

.PARAMETER ProfileName
    โปรไฟล์เครื่องมือของ WinHelm (เช่น full, dev, core, sysadmin, minimal)

.PARAMETER SeparateWindows
    เปิดเป็นหน้าต่าง PowerShell แยกกันแทนการรวมแท็บใน Windows Terminal
#>

param (
    [int]$Port = 8788,
    [int]$FunnelPort = 443,
    [string]$ProfileName = "",
    [switch]$SeparateWindows = $false
)

$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$winhelmDir = "D:\mcp\winhelm-mcp"
$startScript = Join-Path $winhelmDir "start.ps1"

if (-not (Test-Path $startScript)) {
    Write-Error "ไม่พบไฟล์ start.ps1 ที่: $startScript"
    exit 1
}

# ฟังก์ชันแปลงคำสั่งเป็น Base64 ป้องกันปัญหา Escape Quotes ใน Windows Terminal / PowerShell
function Get-EncodedCommand ([string]$scriptText) {
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($scriptText)
    return [Convert]::ToBase64String($bytes)
}

# 1. คำสั่งสำหรับหน้าต่าง WinHelm Server
$serverArgs = "-Port $Port"
if ($ProfileName) {
    $serverArgs += " -ServerProfile $ProfileName"
}

$winhelmScript = @"
Set-Location '$winhelmDir'
`$host.UI.RawUI.WindowTitle = 'WinHelm MCP Server (Port $Port)'
Write-Host '======================================================' -ForegroundColor Cyan
Write-Host '  🚀 Starting WinHelm MCP Server on Port $Port...    ' -ForegroundColor Green
Write-Host '======================================================' -ForegroundColor Cyan
.\start.ps1 $serverArgs
"@

# 2. คำสั่งสำหรับหน้าต่าง Tailscale Funnel (รอจนกว่า Server จะพร้อมแล้วจึงรัน Funnel)
$funnelScript = @"
`$host.UI.RawUI.WindowTitle = 'Tailscale Funnel (Port $FunnelPort -> $Port)'
Write-Host '======================================================' -ForegroundColor Cyan
Write-Host '  🌐 Tailscale Funnel for WinHelm MCP Server          ' -ForegroundColor Green
Write-Host '======================================================' -ForegroundColor Cyan
Write-Host 'กำลังรอให้ WinHelm MCP Server พร้อมทำงานที่พอร์ต $Port...' -ForegroundColor Yellow

`$healthUrl = 'http://127.0.0.1:$Port/health'
`$ready = `$false
`$maxAttempts = 40

for (`$i = 1; `$i -le `$maxAttempts; `$i++) {
    try {
        `$res = Invoke-RestMethod -Uri `$healthUrl -TimeoutSec 1 -ErrorAction SilentlyContinue
        if (`$res.status -eq 'ok') {
            `$ready = `$true
            break
        }
    } catch {
        # รอเซิร์ฟเวอร์เริ่มต้น
    }
    Write-Host '.' -NoNewline -ForegroundColor Gray
    Start-Sleep -Milliseconds 500
}
Write-Host ''

if (`$ready) {
    Write-Host '✔ WinHelm MCP Server พร้อมทำงานแล้ว! (Health Check OK)' -ForegroundColor Green
} else {
    Write-Host '⚠ ไม่ได้รับการตอบรับจาก Health Check แต่จะดำเนินการเปิด Funnel ต่อไป' -ForegroundColor DarkYellow
}

Write-Host ''
Write-Host '🚀 กำลังเริ่มต้นคำสั่ง Tailscale Funnel...' -ForegroundColor Cyan
Write-Host '>> tailscale funnel --https=$FunnelPort http://127.0.0.1:$Port' -ForegroundColor DarkCyan
Write-Host ''

tailscale funnel --https=$FunnelPort http://127.0.0.1:$Port
"@

$encodedWinhelm = Get-EncodedCommand $winhelmScript
$encodedFunnel  = Get-EncodedCommand $funnelScript

# ตรวจสอบการใช้งาน Windows Terminal (wt.exe)
$hasWT = (Get-Command wt.exe -ErrorAction SilentlyContinue) -ne $null

if ($hasWT -and -not $SeparateWindows) {
    Write-Host "======================================================" -ForegroundColor Cyan
    Write-Host "  เปิด WinHelm Server และ Tailscale Funnel ใน Windows Terminal" -ForegroundColor Green
    Write-Host "======================================================" -ForegroundColor Cyan
    Write-Host "  - แท็บ 1: WinHelm MCP Server (พอร์ต $Port)" -ForegroundColor Yellow
    Write-Host "  - แท็บ 2: Tailscale Funnel (HTTPS $FunnelPort -> $Port)" -ForegroundColor Yellow
    Write-Host "======================================================" -ForegroundColor Cyan

    $wtArgs = "--title `"WinHelm-Server`" powershell.exe -NoExit -EncodedCommand $encodedWinhelm ; new-tab --title `"Tailscale-Funnel`" powershell.exe -NoExit -EncodedCommand $encodedFunnel"
    Start-Process "wt.exe" -ArgumentList $wtArgs
} else {
    Write-Host "======================================================" -ForegroundColor Cyan
    Write-Host "  เปิด WinHelm Server และ Tailscale Funnel ในหน้าต่างแยก" -ForegroundColor Green
    Write-Host "======================================================" -ForegroundColor Cyan
    Write-Host "  - หน้าต่าง 1: WinHelm MCP Server (พอร์ต $Port)" -ForegroundColor Yellow
    Write-Host "  - หน้าต่าง 2: Tailscale Funnel (HTTPS $FunnelPort -> $Port)" -ForegroundColor Yellow
    Write-Host "======================================================" -ForegroundColor Cyan

    # เปิดหน้าต่าง 1: WinHelm
    Start-Process powershell.exe -ArgumentList "-NoExit", "-EncodedCommand", $encodedWinhelm

    # เปิดหน้าต่าง 2: Tailscale Funnel
    Start-Process powershell.exe -ArgumentList "-NoExit", "-EncodedCommand", $encodedFunnel
}
