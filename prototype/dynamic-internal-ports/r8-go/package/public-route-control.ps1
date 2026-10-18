[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [ValidateSet('activate', 'deactivate')] [string] $Action,
    [string] $Config,
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
$model = 'WINHELM_R7_PUBLIC_ROUTE_CONTROL'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'
$requiredListener = '127.0.0.1:19447'

# Resolve the control surface exactly like the ingress resolves its host state:
# config-relative stateRoot, lowercased DNS-label host, control\request.json.
function Resolve-RouteContext([string] $RootPath, [string] $ConfigPath) {
    $rootItem = Get-Item -LiteralPath $RootPath -ErrorAction Stop
    $configFile = if ([string]::IsNullOrWhiteSpace($ConfigPath)) { Join-Path $rootItem.FullName 'config.json' } else { $ConfigPath }
    $configItem = Get-Item -LiteralPath $configFile -ErrorAction Stop
    $config = Get-Content -LiteralPath $configItem.FullName -Raw | ConvertFrom-Json
    $hostName = ([string] $config.host).Trim().ToLowerInvariant()
    if ($hostName -notmatch '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') { throw 'config host is invalid' }
    $stateRoot = [string] $config.stateRoot
    if (-not [System.IO.Path]::IsPathRooted($stateRoot)) {
        $stateRoot = Join-Path (Split-Path -Parent $configItem.FullName) $stateRoot
    }
    $controlDir = Join-Path (Join-Path $stateRoot $hostName) 'control'
    return [pscustomobject]@{
        ConfigPath  = $configItem.FullName
        Host        = $hostName
        Listen      = [string] $config.listen
        ControlDir  = $controlDir
        RequestPath = Join-Path $controlDir 'request.json'
    }
}

$ctx = Resolve-RouteContext $Root $Config
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$serviceExists = $null -ne $service
$serviceStatus = if ($serviceExists) { [string] $service.Status } else { 'absent' }
$controlDirExists = Test-Path -LiteralPath $ctx.ControlDir -PathType Container
$requestPending = Test-Path -LiteralPath $ctx.RequestPath -PathType Leaf

if (-not $Apply) {
    Write-Output ("DRY_RUN model=" + $model +
        " action=" + $Action +
        " request=" + $ctx.RequestPath +
        " host=" + $ctx.Host +
        " local_listener=" + $ctx.Listen +
        " service_exists=" + $serviceExists.ToString().ToLowerInvariant() +
        " service_status=" + $serviceStatus +
        " control_dir_exists=" + $controlDirExists.ToString().ToLowerInvariant() +
        " request_pending=" + $requestPending.ToString().ToLowerInvariant() +
        " writes=0 service_started=false")
    exit 0
}

# Apply-lane guards. All read-only; the service must already be Running because
# activation while stopped would leave an unattended public route.
if (-not $serviceExists) { throw ('control refused: service is not installed: ' + $serviceName) }
if ($serviceStatus -ne 'Running') { throw ('control refused: service is not running: ' + $serviceStatus) }
if (-not $controlDirExists) { throw ('control refused: control directory missing: ' + $ctx.ControlDir) }
if ($requestPending) { throw ('control refused: a control request is already pending: ' + $ctx.RequestPath) }
if ($Action -eq 'activate' -and $ctx.Listen -ne $requiredListener) {
    throw ('control refused: activation requires local listener ' + $requiredListener + ' but config declares ' + $ctx.Listen)
}

$requestId = [guid]::NewGuid().ToString('N')
$payload = [ordered]@{ version = 1; action = $Action; request_id = $requestId } | ConvertTo-Json -Compress
$tempPath = Join-Path $ctx.ControlDir 'request.json.tmp'
[System.IO.File]::WriteAllText($tempPath, $payload + "`n", [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tempPath -Destination $ctx.RequestPath -Force
Write-Output ("REQUEST_WRITTEN model=" + $model + " action=" + $Action + " request_id=" + $requestId + " request=" + $ctx.RequestPath)
exit 0
