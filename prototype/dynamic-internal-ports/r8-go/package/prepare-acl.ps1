[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string] $Root,
    [string] $ServiceIdentity = 'NT SERVICE\WinHelmGoTlsIngressHardeningR1',
    [string] $OperatorIdentity,
    [switch] $OperatorStateRead,
    [string] $StateDir,
    [string] $LogsDir,
    [string] $SnapshotPath,
    [string] $RestoreFrom,
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
$model = 'WINHELM_R7_R3_ACL_MODEL'
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$adminSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

function Resolve-IdentityRef([string] $Identity) {
    if ($Identity -match '^S-\d-\d+-(\d+-){1,14}\d+$') {
        return New-Object System.Security.Principal.SecurityIdentifier($Identity)
    }
    return (New-Object System.Security.Principal.NTAccount($Identity)).Translate([System.Security.Principal.SecurityIdentifier])
}

function Test-UnderPath([string] $Path, [string] $Base) {
    if ($Path.Equals($Base, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $Path.StartsWith($Base + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-RootPathValue([string] $Value, [string] $Default, [string] $Name) {
    $candidate = if ($Value) { $Value } else { $Default }
    if (-not [System.IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path $rootPath $candidate }
    $full = [System.IO.Path]::GetFullPath($candidate)
    $full = $full.TrimEnd([char]92, [char]47)
    if (-not (Test-UnderPath $full $rootPath)) { throw "$Name must remain under the candidate root" }
    return $full
}

function Get-HostStatePath([string] $ConfigPath, [string] $StatePath) {
    # Mirrors the Go service derivation (main.go loadConfig): trim + lowercase
    # the config host, validate it as a single DNS label, then join it under
    # the configured state root. Never hard-code the hostname.
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'candidate config is missing' }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $hostValue = ([string] $config.host).Trim().ToLowerInvariant()
    if ($hostValue -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') { throw "config host is invalid: '$hostValue'" }
    return (Join-Path $StatePath $hostValue)
}

$rootItem = Get-Item -LiteralPath $Root -ErrorAction Stop
if (-not $rootItem.PSIsContainer) { throw 'candidate root must be a directory' }
if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'candidate root must not be a reparse point' }
$rootPath = $rootItem.FullName.TrimEnd([char]92, [char]47)
$configPath = Join-Path $rootPath 'config.json'
$binaryPath = Join-Path $rootPath 'winhelm-go-tls-ingress-hardening-r1.exe'
$packagePath = Join-Path $rootPath 'package'
$statePath = Resolve-RootPathValue $StateDir (Join-Path $rootPath 'state') 'state directory'
$logsPath = Resolve-RootPathValue $LogsDir (Join-Path $rootPath 'logs') 'logs directory'
if ($SnapshotPath) {
    if (-not [System.IO.Path]::IsPathRooted($SnapshotPath)) { $SnapshotPath = Join-Path $rootPath $SnapshotPath }
    $snapPath = [System.IO.Path]::GetFullPath($SnapshotPath)
} else {
    $snapPath = Join-Path $packagePath 'acl-rollback-snapshot.json'
}
if ((Test-UnderPath $snapPath $statePath) -or (Test-UnderPath $snapPath $logsPath)) { throw 'snapshot path must not be inside state or logs' }

$serviceSid = $null
$operatorSid = $null

function Get-SurfaceName([string] $Path) {
    if ($Path -eq $rootPath) { return 'root' }
    if (Test-UnderPath $Path $rootPath) { return $Path.Substring($rootPath.Length + 1) }
    return $Path
}

function New-DesiredAcl([string] $Path, [bool] $IsContainer) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
    $flags = if ($IsContainer) { 'ContainerInherit,ObjectInherit' } else { 'None' }
    $inState = Test-UnderPath $Path $statePath
    $inLogs = Test-UnderPath $Path $logsPath
    $mutable = $inState -or $inLogs
    if ($Path -eq $configPath) {
        $serviceRights = 'Read'
    } elseif ($mutable) {
        $serviceRights = 'Modify'
    } else {
        $serviceRights = 'ReadAndExecute'
    }
    $entries = [System.Collections.Generic.List[object]]::new()
    $entries.Add([pscustomobject]@{ Sid = $systemSid; Rights = 'FullControl' })
    $entries.Add([pscustomobject]@{ Sid = $adminSid; Rights = 'FullControl' })
    if ($null -ne $serviceSid) { $entries.Add([pscustomobject]@{ Sid = $serviceSid; Rights = $serviceRights }) }
    if ($null -ne $operatorSid) {
        $operatorGranted = if ($inState) { $OperatorStateRead } else { $true }
        if ($operatorGranted) { $entries.Add([pscustomobject]@{ Sid = $operatorSid; Rights = 'ReadAndExecute' }) }
    }
    foreach ($entry in $entries) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($entry.Sid, $entry.Rights, $flags, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    return $acl
}

function Set-PathDacl([string] $Path, $Security) {
    # Non-elevated constraint discovered during R3 qualification: writing a DACL
    # while the current DACL is SE_DACL_PROTECTED fails with PrivilegeNotHeld
    # (SeSecurityPrivilege). Drop protection first; the object owner may always
    # rewrite the DACL. The full target DACL is then written in one Set-Acl call.
    & icacls $Path /inheritance:e 2>&1 | Out-Null
    Set-Acl -LiteralPath $Path -AclObject $Security
}

function Remove-CreatedPath([string] $Path) {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer) {
        $children = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)
        if ($children.Count -gt 0) { throw "restore refuses to remove non-empty path: $Path" }
    }
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        return
    } catch { }
    # Owner fallback: the created path may not grant the operator DELETE.
    $meSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls $Path /inheritance:e 2>&1 | Out-Null
    if ($item.PSIsContainer) {
        & icacls $Path /grant:r "*${meSid}:(OI)(CI)F" 2>&1 | Out-Null
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    } else {
        & icacls $Path /grant:r "*${meSid}:F" 2>&1 | Out-Null
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
}

function Restore-AclSnapshot([string] $SnapshotFile) {
    $doc = Get-Content -LiteralPath $SnapshotFile -Raw | ConvertFrom-Json
    $failures = [System.Collections.Generic.List[string]]::new()
    # Restore existing paths first, top-down (shortest first): a parent is
    # returned to its original ACL before its children are touched, so the tree
    # stays reachable even when the applied protection removed the caller's
    # traversal rights. Created paths are then removed bottom-up (longest
    # first) so a created parent (for example state\) is empty before its own
    # removal and Remove-CreatedPath never refuses a non-empty path.
    $restoreOrder = @($doc.entries) | Sort-Object { if ($_.existed -ne $true) { 1 } else { 0 } }, { if ($_.existed -ne $true) { -$_.path.Length } else { $_.path.Length } }
    foreach ($entry in $restoreOrder) {
        if ($entry.existed -ne $true) {
            if (Test-Path -LiteralPath $entry.path) {
                try { Remove-CreatedPath $entry.path }
                catch { $failures.Add("$($entry.path): remove failed: $($_.Exception.Message)") }
            }
            continue
        }
        if (-not (Test-Path -LiteralPath $entry.path)) {
            $failures.Add("$($entry.path): missing at restore time")
            continue
        }
        try {
            $daclOnly = [string] $entry.sddl
            $dStart = $daclOnly.IndexOf('D:')
            if ($dStart -lt 0) { throw 'snapshot SDDL has no DACL section' }
            # Restore the DACL only: -Apply never alters owner/group, and a
            # non-elevated owner cannot write the owner section.
            $daclOnly = $daclOnly.Substring($dStart)
            if ($entry.kind -eq 'Directory') {
                $security = New-Object System.Security.AccessControl.DirectorySecurity
            } else {
                $security = New-Object System.Security.AccessControl.FileSecurity
            }
            $security.SetSecurityDescriptorSddlForm($daclOnly)
            Set-PathDacl $entry.path $security
        } catch {
            $failures.Add("$($entry.path): $($_.Exception.Message)")
        }
    }
    if ($failures.Count -gt 0) {
        throw "restore incomplete: $($failures.Count) path(s) failed; first: $($failures[0])"
    }
}

function Write-AclPlan() {
    $anyOperator = if ($OperatorIdentity) { ',Operator:ReadAndExecute-explicit-no-write' } else { ',Operator:none' }
    Write-Output "DRY_RUN acl_model=$model root=$rootPath service_identity=$ServiceIdentity snapshot=$snapPath"
    Write-Output "SURFACE name=root kind=dir inherit=disabled rights=SYSTEM:FullControl,Administrators:FullControl,Service:ReadAndExecute$anyOperator"
    Write-Output "SURFACE name=config.json kind=file inherit=disabled rights=SYSTEM:FullControl,Administrators:FullControl,Service:Read$anyOperator"
    Write-Output "SURFACE name=executable kind=file inherit=disabled rights=SYSTEM:FullControl,Administrators:FullControl,Service:ReadAndExecute$anyOperator"
    Write-Output "SURFACE name=package kind=dir inherit=disabled rights=SYSTEM:FullControl,Administrators:FullControl,Service:ReadAndExecute-no-write$anyOperator"
    $stateOperator = if ($OperatorIdentity -and $OperatorStateRead) { ',Operator:ReadAndExecute-sensitive-explicit' } else { ',Operator:none' }
    $logsOperator = if ($OperatorIdentity) { ',Operator:ReadAndExecute' } else { ',Operator:none' }
    Write-Output "SURFACE name=state kind=dir inherit=disabled rights=SYSTEM:FullControl,Administrators:FullControl,Service:Modify$stateOperator"
    $hostLeaf = Split-Path -Path $hostStatePath -Leaf
    Write-Output "SURFACE name=state\$hostLeaf kind=dir inherit=disabled rights=SYSTEM:FullControl,Administrators:FullControl,Service:Modify$stateOperator"
    Write-Output "SURFACE name=logs kind=dir inherit=disabled rights=SYSTEM:FullControl,Administrators:FullControl,Service:Modify$logsOperator"
    Write-Output "SURFACE name=all-other-paths inherit=disabled rights=no-broad-write,Service:ReadAndExecute-no-write$anyOperator"
    Write-Output 'TRAVERSAL note: directories are protected deepest-first so -Apply needs no elevated traversal; restore returns parents before children and removes apply-created paths children-first.'
}

if ($RestoreFrom) {
    if (-not [System.IO.Path]::IsPathRooted($RestoreFrom)) { $RestoreFrom = Join-Path $rootPath $RestoreFrom }
    $restoreFile = [System.IO.Path]::GetFullPath($RestoreFrom)
    if (-not (Test-Path -LiteralPath $restoreFile -PathType Leaf)) { throw 'restore snapshot is missing' }
    if (-not $Apply) {
        Write-Output "DRY_RUN acl_model=$model mode=restore snapshot=$restoreFile"
        Write-Output 'No ACL was changed. The service remains STOPPED. Re-run with -Apply only after Owner/admin approval.'
        exit 0
    }
    if ($PSCmdlet.ShouldProcess($rootPath, 'restore captured ACL snapshot')) {
        Restore-AclSnapshot $restoreFile
        Write-Output "ACL_RESTORED snapshot=$restoreFile"
    }
    exit 0
}

# The exact host-state directory is structural runtime state; it must exist
# (empty, protected) before live enrollment. Restore mode above works from the
# snapshot alone so a damaged config can never block rollback.
$hostStatePath = Get-HostStatePath $configPath $statePath

if (-not $Apply) {
    Write-AclPlan
    Write-Output 'The service remains STOPPED and no ACL or filesystem mutation was performed. Re-run with -Apply only after Owner/admin approval.'
    exit 0
}

try {
    $serviceSid = Resolve-IdentityRef $ServiceIdentity
} catch {
    throw "service identity could not be resolved; register the service with an unrestricted service SID first or pass the service SID explicitly: $ServiceIdentity"
}
if ($OperatorIdentity) {
    try {
        $operatorSid = Resolve-IdentityRef $OperatorIdentity
    } catch {
        throw "operator identity could not be resolved: $OperatorIdentity"
    }
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'candidate config is missing' }
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) { throw 'candidate executable is missing' }
if (-not (Test-Path -LiteralPath $packagePath -PathType Container)) { throw 'candidate package directory is missing' }

if ($PSCmdlet.ShouldProcess($rootPath, 'apply protected runtime ACL model')) {
    $snapshotWritten = $false
    try {
        # A snapshot left over from an earlier apply is protected. Remove it
        # first (owner fallback re-grants delete) so this run starts from the
        # current state and can write a fresh snapshot.
        if (Test-Path -LiteralPath $snapPath) { Remove-CreatedPath $snapPath }
        $entries = [System.Collections.Generic.List[object]]::new()
        foreach ($item in @($rootItem) + @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force)) {
            $entries.Add([pscustomobject]@{
                path = $item.FullName
                kind = $(if ($item.PSIsContainer) { 'Directory' } else { 'File' })
                existed = $true
                sddl = (Get-Acl -LiteralPath $item.FullName).Sddl
            })
        }
        foreach ($dir in @($statePath, $hostStatePath, $logsPath)) {
            if (-not (Test-Path -LiteralPath $dir)) {
                $entries.Add([pscustomobject]@{ path = $dir; kind = 'Directory'; existed = $false; sddl = $null })
            }
        }
        $snapshotDoc = [pscustomobject]@{
            schema = 1
            model = $model
            generatedUtc = [DateTime]::UtcNow.ToString('o')
            serviceIdentity = $serviceSid.Value
            root = $rootPath
            entries = $entries
        }
        $snapParent = Split-Path -Path $snapPath -Parent
        $snapParentPreGrant = Get-Acl -LiteralPath $snapParent
        try {
            # The snapshot parent (by default package\) may already be protected
            # by an earlier apply. Temporarily grant create rights; the apply
            # loop below re-protects it, and a failed write reverts the grant.
            $meSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            & icacls $snapParent /inheritance:e 2>&1 | Out-Null
            & icacls $snapParent /grant:r "*${meSid}:(OI)(CI)F" 2>&1 | Out-Null
            $snapshotDoc | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $snapPath -Encoding ascii
        } catch {
            try {
                $revertSddl = $snapParentPreGrant.Sddl
                $revertSddl = $revertSddl.Substring($revertSddl.IndexOf('D:'))
                $revertAcl = New-Object System.Security.AccessControl.DirectorySecurity
                $revertAcl.SetSecurityDescriptorSddlForm($revertSddl)
                Set-PathDacl $snapParent $revertAcl
            } catch { }
            throw
        }
        $snapshotWritten = $true

        # Pre-stage structural runtime directories (state, exact host-state,
        # logs) as empty protected surfaces before the ACL pass below.
        foreach ($dir in @($statePath, $hostStatePath, $logsPath)) {
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        }

        $applied = 0
        # Deepest paths first: protecting a directory removes inherited traversal
        # rights, so its children must already carry their final ACL before the
        # directory itself is protected (keeps -Apply usable without elevation).
        foreach ($item in (@($rootItem) + @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force)) | Sort-Object { $_.FullName.Length } -Descending) {
            $acl = New-DesiredAcl $item.FullName $item.PSIsContainer
            Set-PathDacl $item.FullName $acl
            $applied++
        }
        Write-Output "ACL_APPLIED model=$model surfaces=$applied snapshot=$snapPath service_identity=$($serviceSid.Value)"
    } catch {
        $failure = $_.Exception.Message
        if ($snapshotWritten) {
            $restoreResult = 'ok'
            try { Restore-AclSnapshot $snapPath } catch { $restoreResult = "failed: $($_.Exception.Message)" }
            if ($restoreResult -eq 'ok') { throw "ACL preparation failed: $failure; snapshot restored from $snapPath" }
            throw "ACL preparation failed: $failure; snapshot restore failed: $restoreResult"
        }
        throw "ACL preparation failed before snapshot: $failure"
    }
}
