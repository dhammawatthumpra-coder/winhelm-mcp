[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [string]$NodePath,
    [string]$AppUserModelId = "WinHelm"
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$modulePath = Join-Path (Split-Path -Parent $scriptDir) "src\WinHelm.ApprovalInstaller.psm1"
Import-Module $modulePath -Force

$result = Repair-WinHelmApprovalIntegration `
    -InstallRoot $InstallRoot `
    -NodePath $NodePath `
    -AppUserModelId $AppUserModelId

$result | ConvertTo-Json -Depth 4
