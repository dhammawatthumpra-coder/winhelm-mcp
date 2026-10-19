[CmdletBinding(SupportsShouldProcess)]
param([switch] $Apply)

$ErrorActionPreference = 'Stop'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'
if (-not $Apply) { Write-Output "DRY_RUN service=$serviceName action=start"; exit 0 }
if ($PSCmdlet.ShouldProcess($serviceName, 'start isolated corrective service')) { Start-Service -Name $serviceName }
