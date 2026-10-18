[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string] $Root,
    [string] $Config = (Join-Path $Root 'config.json'),
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
$binary = Join-Path (Get-Item -LiteralPath $Root).FullName 'winhelm-go-tls-ingress-hardening-r1.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'candidate executable is missing' }
if (-not $Apply) {
    Write-Output "DRY_RUN enrollment=explicit-one-shot config=$Config"
    Write-Output 'No enrollment occurred. Re-run with -Apply only as an explicit Owner/admin action.'
    exit 0
}
if ($PSCmdlet.ShouldProcess($binary, 'perform explicit one-shot tsnet enrollment')) {
    & $binary --config $Config --login
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
