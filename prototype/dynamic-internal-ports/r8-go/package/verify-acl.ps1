[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Root,
    [string] $ServiceIdentity = 'NT SERVICE\WinHelmGoTlsIngressHardeningR1',
    [string] $OperatorIdentity,
    [switch] $OperatorStateRead,
    [string] $StateDir,
    [string] $LogsDir
)

$ErrorActionPreference = 'Stop'
$model = 'WINHELM_R7_R3_ACL_MODEL'
$broadSids = @{ 'S-1-5-11' = 'AU'; 'S-1-5-32-545' = 'BU'; 'S-1-1-0' = 'WD'; 'S-1-5-7' = 'AN' }
$systemSidValue = 'S-1-5-18'
$adminSidValue = 'S-1-5-32-544'

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

function Get-RuleSidValue($Rule) {
    try { return $Rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $null }
}

function Test-WriteRights($Rule) {
    return ($Rule.FileSystemRights.ToString() -match 'Write|Modify|FullControl')
}

$failures = [System.Collections.Generic.List[string]]::new()
function Add-Failure([string] $Class, [string] $Surface, [string] $Detail) {
    $line = "FAIL class=$Class surface=$Surface"
    if ($Detail) { $line += " detail=$Detail" }
    if (-not $failures.Contains($line)) { $failures.Add($line) | Out-Null }
}

$rootItem = Get-Item -LiteralPath $Root -ErrorAction Stop
if (-not $rootItem.PSIsContainer) { throw 'candidate root must be a directory' }
$rootPath = $rootItem.FullName.TrimEnd([char]92, [char]47)
$configPath = Join-Path $rootPath 'config.json'
$binaryPath = Join-Path $rootPath 'winhelm-go-tls-ingress-hardening-r1.exe'
$packagePath = Join-Path $rootPath 'package'
$statePath = Resolve-RootPathValue $StateDir (Join-Path $rootPath 'state') 'state directory'
$logsPath = Resolve-RootPathValue $LogsDir (Join-Path $rootPath 'logs') 'logs directory'
$hostStatePath = $null
try { $hostStatePath = Get-HostStatePath $configPath $statePath } catch { Add-Failure 'HOST_STATE_UNDERIVED' 'state' ("detail=" + $_.Exception.Message) }

$serviceSid = $null
try { $serviceSid = Resolve-IdentityRef $ServiceIdentity } catch { Add-Failure 'SERVICE_IDENTITY_UNRESOLVED' 'n/a' ("identity=" + $ServiceIdentity) }
$operatorSid = $null
if ($OperatorIdentity) {
    try { $operatorSid = Resolve-IdentityRef $OperatorIdentity } catch { Add-Failure 'OPERATOR_IDENTITY_UNRESOLVED' 'n/a' ("identity=" + $OperatorIdentity) }
}

$requiredSurfaces = @(
    @{ Path = $configPath; Name = 'config.json' },
    @{ Path = $binaryPath; Name = 'executable' },
    @{ Path = $packagePath; Name = 'package' },
    @{ Path = $statePath; Name = 'state' },
    @{ Path = $logsPath; Name = 'logs' }
)
if ($null -ne $hostStatePath) { $requiredSurfaces += @{ Path = $hostStatePath; Name = 'host-state' } }
foreach ($required in $requiredSurfaces) {
    if (-not (Test-Path -LiteralPath $required.Path)) { Add-Failure 'SURFACE_MISSING' $required.Name }
}

$walkItems = $null
try {
    $walkItems = @($rootItem) + @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force -ErrorAction Stop)
} catch {
    Add-Failure 'WALK_DENIED' 'tree' ("detail=" + $_.Exception.Message)
}
if ($null -ne $walkItems) {
    foreach ($item in $walkItems) {
        $path = $item.FullName
        $surface = if ($path -eq $rootPath) { 'root' } elseif (Test-UnderPath $path $rootPath) { $path.Substring($rootPath.Length + 1) } else { $path }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Add-Failure 'REPARSE_PATH' $surface
            continue
        }
        $acl = $null
        try { $acl = Get-Acl -LiteralPath $path } catch { Add-Failure 'ACL_READ_DENIED' $surface; continue }
        # Canonical surfaces (candidate root, config, executable, package, state
        # root, exact host-state directory, logs root) must carry a protected
        # DACL. Runtime descendants strictly beneath host-state/logs may
        # inherit the protected root ACL instead; their effective ACL is still
        # checked below (no broad write, service identity present, no reparse),
        # so an inherited-safe runtime child is not reported as a failure.
        $relaxedInheritance = (Test-UnderPath $path $logsPath) -and ($path -ne $logsPath)
        if ($null -ne $hostStatePath) { $relaxedInheritance = $relaxedInheritance -or ((Test-UnderPath $path $hostStatePath) -and ($path -ne $hostStatePath)) }
        if (-not $relaxedInheritance -and $acl.AreAccessRulesProtected -ne $true) { Add-Failure 'INHERITANCE_ENABLED' $surface }
        $inState = Test-UnderPath $path $statePath
        $inLogs = Test-UnderPath $path $logsPath
        $serviceSeen = $false
        $serviceWrite = $false
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -ne 'Allow') { continue }
            $sid = Get-RuleSidValue $rule
            if ($null -eq $sid) { continue }
            $writey = Test-WriteRights $rule
            if ($broadSids.ContainsKey($sid) -and $writey) {
                Add-Failure 'BROAD_WRITE' $surface ("principal=" + $broadSids[$sid])
            }
            if ($null -ne $serviceSid -and $sid -eq $serviceSid.Value) {
                $serviceSeen = $true
                if ($writey) {
                    $serviceWrite = $true
                    if (-not ($inState -or $inLogs)) { Add-Failure 'SERVICE_WRITE_ON_IMMUTABLE' $surface }
                }
            }
            if ($null -ne $operatorSid -and $sid -eq $operatorSid.Value) {
                if ($writey) { Add-Failure 'OPERATOR_WRITE' $surface }
                if ($inState -and $path -eq $statePath -and -not $OperatorStateRead) { Add-Failure 'OPERATOR_STATE_ACCESS_UNJUSTIFIED' $surface }
            }
        }
        if ($null -ne $serviceSid -and -not $serviceSeen) { Add-Failure 'SERVICE_IDENTITY_MISSING' $surface }
        if ($null -ne $serviceSid -and ($path -eq $statePath -or $path -eq $logsPath -or ($null -ne $hostStatePath -and $path -eq $hostStatePath)) -and -not $serviceWrite) {
            Add-Failure 'SERVICE_WRITE_MISSING_ON_MUTABLE' $surface
        }
    }
}

$canonicalSurfaces = @($rootPath, $configPath, $binaryPath, $packagePath, $statePath, $logsPath)
if ($null -ne $hostStatePath) { $canonicalSurfaces += $hostStatePath }
foreach ($canonical in $canonicalSurfaces) {
    if (-not (Test-Path -LiteralPath $canonical)) { continue }
    $surface = if ($canonical -eq $rootPath) { 'root' } else { $canonical.Substring($rootPath.Length + 1) }
    $acl = $null
    try { $acl = Get-Acl -LiteralPath $canonical } catch { Add-Failure 'ACL_READ_DENIED' $surface; continue }
    $systemFull = $false
    $adminFull = $false
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        $sid = Get-RuleSidValue $rule
        if ($null -eq $sid) { continue }
        if ($sid -eq $systemSidValue -and $rule.FileSystemRights.ToString() -match 'FullControl') { $systemFull = $true }
        if ($sid -eq $adminSidValue -and $rule.FileSystemRights.ToString() -match 'FullControl') { $adminFull = $true }
    }
    if (-not $systemFull) { Add-Failure 'ADMIN_CONTROL_MISSING' $surface 'principal=SYSTEM' }
    if (-not $adminFull) { Add-Failure 'ADMIN_CONTROL_MISSING' $surface 'principal=Administrators' }
}

if ($failures.Count -gt 0) {
    $failures | Sort-Object | ForEach-Object { Write-Output $_ }
    Write-Output ("FAIL count=" + $failures.Count + " model=$model")
    exit 1
}
Write-Output "PASS class=acl_floor model=$model"
exit 0
