[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [string] $Config
)

$ErrorActionPreference = 'Stop'
$model = 'WINHELM_R7_PUBLIC_ROUTE_STATUS'
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
        Host       = $hostName
        ControlDir = $controlDir
        StatusPath = Join-Path $controlDir 'status.json'
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
$servicePid = 0
if ($serviceExists) {
    try {
        $serviceCim = Get-CimInstance Win32_Service -Filter ("Name='" + $serviceName.Replace("'", "''") + "'") -ErrorAction Stop
        if ($null -ne $serviceCim -and $null -ne $serviceCim.ProcessId) { $servicePid = [int] $serviceCim.ProcessId }
    } catch {
        $servicePid = 0
    }
}

$statusFileExists = Test-Path -LiteralPath $ctx.StatusPath -PathType Leaf
$statusObj = Read-RouteStatus $ctx.StatusPath
$publicRoute = if ($null -ne $statusObj -and $null -ne $statusObj.public_route) { [string] $statusObj.public_route } elseif ($statusFileExists) { 'unreadable' } else { 'unknown' }
$localListener = if ($null -ne $statusObj -and $null -ne $statusObj.internal_target -and $null -ne $statusObj.internal_target.listener) { [string] $statusObj.internal_target.listener } elseif ($null -ne $statusObj -and $null -ne $statusObj.local_listener) { [string] $statusObj.local_listener } else { '' }
$targetGeneration = if ($null -ne $statusObj -and $null -ne $statusObj.internal_target -and $null -ne $statusObj.internal_target.generation) { [string] $statusObj.internal_target.generation } else { '' }
$targetPid = if ($null -ne $statusObj -and $null -ne $statusObj.internal_target -and $null -ne $statusObj.internal_target.pid) { [int] $statusObj.internal_target.pid } else { 0 }
$targetVerification = if ($null -ne $statusObj -and $null -ne $statusObj.internal_target -and $null -ne $statusObj.internal_target.verification) { [string] $statusObj.internal_target.verification } else { 'unavailable' }

$listenerState = 'unavailable'
$listenerPort = 0
$listenerOwner = 0
$expectedOwner = if ($targetPid -gt 0) { $targetPid } else { $servicePid }
if ($localListener -match '^127[.]0[.]0[.]1:([0-9]{1,5})$') {
    $listenerPort = [int] $Matches[1]
    if ($listenerPort -ge 1024 -and $listenerPort -le 65535) {
        try {
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $listenerPort -ErrorAction Stop |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' })
            if ($listeners.Count -eq 0) {
                $listenerState = 'absent'
            } elseif ($expectedOwner -gt 0) {
                $owned = @($listeners | Where-Object { [int] $_.OwningProcess -eq $expectedOwner })
                if ($owned.Count -gt 0) {
                    $listenerState = 'listening_owned'
                    $listenerOwner = $expectedOwner
                } else {
                    $listenerState = 'listening_foreign'
                    $listenerOwner = [int] $listeners[0].OwningProcess
                }
            } else {
                $listenerState = 'listening_owner_unverifiable'
                $listenerOwner = [int] $listeners[0].OwningProcess
            }
        } catch {
            if ($_.Exception.Message -match 'No matching MSFT_NetTCPConnection') { $listenerState = 'absent' }
            else { $listenerState = 'unavailable' }
        }
    } else {
        $listenerState = 'invalid_target'
    }
} elseif ([string]::IsNullOrWhiteSpace($localListener)) {
    $listenerState = 'target_unavailable'
} else {
    $listenerState = 'invalid_target'
}

$verdict = 'RUNNING_STATUS_UNVERIFIABLE'
$exitCode = 1
if (-not $serviceExists) {
    if ($listenerState -eq 'listening_owned' -or $listenerState -eq 'listening_foreign' -or $listenerState -eq 'listening_owner_unverifiable') {
        $verdict = 'LISTENER_WITHOUT_SERVICE'
        $exitCode = 1
    } else {
        $verdict = 'NOT_INSTALLED'
        $exitCode = 0
    }
} elseif ($serviceStatus -eq 'Stopped') {
    if (-not $statusFileExists) {
        $verdict = 'STOPPED_NO_STATUS_FILE'
        $exitCode = 0
    } elseif ($publicRoute -eq 'active') {
        $verdict = 'STOPPED_ROUTE_MAY_BE_STALE'
        $exitCode = 1
    } elseif ($publicRoute -eq 'inactive') {
        $verdict = 'STOPPED_ROUTE_INACTIVE'
        $exitCode = 0
    } else {
        $verdict = 'STOPPED_STATUS_UNVERIFIABLE'
        $exitCode = 1
    }
} elseif ($serviceStatus -eq 'Running') {
    if ($publicRoute -eq 'active') {
        if ($listenerState -eq 'listening_owned' -and $targetVerification -eq 'verified_at_activation') {
            $verdict = 'RUNNING_PUBLIC_ACTIVE'
            $exitCode = 0
        } elseif ($listenerState -eq 'listening_foreign') {
            $verdict = 'RUNNING_ROUTE_ACTIVE_WITH_FOREIGN_LISTENER'
            $exitCode = 1
        } elseif ($listenerState -eq 'absent') {
            $verdict = 'RUNNING_ROUTE_ACTIVE_WITHOUT_LISTENER'
            $exitCode = 1
        } else {
            $verdict = 'RUNNING_ACTIVE_TARGET_UNVERIFIABLE'
            $exitCode = 1
        }
    } elseif ($publicRoute -eq 'inactive') {
        if ($listenerState -eq 'listening_owned') {
            $verdict = 'RUNNING_LOCAL_READY_PUBLIC_INACTIVE'
            $exitCode = 0
        } elseif ($listenerState -eq 'listening_foreign') {
            $verdict = 'RUNNING_FOREIGN_LISTENER'
            $exitCode = 1
        } elseif ($listenerState -eq 'absent') {
            $verdict = 'RUNNING_WITHOUT_LISTENER'
            $exitCode = 1
        } else {
            $verdict = 'RUNNING_STATUS_UNVERIFIABLE'
            $exitCode = 1
        }
    } else {
        $verdict = 'RUNNING_STATUS_UNVERIFIABLE'
        $exitCode = 1
    }
}

Write-Output ("PUBLIC_ROUTE_STATUS model=" + $model +
    " service=" + $serviceName +
    " state=" + $serviceStatus +
    " public_route=" + $publicRoute +
    " public_port=443" +
    " local_listener=" + $localListener +
    " listener_state=" + $listenerState +
    " listener_owner=" + $listenerOwner +
    " target_generation=" + $targetGeneration +
    " target_pid=" + $targetPid +
    " target_verification=" + $targetVerification +
    " status_file=" + $statusFileExists.ToString().ToLowerInvariant() +
    " host=" + $ctx.Host +
    " verdict=" + $verdict +
    " exit=" + $exitCode)
exit $exitCode
