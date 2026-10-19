[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$modulePath = Join-Path (Split-Path -Parent $scriptDir) "src\WinHelm.ApprovalInstaller.psm1"
Import-Module $modulePath -Force

$result = Uninstall-WinHelmApprovalIntegration -InstallRoot $InstallRoot

$result | ConvertTo-Json -Depth 4
