[CmdletBinding(SupportsShouldProcess)]
param([switch] $Apply)

$ErrorActionPreference = 'Stop'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'
if (-not $Apply) { Write-Output "DRY_RUN service=$serviceName action=stop"; exit 0 }
if ($PSCmdlet.ShouldProcess($serviceName, 'stop isolated corrective service')) { Stop-Service -Name $serviceName -Force }
