# Start WinHelm MCP Server
param (
    [int]$Port = 8788,
    [string]$HostAddr = "127.0.0.1",
    [string]$Auth = "",
    [string]$AllowedDirs = "",
    [string]$ServerProfile = "",
    [string]$Config = "",
    [string]$Tools = "",
    [switch]$ReadOnly = $false,
    [switch]$NoPersist = $false
)

$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $PSScriptRoot

# Safety Guard: Disallow binding to non-loopback interface without authentication
$isLoopback = ($HostAddr -eq "127.0.0.1" -or $HostAddr.ToLower() -eq "localhost" -or $HostAddr -eq "::1")
$effectiveAuth = if ($Auth) { $Auth } elseif ($env:MCP_AUTH_TOKEN) { $env:MCP_AUTH_TOKEN } else { "" }

if (-not $effectiveAuth) {
    $targetConfig = if ($Config -and (Test-Path $Config)) { $Config } elseif (Test-Path "$PSScriptRoot\winhelm.config.json") { "$PSScriptRoot\winhelm.config.json" } else { $null }
    if ($targetConfig) {
        try {
            $cfgContent = Get-Content $targetConfig -Raw -Encoding UTF8
            $cfgJson = $cfgContent | ConvertFrom-Json
            if ($cfgJson.authToken) {
                $effectiveAuth = $cfgJson.authToken
            }
        } catch {}
    }
}

if (-not $isLoopback -and -not $effectiveAuth) {
    Write-Host ''
    Write-Host '==========================================================================' -ForegroundColor Red
    Write-Host ' ⛔ [SECURITY ERROR] Binding to non-loopback host without authentication!' -ForegroundColor Red
    Write-Host '==========================================================================' -ForegroundColor Red
    Write-Host " Interface: ${HostAddr}:${Port}" -ForegroundColor Yellow
    Write-Host ' WinHelm provides full filesystem access and terminal execution.' -ForegroundColor Yellow
    Write-Host " Binding to '$HostAddr' exposes your machine to anyone on the network." -ForegroundColor Yellow
    Write-Host ''
    Write-Host ' To proceed safely, supply an authentication token:' -ForegroundColor Cyan
    Write-Host "   .\start.ps1 -HostAddr $HostAddr -Auth 'your-secret-token'" -ForegroundColor Cyan
    Write-Host ' Or set the environment variable:' -ForegroundColor Cyan
    Write-Host '   $env:MCP_AUTH_TOKEN = "your-secret-token"' -ForegroundColor Cyan
    Write-Host '==========================================================================' -ForegroundColor Red
    Write-Host ''
    exit 1
}

if (-not (Test-Path "$PSScriptRoot\dist\index.js")) {
    Write-Host "Compiling TypeScript project..." -ForegroundColor Cyan
    npm run build
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Starting WinHelm MCP Server..." -ForegroundColor Green
Write-Host "  Port: $Port" -ForegroundColor Yellow
Write-Host "  Host: $HostAddr" -ForegroundColor Yellow
if ($effectiveAuth) {
    Write-Host "  Auth: ENABLED (Bearer Token)" -ForegroundColor Yellow
} else {
    Write-Host "  Auth: DISABLED (Loopback Local Only)" -ForegroundColor Gray
}
if ($AllowedDirs) {
    Write-Host "  Allowed Directories: $AllowedDirs" -ForegroundColor Yellow
} else {
    Write-Host "  Allowed Directories: All paths (Unrestricted)" -ForegroundColor Gray
}
if ($ServerProfile) {
    Write-Host "  Profile: $ServerProfile" -ForegroundColor Yellow
}
if ($Config) {
    Write-Host "  Config: $Config" -ForegroundColor Yellow
}
if ($ReadOnly) {
    Write-Host "  Read-Only Mode: ENABLED" -ForegroundColor Yellow
}
Write-Host "==========================================" -ForegroundColor Cyan

$argsList = @("dist/index.js", "--port", $Port, "--host", $HostAddr)
if ($Auth) {
    $argsList += @("--auth", $Auth)
}
if ($AllowedDirs) {
    $argsList += @("--allowed-dirs", $AllowedDirs)
}
if ($ServerProfile) {
    $argsList += @("--profile", $ServerProfile)
}
if ($Config) {
    $argsList += @("--config", $Config)
}
if ($Tools) {
    $argsList += @("--tools", $Tools)
}
if ($ReadOnly) {
    $argsList += @("--read-only")
}
if ($NoPersist) {
    $argsList += @("--no-persist")
}

node @argsList
