[CmdletBinding(SupportsShouldProcess)]
param([switch] $Apply)

$ErrorActionPreference = 'Stop'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -eq $service) { Write-Output 'NOT_INSTALLED'; exit 0 }
if (-not $Apply) { Write-Output "DRY_RUN service=$serviceName"; exit 0 }
if ($PSCmdlet.ShouldProcess($serviceName, 'stop and remove isolated corrective Windows service')) {
    if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force }
    sc.exe delete $serviceName | Out-Null
}
