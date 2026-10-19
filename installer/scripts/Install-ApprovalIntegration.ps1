[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [string]$NodePath,
    [string]$AppUserModelId = "WinHelm",
    [switch]$Force
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$modulePath = Join-Path (Split-Path -Parent $scriptDir) "src\WinHelm.ApprovalInstaller.psm1"
Import-Module $modulePath -Force

$result = Install-WinHelmApprovalIntegration `
    -InstallRoot $InstallRoot `
    -NodePath $NodePath `
    -AppUserModelId $AppUserModelId `
    -Force:$Force

$result | ConvertTo-Json -Depth 4
