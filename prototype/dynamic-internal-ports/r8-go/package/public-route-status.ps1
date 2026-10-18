[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [string] $Config
)

$ErrorActionPreference = 'Stop'
$model = 'WINHELM_R7_PUBLIC_ROUTE_STATUS'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'

# Read-only helper: resolves the same config-relative control surface the
# ingress uses and reports a stable verdict. It never starts, stops, or
# configures anything and never writes a file.
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
        Host       = $hostName
        ControlDir = $controlDir
        StatusPath = Join-Path $controlDir 'status.json'
    }
}

$ctx = Resolve-RouteContext $Root $Config
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$serviceExists = $null -ne $service
$serviceStatus = if ($serviceExists) { [string] $service.Status } else { 'absent' }

$listenerState = 'unavailable'
$listenerCount = 0
try {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 19447 -ErrorAction Stop)
    $listenerCount = $listeners.Count
    $listenerState = if ($listenerCount -gt 0) { 'listening' } else { 'absent' }
} catch {
    # Get-NetTCPConnection raises "No matching MSFT_NetTCPConnection objects
    # found by CIM query" when the query succeeds but nothing matches; that is
    # definitive absence, not missing evidence. Any other failure stays
    # unavailable.
    if ($_.Exception.Message -match 'No matching MSFT_NetTCPConnection') { $listenerState = 'absent' }
    else { $listenerState = 'unavailable' }
}

$statusFileExists = Test-Path -LiteralPath $ctx.StatusPath -PathType Leaf
$publicRoute = 'unknown'
if ($statusFileExists) {
    try {
        $statusObj = Get-Content -LiteralPath $ctx.StatusPath -Raw | ConvertFrom-Json
        if ($null -ne $statusObj.public_route) { $publicRoute = [string] $statusObj.public_route }
    } catch {
        $publicRoute = 'unreadable'
    }
}

$verdict = 'RUNNING_STATUS_UNVERIFIABLE'
$exitCode = 1
if (-not $serviceExists) {
    if ($listenerCount -gt 0) { $verdict = 'LISTENER_WITHOUT_SERVICE'; $exitCode = 1 }
    else { $verdict = 'NOT_INSTALLED'; $exitCode = 0 }
} elseif ($serviceStatus -eq 'Stopped') {
    if (-not $statusFileExists) { $verdict = 'STOPPED_NO_STATUS_FILE'; $exitCode = 0 }
    elseif ($publicRoute -eq 'active') { $verdict = 'STOPPED_ROUTE_MAY_BE_STALE'; $exitCode = 1 }
    elseif ($publicRoute -eq 'inactive') { $verdict = 'STOPPED_ROUTE_INACTIVE'; $exitCode = 0 }
    else { $verdict = 'STOPPED_STATUS_UNVERIFIABLE'; $exitCode = 1 }
} elseif ($serviceStatus -eq 'Running') {
    if ($publicRoute -eq 'active') {
        if ($listenerCount -gt 0) { $verdict = 'RUNNING_PUBLIC_ACTIVE'; $exitCode = 0 }
        else { $verdict = 'RUNNING_ROUTE_ACTIVE_WITHOUT_LISTENER'; $exitCode = 1 }
    } elseif ($publicRoute -eq 'inactive') {
        if ($listenerCount -gt 0) { $verdict = 'RUNNING_LOCAL_READY_PUBLIC_INACTIVE'; $exitCode = 0 }
        else { $verdict = 'RUNNING_WITHOUT_LISTENER'; $exitCode = 1 }
    } else { $verdict = 'RUNNING_STATUS_UNVERIFIABLE'; $exitCode = 1 }
}
if ($listenerState -eq 'unavailable' -and (-not $serviceExists -or $serviceStatus -eq 'Running')) {
    $verdict = 'LISTENER_EVIDENCE_UNAVAILABLE'
    $exitCode = 1
}

Write-Output ("PUBLIC_ROUTE_STATUS model=" + $model +
    " service=" + $serviceName +
    " state=" + $serviceStatus +
    " listener_19447=" + $listenerState +
    " public_route=" + $publicRoute +
    " status_file=" + $statusFileExists.ToString().ToLowerInvariant() +
    " host=" + $ctx.Host +
    " verdict=" + $verdict +
    " exit=" + $exitCode)
exit $exitCode
