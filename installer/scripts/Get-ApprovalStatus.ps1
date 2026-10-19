[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [string]$AppUserModelId = "WinHelm"
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$modulePath = Join-Path (Split-Path -Parent $scriptDir) "src\WinHelm.ApprovalInstaller.psm1"
Import-Module $modulePath -Force

$result = Get-WinHelmApprovalIntegrationStatus `
    -InstallRoot $InstallRoot `
    -ExpectedAppUserModelId $AppUserModelId

$result | ConvertTo-Json -Depth 4
