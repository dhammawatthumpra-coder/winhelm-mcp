# Start WinHelm MCP Server
param (
    [int]$Port = 8788,
    [string]$HostAddr = "0.0.0.0",
    [string]$Auth = "",
    [string]$AllowedDirs = ""
)

$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $PSScriptRoot

if (-not (Test-Path "$PSScriptRoot\dist\index.js")) {
    Write-Host "Compiling TypeScript project..." -ForegroundColor Cyan
    npm run build
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Starting WinHelm MCP Server..." -ForegroundColor Green
Write-Host "  Port: $Port" -ForegroundColor Yellow
Write-Host "  Host: $HostAddr" -ForegroundColor Yellow
if ($Auth) {
    Write-Host "  Auth: ENABLED (Bearer Token)" -ForegroundColor Yellow
} else {
    Write-Host "  Auth: DISABLED (Public mode)" -ForegroundColor Gray
}
if ($AllowedDirs) {
    Write-Host "  Allowed Directories: $AllowedDirs" -ForegroundColor Yellow
} else {
    Write-Host "  Allowed Directories: All paths (Unrestricted)" -ForegroundColor Gray
}
Write-Host "==========================================" -ForegroundColor Cyan

$argsList = @("dist/index.js", "--port", $Port, "--host", $HostAddr)
if ($Auth) {
    $argsList += @("--auth", $Auth)
}
if ($AllowedDirs) {
    $argsList += @("--allowed-dirs", $AllowedDirs)
}

node @argsList
