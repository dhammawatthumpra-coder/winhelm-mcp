[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string] $Root,
    [string] $Config = (Join-Path $Root 'config.json'),
    [string] $ServiceIdentity = 'NT SERVICE\WinHelmGoTlsIngressHardeningR1',
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'
$expectedServiceIdentity = 'NT SERVICE\WinHelmGoTlsIngressHardeningR1'
if ($ServiceIdentity -ne $expectedServiceIdentity) {
    throw "service identity must remain $expectedServiceIdentity"
}
$rootItem = Get-Item -LiteralPath $Root -ErrorAction Stop
if (-not $rootItem.PSIsContainer) {
    throw 'candidate root must be a directory'
}
$configItem = Get-Item -LiteralPath $Config -ErrorAction Stop
if ($configItem.PSIsContainer) {
    throw 'candidate config must be a file'
}
$binary = Join-Path $rootItem.FullName 'winhelm-go-tls-ingress-hardening-r1.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw 'candidate executable is missing'
}
if (-not $configItem.FullName.StartsWith($rootItem.FullName, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'config must remain under the candidate root'
}
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    throw "service already exists: $serviceName"
}
if (-not $Apply) {
    Write-Output "DRY_RUN service=$serviceName identity=$ServiceIdentity binary=$binary config=$($configItem.FullName)"
    Write-Output 'Registration precedes final virtual-identity configuration: LocalSystem registration -> unrestricted service SID -> final identity -> SCM verification.'
    Write-Output 'PLAN recovery_policy=reset=86400; actions=restart/30000,restart/300000,none/0; failureflag=true mechanism=ChangeServiceConfig2'
    Write-Output 'PLAN recovery_config_verified_after_registration_with_service_stopped=true service_started=false'
    Write-Output 'The service remains STOPPED and no service was created or started. Re-run with -Apply only after Owner/admin approval.'
    exit 0
}

$binPath = '"{0}" --config "{1}" --service' -f $binary, $configItem.FullName
if ($PSCmdlet.ShouldProcess($serviceName, 'create isolated corrective Windows service')) {
    $registered = $false
    try {
        $createArgs = @('create', $serviceName, 'binPath=', $binPath, 'start=', 'auto', 'obj=', 'LocalSystem', 'password=', '', 'DisplayName=', $serviceName)
        & sc.exe @createArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "service creation failed: exit=$LASTEXITCODE" }
        $registered = $true

        & sc.exe sidtype $serviceName unrestricted | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "service SID configuration failed: exit=$LASTEXITCODE" }

        # Managed/virtual service accounts require a NULL password: omit the password argument entirely.
        $configArgs = @('config', $serviceName, 'obj=', $ServiceIdentity)
        & sc.exe @configArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "service identity configuration failed: exit=$LASTEXITCODE" }

        $sidTypeOutput = @(& sc.exe qsidtype $serviceName 2>&1)
        if ($LASTEXITCODE -ne 0 -or (($sidTypeOutput -join [Environment]::NewLine) -notmatch '(?i)UNRESTRICTED')) {
            throw 'service SID type verification failed'
        }

        $serviceInfo = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $serviceName) -ErrorAction Stop
        if ($null -eq $serviceInfo) { throw 'service registration could not be re-queried' }
        if ($serviceInfo.State -ne 'Stopped') { throw "service must remain stopped: state=$($serviceInfo.State)" }
        if ($serviceInfo.StartName -ne $ServiceIdentity) { throw "service identity mismatch: $($serviceInfo.StartName)" }
        if ($serviceInfo.PathName -ne $binPath) { throw 'service command path mismatch' }

        # Bounded recovery policy is configured and verified after registration while the
        # service is stopped, before final success is reported. Failures here throw and the
        # catch below performs the existing self-rollback (service deletion).
        $configureRecovery = Join-Path $PSScriptRoot 'configure-recovery.ps1'
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $configureRecovery -ServiceName $serviceName -Apply -Confirm:$false
        if ($LASTEXITCODE -ne 0) { throw "recovery policy configuration failed: exit=$LASTEXITCODE" }

        $verifyRecovery = Join-Path $PSScriptRoot 'verify-recovery.ps1'
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifyRecovery -ServiceName $serviceName
        if ($LASTEXITCODE -ne 0) { throw "recovery policy verification failed: exit=$LASTEXITCODE" }

        Write-Output "INSTALLED_STOPPED service=$serviceName identity=$ServiceIdentity recovery_policy=configured_verified"
    } catch {
        $failure = $_.Exception.Message
        if ($registered) {
            try {
                $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
                if ($null -ne $service -and $service.Status -ne 'Stopped') {
                    Stop-Service -Name $serviceName -Force -ErrorAction Stop
                }
                & sc.exe delete $serviceName | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "service deletion failed: exit=$LASTEXITCODE" }
                $remaining = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
                if ($null -ne $remaining) { throw 'service remained after self-rollback' }
            } catch {
                throw "service installation failed: $failure; self-rollback failed: $($_.Exception.Message)"
            }
        }
        throw "service installation failed: $failure"
    }
}
