[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $NewBinary,
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'
$root = (Get-Item -LiteralPath $Root).FullName
$target = Join-Path $root 'winhelm-go-tls-ingress-hardening-r1.exe'
if (-not $Apply) { Write-Output "DRY_RUN service=$serviceName target=$target"; exit 0 }
if ($PSCmdlet.ShouldProcess($serviceName, 'stage bounded upgrade with rollback backup')) {
    Stop-Service -Name $serviceName
    Copy-Item -LiteralPath $target -Destination ($target + '.rollback')
    Copy-Item -LiteralPath $NewBinary -Destination $target -Force
    Start-Service -Name $serviceName
}
