[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -eq $service) { Write-Output "NOT_INSTALLED service=$serviceName"; exit 0 }
Write-Output ("SERVICE_STATUS service={0} status={1}" -f $serviceName, $service.Status)
