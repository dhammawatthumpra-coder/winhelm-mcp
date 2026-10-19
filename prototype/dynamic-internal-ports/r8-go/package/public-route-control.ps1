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
        ConfigPath     = $configItem.FullName
        Host           = $hostName
        ConfigListener = [string] $config.listen
        ControlDir     = $controlDir
        RequestPath    = Join-Path $controlDir 'request.json'
        StatusPath     = Join-Path $controlDir 'status.json'
    }
}

function Read-RouteStatus([string] $StatusPath) {
    if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) { return $null }
    try {
        return Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

$ctx = Resolve-RouteContext $Root $Config
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$serviceExists = $null -ne $service
$serviceStatus = if ($serviceExists) { [string] $service.Status } else { 'absent' }
$controlDirExists = Test-Path -LiteralPath $ctx.ControlDir -PathType Container
$requestPending = Test-Path -LiteralPath $ctx.RequestPath -PathType Leaf
$status = Read-RouteStatus $ctx.StatusPath
$runtimeListener = if ($null -ne $status -and $null -ne $status.internal_target -and $null -ne $status.internal_target.listener) { [string] $status.internal_target.listener } elseif ($null -ne $status -and $null -ne $status.local_listener) { [string] $status.local_listener } else { 'unavailable' }
$targetGeneration = if ($null -ne $status -and $null -ne $status.internal_target -and $null -ne $status.internal_target.generation) { [string] $status.internal_target.generation } else { '' }
$targetPid = if ($null -ne $status -and $null -ne $status.internal_target -and $null -ne $status.internal_target.pid) { [int] $status.internal_target.pid } else { 0 }
$targetVerification = if ($null -ne $status -and $null -ne $status.internal_target -and $null -ne $status.internal_target.verification) { [string] $status.internal_target.verification } else { 'unavailable' }

if (-not $Apply) {
    Write-Output ("DRY_RUN model=" + $model +
        " action=" + $Action +
        " request=" + $ctx.RequestPath +
        " host=" + $ctx.Host +
        " config_listener=" + $ctx.ConfigListener +
        " runtime_listener=" + $runtimeListener +
        " target_generation=" + $targetGeneration +
        " target_pid=" + $targetPid +
        " target_verification=" + $targetVerification +
        " service_exists=" + $serviceExists.ToString().ToLowerInvariant() +
        " service_status=" + $serviceStatus +
        " control_dir_exists=" + $controlDirExists.ToString().ToLowerInvariant() +
        " request_pending=" + $requestPending.ToString().ToLowerInvariant() +
        " writes=0 service_started=false")
    exit 0
}

# The running service is the sole route-target authority. The helper never
# chooses or validates an internal port; activation is re-verified in-process
# against the current R8 runtime registry immediately before and after apply.
if (-not $serviceExists) { throw ('control refused: service is not installed: ' + $serviceName) }
if ($serviceStatus -ne 'Running') { throw ('control refused: service is not running: ' + $serviceStatus) }
if (-not $controlDirExists) { throw ('control refused: control directory missing: ' + $ctx.ControlDir) }
if ($requestPending) { throw ('control refused: a control request is already pending: ' + $ctx.RequestPath) }

$requestId = [guid]::NewGuid().ToString('N')
$payload = [ordered]@{ version = 1; action = $Action; request_id = $requestId } | ConvertTo-Json -Compress
$tempPath = Join-Path $ctx.ControlDir 'request.json.tmp'
[System.IO.File]::WriteAllText($tempPath, $payload + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tempPath -Destination $ctx.RequestPath -Force
Write-Output ("REQUEST_WRITTEN model=" + $model + " action=" + $Action + " request_id=" + $requestId + " request=" + $ctx.RequestPath)
exit 0
