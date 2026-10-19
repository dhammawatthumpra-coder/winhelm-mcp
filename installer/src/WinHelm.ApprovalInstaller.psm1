# WinHelm.ApprovalInstaller.psm1
# Windows Approval UX Installer / Setup Assistant Integration Module
# Version: 1.4.1 (Option B: Non-Authoritative Receipt / Reduced Destructive Restoration Model)

Set-StrictMode -Version 2.0

$script:ModuleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:DefaultAppUserModelId = "WinHelm"
$script:DefaultProtocolKey = "HKCU:\Software\Classes\winhelm-approval"
$script:ReceiptFileName = ".winhelm-installer-receipt.json"

# Ensure ShortcutHelper type is compiled
function Initialize-ShortcutHelper {
    if (-not ([System.Management.Automation.PSTypeName]'WinHelm.Installer.ShortcutHelper').Type) {
        $csPath = Join-Path $script:ModuleDir "ShortcutHelper.cs"
        if (-not (Test-Path -LiteralPath $csPath -PathType Leaf)) {
            throw "ShortcutHelper.cs not found at: $csPath"
        }
        $csCode = Get-Content -LiteralPath $csPath -Raw -ErrorAction Stop
        Add-Type -TypeDefinition $csCode -ErrorAction Stop
    }
}

function Get-CanonicalPath {
    param([Parameter(Mandatory=$true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Get-FileSha256Hex {
    param([Parameter(Mandatory=$true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}

function Get-DefaultNodeExe {
    try {
        $node = (Get-Command node -ErrorAction Stop).Source
        if ($node -and (Test-Path -LiteralPath $node -PathType Leaf)) {
            return Get-CanonicalPath $node
        }
    } catch {}

    $stdNode = "C:\Program Files\nodejs\node.exe"
    if (Test-Path -LiteralPath $stdNode -PathType Leaf) {
        return Get-CanonicalPath $stdNode
    }

    if ([Environment]::ProcessPath -and [Environment]::ProcessPath.EndsWith("node.exe", [StringComparison]::OrdinalIgnoreCase)) {
        return Get-CanonicalPath [Environment]::ProcessPath
    }

    throw "Node.js executable could not be resolved. Please specify -NodePath."
}

function Get-DefaultProgramsShortcut {
    $programs = [Environment]::GetFolderPath('Programs')
    return (Join-Path $programs "WinHelm.lnk")
}

function Build-ProtocolCommand {
    param(
        [Parameter(Mandatory=$true)][string]$NodeExe,
        [Parameter(Mandatory=$true)][string]$EntrypointPath
    )
    $nodeCanonical = Get-CanonicalPath $NodeExe
    $entryCanonical = Get-CanonicalPath $EntrypointPath
    $shim = "data:text/javascript;base64,aW1wb3J0e3BhdGhUb0ZpbGVVUkx9ZnJvbSdub2RlOnVybCc7aWYocHJvY2Vzcy5hcmd2WzFdKXtjb25zdCBwPXBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5hcmd2WzFdKS5wYXRobmFtZTtwcm9jZXNzLmFyZ3ZbMV09cHJvY2Vzcy5wbGF0Zm9ybT09PSd3aW4zMic/cC5zbGljZSgxKTpwO30="
    return "`"$nodeCanonical`" --import `"$shim`" `"$entryCanonical`" approval-activate `"%1`""
}

function Get-RegistryProtocolState {
    param([Parameter(Mandatory=$true)][string]$RegistryRoot)
    $state = [PSCustomObject]@{
        Existed = $false
        DefaultValue = $null
        UrlProtocolValue = $null
        CommandValue = $null
        HasCommandSubkey = $false
        IsMalformed = $false
    }

    if (-not (Test-Path -LiteralPath $RegistryRoot)) {
        return $state
    }

    $state.Existed = $true
    try {
        $keyItem = Get-Item -LiteralPath $RegistryRoot -ErrorAction Stop
        $state.DefaultValue = $keyItem.GetValue("")
        $state.UrlProtocolValue = $keyItem.GetValue("URL Protocol")

        $cmdPath = Join-Path $RegistryRoot "shell\open\command"
        if (Test-Path -LiteralPath $cmdPath) {
            $state.HasCommandSubkey = $true
            $cmdItem = Get-Item -LiteralPath $cmdPath -ErrorAction Stop
            $state.CommandValue = $cmdItem.GetValue("")
        }
    } catch {
        $state.IsMalformed = $true
    }

    return $state
}

function Get-ShortcutState {
    param([Parameter(Mandatory=$true)][string]$ShortcutPath)
    Initialize-ShortcutHelper
    $details = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($ShortcutPath)
    return [PSCustomObject]@{
        Existed = $details.Exists
        ShortcutPath = $ShortcutPath
        TargetPath = $details.TargetPath
        Arguments = $details.Arguments
        WorkingDirectory = $details.WorkingDirectory
        AppUserModelId = $details.AppUserModelId
    }
}

# =========================================================================
# DETERMINISTIC EXPECTED STATE GENERATORS (R5 Option B)
# Inputs are explicit; expected state is NEVER derived from receipt.
# =========================================================================

function Get-ExpectedWinHelmProtocolState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$NodePath,
        [string]$RegistryRoot = $script:DefaultProtocolKey
    )
    $installRootCanon = Get-CanonicalPath $InstallRoot
    $nodeExe = if ($NodePath) { Get-CanonicalPath $NodePath } else { try { Get-DefaultNodeExe } catch { $null } }
    $entrypoint = Join-Path $installRootCanon "dist\index.js"
    $entrypointExists = (Test-Path -LiteralPath $entrypoint -PathType Leaf)
    $expectedCmd = if ($nodeExe -and $entrypointExists) {
        Build-ProtocolCommand -NodeExe $nodeExe -EntrypointPath $entrypoint
    } else {
        $null
    }
    return [PSCustomObject]@{
        RegistryRoot = $RegistryRoot
        NodeExe = $nodeExe
        EntrypointPath = $entrypoint
        EntrypointExists = $entrypointExists
        ExpectedCommand = $expectedCmd
    }
}

function Get-ExpectedWinHelmShortcutState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$NodePath,
        [string]$ShortcutPath,
        [string]$AppUserModelId = $script:DefaultAppUserModelId
    )
    $installRootCanon = Get-CanonicalPath $InstallRoot
    $nodeExe = if ($NodePath) { Get-CanonicalPath $NodePath } else { try { Get-DefaultNodeExe } catch { $null } }
    if (-not $ShortcutPath) { $ShortcutPath = Get-DefaultProgramsShortcut }
    $entrypoint = Join-Path $installRootCanon "dist\index.js"
    $entrypointExists = (Test-Path -LiteralPath $entrypoint -PathType Leaf)
    return [PSCustomObject]@{
        ShortcutPath = $ShortcutPath
        TargetPath = $nodeExe
        Arguments = "`"$entrypoint`""
        WorkingDirectory = $installRootCanon
        AppUserModelId = $AppUserModelId
        EntrypointPath = $entrypoint
        EntrypointExists = $entrypointExists
    }
}

# =========================================================================
# DETERMINISTIC OWNERSHIP CLASSIFIERS
# Compares current live Windows state against deterministic expected state.
# =========================================================================

function Test-CurrentProtocolAgainstExpectedState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$CurrentRegistryState,
        [string]$ExpectedCommand
    )
    $result = [PSCustomObject]@{
        Existed = $CurrentRegistryState.Existed
        HasCommandSubkey = $CurrentRegistryState.HasCommandSubkey
        CurrentCommand = $CurrentRegistryState.CommandValue
        ExpectedCommand = $ExpectedCommand
        IsExactOwned = $false
        IsOwned = $false
        IsMissing = $false
        IsConflict = $false
        Reason = ""
    }

    if (-not $CurrentRegistryState.Existed) {
        $result.IsMissing = $true
        $result.Reason = "Protocol registry key does not exist."
        return $result
    }

    if ([string]::IsNullOrEmpty($CurrentRegistryState.CommandValue)) {
        $result.IsMissing = $true
        $result.Reason = "Protocol command value is missing or empty."
        return $result
    }

    # Case-insensitive exact string match
    if ($ExpectedCommand -and ($CurrentRegistryState.CommandValue -eq $ExpectedCommand)) {
        $result.IsExactOwned = $true
        $result.IsOwned = $true
        $result.Reason = "Protocol command matches expected installed command exactly."
        return $result
    }

    # Material mismatch -> CONFLICT
    $result.IsConflict = $true
    $result.Reason = "Protocol command exists but materially differs from expected command ($($CurrentRegistryState.CommandValue))."
    return $result
}

function Test-CurrentShortcutAgainstExpectedState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$CurrentShortcutState,
        [string]$ExpectedTarget,
        [string]$ExpectedArguments,
        [string]$ExpectedWorkingDirectory,
        [string]$ExpectedAppUserModelId = $script:DefaultAppUserModelId,
        [string]$ExpectedShortcutPath
    )

    $result = [PSCustomObject]@{
        Existed = $CurrentShortcutState.Existed
        ShortcutPath = $CurrentShortcutState.ShortcutPath
        TargetPath = $CurrentShortcutState.TargetPath
        Arguments = $CurrentShortcutState.Arguments
        WorkingDirectory = $CurrentShortcutState.WorkingDirectory
        AppUserModelId = $CurrentShortcutState.AppUserModelId
        ExpectedTarget = $ExpectedTarget
        ExpectedArguments = $ExpectedArguments
        ExpectedWorkingDirectory = $ExpectedWorkingDirectory
        ExpectedAppUserModelId = $ExpectedAppUserModelId
        ExpectedShortcutPath = $ExpectedShortcutPath
        TargetMatches = $false
        ArgumentsMatch = $false
        WorkingDirMatches = $false
        AumidMatches = $false
        ShortcutPathMatches = $false
        IsExactOwned = $false
        IsOwned = $false
        IsAumidDrift = $false
        IsMissing = $false
        IsConflict = $false
        Reason = ""
    }

    if (-not $CurrentShortcutState.Existed) {
        $result.IsMissing = $true
        $result.Reason = "Shortcut file does not exist."
        return $result
    }

    # Canonical path comparisons
    $currTargetCanon = if ($CurrentShortcutState.TargetPath) {
        try { [System.IO.Path]::GetFullPath($CurrentShortcutState.TargetPath) } catch { $CurrentShortcutState.TargetPath }
    } else { "" }
    $expTargetCanon = if ($ExpectedTarget) {
        try { [System.IO.Path]::GetFullPath($ExpectedTarget) } catch { $ExpectedTarget }
    } else { "" }

    $currWorkCanon = if ($CurrentShortcutState.WorkingDirectory) {
        try { [System.IO.Path]::GetFullPath($CurrentShortcutState.WorkingDirectory) } catch { $CurrentShortcutState.WorkingDirectory }
    } else { "" }
    $expWorkCanon = if ($ExpectedWorkingDirectory) {
        try { [System.IO.Path]::GetFullPath($ExpectedWorkingDirectory) } catch { $ExpectedWorkingDirectory }
    } else { "" }

    $result.TargetMatches = ($currTargetCanon -and $expTargetCanon -and ($currTargetCanon -eq $expTargetCanon))
    $result.ArgumentsMatch = ($CurrentShortcutState.Arguments -and $ExpectedArguments -and ($CurrentShortcutState.Arguments -eq $ExpectedArguments))
    $result.WorkingDirMatches = ($currWorkCanon -eq $expWorkCanon)
    $result.AumidMatches = ($CurrentShortcutState.AppUserModelId -eq $ExpectedAppUserModelId)

    if ($ExpectedShortcutPath -and $CurrentShortcutState.ShortcutPath) {
        $currScCanon = try { [System.IO.Path]::GetFullPath($CurrentShortcutState.ShortcutPath) } catch { $CurrentShortcutState.ShortcutPath }
        $expScCanon = try { [System.IO.Path]::GetFullPath($ExpectedShortcutPath) } catch { $ExpectedShortcutPath }
        $result.ShortcutPathMatches = ($currScCanon -eq $expScCanon)
    } else {
        $result.ShortcutPathMatches = $true
    }

    # Core execution identity: TargetPath + Arguments + WorkingDirectory + ShortcutPath
    if ($result.TargetMatches -and $result.ArgumentsMatch -and $result.WorkingDirMatches -and $result.ShortcutPathMatches) {
        if ($result.AumidMatches) {
            $result.IsExactOwned = $true
            $result.IsOwned = $true
            $result.Reason = "Shortcut matches expected installed WinHelm identity exactly."
            return $result
        } else {
            $result.IsOwned = $true
            $result.IsAumidDrift = $true
            $result.Reason = "Shortcut execution parameters match WinHelm exactly, but AppUserModelID differs ($($CurrentShortcutState.AppUserModelId) vs $ExpectedAppUserModelId)."
            return $result
        }
    }

    # Material mismatch -> CONFLICT
    $result.IsConflict = $true
    $result.Reason = "Shortcut exists but execution identity does not match WinHelm expected fingerprint (Target: '$currTargetCanon' vs '$expTargetCanon', Args: '$($CurrentShortcutState.Arguments)' vs '$ExpectedArguments', WorkDir: '$currWorkCanon' vs '$expWorkCanon')."
    return $result
}

function Test-ExactInstalledProtocolOwnership {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$CurrentRegistryState,
        $Receipt,
        [string]$ExpectedCommand
    )
    $expCmd = if ($ExpectedCommand) {
        $ExpectedCommand
    } elseif ($Receipt -and $Receipt.expectedProtocolCommand) {
        $Receipt.expectedProtocolCommand
    } elseif ($Receipt -and $Receipt.expectedHandlerCommand) {
        $Receipt.expectedHandlerCommand
    } else {
        $null
    }
    return (Test-CurrentProtocolAgainstExpectedState -CurrentRegistryState $CurrentRegistryState -ExpectedCommand $expCmd)
}

function Test-ExactInstalledShortcutOwnership {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$CurrentShortcutState,
        $Receipt,
        [string]$ExpectedTarget,
        [string]$ExpectedArguments,
        [string]$ExpectedWorkingDirectory,
        [string]$ExpectedAppUserModelId,
        [string]$ExpectedShortcutPath
    )

    $expTarget = if ($ExpectedTarget) {
        $ExpectedTarget
    } elseif ($Receipt -and $Receipt.expectedShortcutTarget) {
        $Receipt.expectedShortcutTarget
    } elseif ($Receipt -and $Receipt.nodeExePath) {
        $Receipt.nodeExePath
    } else {
        $null
    }

    $expArgs = if ($ExpectedArguments) {
        $ExpectedArguments
    } elseif ($Receipt -and $Receipt.expectedShortcutArguments) {
        $Receipt.expectedShortcutArguments
    } elseif ($Receipt -and $Receipt.entrypointPath) {
        "`"$($Receipt.entrypointPath)`""
    } else {
        $null
    }

    $expWorkDir = if ($ExpectedWorkingDirectory) {
        $ExpectedWorkingDirectory
    } elseif ($Receipt -and $Receipt.expectedShortcutWorkingDirectory) {
        $Receipt.expectedShortcutWorkingDirectory
    } elseif ($Receipt -and $Receipt.installRoot) {
        $Receipt.installRoot
    } else {
        $null
    }

    $expAumid = if ($ExpectedAppUserModelId) {
        $ExpectedAppUserModelId
    } elseif ($Receipt -and $Receipt.expectedAppUserModelId) {
        $Receipt.expectedAppUserModelId
    } elseif ($Receipt -and $Receipt.appUserModelId) {
        $Receipt.appUserModelId
    } else {
        $script:DefaultAppUserModelId
    }

    $expScPath = if ($ExpectedShortcutPath) {
        $ExpectedShortcutPath
    } elseif ($Receipt -and $Receipt.expectedShortcutPath) {
        $Receipt.expectedShortcutPath
    } elseif ($Receipt -and $Receipt.shortcutPath) {
        $Receipt.shortcutPath
    } else {
        $null
    }

    return (Test-CurrentShortcutAgainstExpectedState `
        -CurrentShortcutState $CurrentShortcutState `
        -ExpectedTarget $expTarget `
        -ExpectedArguments $expArgs `
        -ExpectedWorkingDirectory $expWorkDir `
        -ExpectedAppUserModelId $expAumid `
        -ExpectedShortcutPath $expScPath)
}

# =========================================================================
# ADVISORY RECEIPT MANAGEMENT (R5 Option B)
# Receipt is non-authoritative metadata for diagnostics & troubleshooting only.
# It does NOT authorize destructive ownership, repair, upgrade, or uninstall.
# =========================================================================

function Get-ReceiptVerificationResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$TrustAnchorRoot = $null
    )
    $installRootCanon = Get-CanonicalPath $InstallRoot
    $receiptPath = Join-Path $installRootCanon $script:ReceiptFileName

    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        return [PSCustomObject]@{
            IsValid = $false
            Status = "MISSING"
            Receipt = $null
            Reason = "Advisory receipt file does not exist at: $receiptPath"
        }
    }

    $rawContent = $null
    try {
        $rawContent = [System.IO.File]::ReadAllText($receiptPath, [System.Text.Encoding]::UTF8)
    } catch {
        return [PSCustomObject]@{
            IsValid = $false
            Status = "CORRUPTED"
            Receipt = $null
            Reason = "Failed to read advisory receipt file: $($_.Exception.Message)"
        }
    }

    if ([string]::IsNullOrWhiteSpace($rawContent)) {
        return [PSCustomObject]@{
            IsValid = $false
            Status = "CORRUPTED"
            Receipt = $null
            Reason = "Advisory receipt file is empty or truncated."
        }
    }

    $receipt = $null
    try {
        $receipt = $rawContent | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return [PSCustomObject]@{
            IsValid = $false
            Status = "CORRUPTED"
            Receipt = $null
            Reason = "Advisory receipt contains invalid or corrupted JSON: $($_.Exception.Message)"
        }
    }

    # Validate Schema
    if (-not $receipt.installRoot) {
        return [PSCustomObject]@{
            IsValid = $false
            Status = "INVALID_SCHEMA"
            Receipt = $receipt
            Reason = "Advisory receipt is missing required schema field (installRoot)."
        }
    }

    # Validate Installation Binding
    $receiptRootCanon = try { Get-CanonicalPath $receipt.installRoot } catch { $receipt.installRoot }
    if ($receiptRootCanon -ne $installRootCanon) {
        return [PSCustomObject]@{
            IsValid = $false
            Status = "BINDING_MISMATCH"
            Receipt = $receipt
            Reason = "Receipt installRoot '$($receipt.installRoot)' does not match current install root '$installRootCanon'."
        }
    }

    return [PSCustomObject]@{
        IsValid = $true
        Status = "PRESENT"
        Receipt = $receipt
        Reason = "Advisory receipt is present and well-formed (non-authoritative metadata)."
    }
}

function Read-Receipt {
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$TrustAnchorRoot = $null
    )
    $res = Get-ReceiptVerificationResult -InstallRoot $InstallRoot
    if ($res.IsValid) {
        return $res.Receipt
    }
    return $null
}

function Save-Receipt {
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][PSCustomObject]$Receipt
    )
    $installRootCanon = Get-CanonicalPath $InstallRoot
    $receiptPath = Join-Path $installRootCanon $script:ReceiptFileName
    $json = $Receipt | ConvertTo-Json -Depth 6
    Set-Content -LiteralPath $receiptPath -Value $json -Encoding UTF8 -Force -ErrorAction Stop
}

function Remove-Receipt {
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$InstallationId = $null
    )
    $installRootCanon = Get-CanonicalPath $InstallRoot
    $receiptPath = Join-Path $installRootCanon $script:ReceiptFileName
    if (Test-Path -LiteralPath $receiptPath) {
        Remove-Item -LiteralPath $receiptPath -Force -ErrorAction SilentlyContinue
    }
}

function Save-ReceiptAndAnchor {
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)][PSCustomObject]$Receipt,
        [string]$TrustAnchorRoot = $null
    )
    Save-Receipt -InstallRoot $InstallRoot -Receipt $Receipt
}

function Remove-ReceiptAndAnchor {
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$InstallationId = $null,
        [string]$TrustAnchorRoot = $null
    )
    Remove-Receipt -InstallRoot $InstallRoot -InstallationId $InstallationId
}

# =========================================================================
# STATUS INSPECTOR (R5 Option B)
# Operational integration state is governed strictly by LIVE CURRENT STATE.
# Receipt state is reported separately as non-authoritative advisory metadata.
# =========================================================================

function Get-WinHelmApprovalIntegrationStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$RegistryRoot = $script:DefaultProtocolKey,
        [string]$ShortcutPath,
        [string]$ExpectedAppUserModelId = $script:DefaultAppUserModelId,
        [string]$NodePath,
        [string]$TrustAnchorRoot = $null
    )

    $installRootCanon = Get-CanonicalPath $InstallRoot
    if (-not $ShortcutPath) { $ShortcutPath = Get-DefaultProgramsShortcut }

    $entrypoint = Join-Path $installRootCanon "dist\index.js"
    $entrypointExists = (Test-Path -LiteralPath $entrypoint -PathType Leaf)

    $nodeExe = if ($NodePath) { Get-CanonicalPath $NodePath } else { try { Get-DefaultNodeExe } catch { $null } }

    $expectedProto = Get-ExpectedWinHelmProtocolState -InstallRoot $installRootCanon -NodePath $nodeExe -RegistryRoot $RegistryRoot
    $expectedSc = Get-ExpectedWinHelmShortcutState -InstallRoot $installRootCanon -NodePath $nodeExe -ShortcutPath $ShortcutPath -AppUserModelId $ExpectedAppUserModelId

    $regState = Get-RegistryProtocolState -RegistryRoot $RegistryRoot
    $scState = Get-ShortcutState -ShortcutPath $ShortcutPath

    $regOwnership = Test-CurrentProtocolAgainstExpectedState -CurrentRegistryState $regState -ExpectedCommand $expectedProto.ExpectedCommand
    $scOwnership = Test-CurrentShortcutAgainstExpectedState `
        -CurrentShortcutState $scState `
        -ExpectedTarget $expectedSc.TargetPath `
        -ExpectedArguments $expectedSc.Arguments `
        -ExpectedWorkingDirectory $expectedSc.WorkingDirectory `
        -ExpectedAppUserModelId $expectedSc.AppUserModelId `
        -ExpectedShortcutPath $expectedSc.ShortcutPath

    $receiptCheck = Get-ReceiptVerificationResult -InstallRoot $installRootCanon
    $receiptState = switch ($receiptCheck.Status) {
        "PRESENT" { "present" }
        "MISSING" { "missing" }
        "CORRUPTED" { "corrupt" }
        "BINDING_MISMATCH" { "stale" }
        default { "advisory_only" }
    }

    $details = [PSCustomObject]@{
        installRoot = $installRootCanon
        entrypointPath = $entrypoint
        entrypointExists = $entrypointExists
        protocolRegistered = $regState.Existed
        commandRegistered = (-not [string]::IsNullOrEmpty($regState.CommandValue))
        commandMatches = $regOwnership.IsExactOwned
        shortcutExists = $scState.Existed
        appUserModelId = $scState.AppUserModelId
        aumidMatches = $scOwnership.AumidMatches
        isOwned = ($regOwnership.IsExactOwned -and $scOwnership.IsExactOwned)
        isForeignConflict = ($regOwnership.IsConflict -or $scOwnership.IsConflict)
        receiptStatus = $receiptCheck.Status
        receiptState = $receiptState
        receiptReason = $receiptCheck.Reason
    }

    if (-not $entrypointExists) {
        return [PSCustomObject]@{
            status = "unavailable"
            code = "HANDLER_FILE_MISSING"
            message = "WinHelm activation handler entrypoint not found at: $entrypoint"
            details = $details
        }
    }

    # Foreign Conflicts (Governed STRICTLY by Live Current State)
    if ($regOwnership.IsConflict) {
        return [PSCustomObject]@{
            status = "conflict"
            code = "FOREIGN_REGISTRATION_CONFLICT"
            message = $regOwnership.Reason
            details = $details
        }
    }

    if ($scOwnership.IsConflict) {
        return [PSCustomObject]@{
            status = "conflict"
            code = "FOREIGN_SHORTCUT_CONFLICT"
            message = $scOwnership.Reason
            details = $details
        }
    }

    # Both absent
    if (-not $regState.Existed -and -not $scState.Existed) {
        return [PSCustomObject]@{
            status = "unavailable"
            code = "NOT_CONFIGURED"
            message = "Native approval integration is not configured."
            details = $details
        }
    }

    # Exact Match on Both
    $protocolValid = ($regState.Existed -and $regState.HasCommandSubkey -and $regOwnership.IsExactOwned -and $regState.UrlProtocolValue -eq "")
    $shortcutValid = ($scState.Existed -and $scOwnership.IsExactOwned)

    if ($protocolValid -and $shortcutValid) {
        return [PSCustomObject]@{
            status = "ready"
            code = "OK"
            message = "Native approval integration is fully configured and ready."
            details = $details
        }
    }

    # Incomplete / Needs Repair (e.g. missing one component or AUMID drift)
    return [PSCustomObject]@{
        status = "needs_repair"
        code = "INTEGRATION_INCOMPLETE"
        message = "Native approval integration requires repair (missing shortcut, missing registry, or AUMID drift)."
        details = $details
    }
}

function Test-WinHelmApprovalNativeSelfCheck {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$NodeExe,
        [Parameter(Mandatory=$true)][string]$EntrypointPath
    )

    if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
        throw "Node executable not found for self-check: $NodeExe"
    }
    if (-not (Test-Path -LiteralPath $EntrypointPath -PathType Leaf)) {
        throw "Entrypoint file not found for self-check: $EntrypointPath"
    }

    $shim = "data:text/javascript;base64,aW1wb3J0e3BhdGhUb0ZpbGVVUkx9ZnJvbSdub2RlOnVybCc7aWYocHJvY2Vzcy5hcmd2WzFdKXtjb25zdCBwPXBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5hcmd2WzFdKS5wYXRobmFtZTtwcm9jZXNzLmFyZ3ZbMV09cHJvY2Vzcy5wbGF0Zm9ybT09PSd3aW4zMic/cC5zbGljZSgxKTpwO30="
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.Arguments = "--import `"$shim`" `"$EntrypointPath`" approval-activate"
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $workingDir = Split-Path -Parent (Split-Path -Parent $EntrypointPath)
    if (Test-Path -LiteralPath $workingDir) {
        $psi.WorkingDirectory = $workingDir
    }

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdOutTask = $proc.StandardOutput.ReadToEndAsync()
    $stdErrTask = $proc.StandardError.ReadToEndAsync()

    if (-not $proc.WaitForExit(10000)) {
        try { $proc.Kill() } catch {}
    }
    [void][System.Threading.Tasks.Task]::WaitAll(@($stdOutTask, $stdErrTask), 5000)
    $stdout = if ($stdOutTask.IsCompleted) { $stdOutTask.Result } else { "" }
    $stderr = if ($stdErrTask.IsCompleted) { $stdErrTask.Result } else { "" }

    $combined = "$stdout`n$stderr"
    if ($combined.Contains("Usage: winhelm approval-activate")) {
        return [PSCustomObject]@{
            Success = $true
            ExitCode = $proc.ExitCode
            Message = "Activation entrypoint verified successfully via usage probe."
        }
    }

    return [PSCustomObject]@{
        Success = $false
        ExitCode = $proc.ExitCode
        Message = "Activation self-check did not return expected activation syntax. Output: $combined"
    }
}

# =========================================================================
# INSTALLATION ENGINE (R5 Option B)
# Transactional install with in-memory rollback only.
# =========================================================================

function Install-WinHelmApprovalIntegration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$NodePath,
        [string]$RegistryRoot = $script:DefaultProtocolKey,
        [string]$ShortcutPath,
        [string]$AppUserModelId = $script:DefaultAppUserModelId,
        [string]$AllowTransitionFromInstallRoot = $null,
        [string]$TrustAnchorRoot = $null,
        [switch]$Force
    )

    Initialize-ShortcutHelper
    $installRootCanon = Get-CanonicalPath $InstallRoot
    if (-not (Test-Path -LiteralPath $installRootCanon -PathType Container)) {
        throw "Install root container does not exist: $installRootCanon"
    }

    $entrypoint = Join-Path $installRootCanon "dist\index.js"
    if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
        throw "WinHelm entrypoint dist\index.js not found in: $installRootCanon"
    }

    $nodeExe = if ($NodePath) { Get-CanonicalPath $NodePath } else { Get-DefaultNodeExe }
    if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
        throw "Node executable not found: $nodeExe"
    }

    if (-not $ShortcutPath) { $ShortcutPath = Get-DefaultProgramsShortcut }

    $entrySha = Get-FileSha256Hex -Path $entrypoint
    $expectedCommand = Build-ProtocolCommand -NodeExe $nodeExe -EntrypointPath $entrypoint

    # 1. Capture Pre-State in memory (for same-transaction rollback only)
    $preReg = Get-RegistryProtocolState -RegistryRoot $RegistryRoot
    $preSc = Get-ShortcutState -ShortcutPath $ShortcutPath

    # 2. Check Conflicts against Live State
    $regOwnership = Test-CurrentProtocolAgainstExpectedState -CurrentRegistryState $preReg -ExpectedCommand $expectedCommand
    $regTransitionAuthorized = $false
    if ($preReg.Existed -and $regOwnership.IsConflict) {
        if ($AllowTransitionFromInstallRoot) {
            $transOldProto = Get-ExpectedWinHelmProtocolState -InstallRoot $AllowTransitionFromInstallRoot -NodePath $nodeExe -RegistryRoot $RegistryRoot
            $transOldReg = Test-CurrentProtocolAgainstExpectedState -CurrentRegistryState $preReg -ExpectedCommand $transOldProto.ExpectedCommand
            if ($transOldReg.IsExactOwned) {
                $regTransitionAuthorized = $true
            }
        }
        if (-not $regTransitionAuthorized) {
            throw "CONFLICT: Protocol registration already exists with foreign or unowned command: $($preReg.CommandValue)"
        }
    }

    $scOwnership = Test-CurrentShortcutAgainstExpectedState `
        -CurrentShortcutState $preSc `
        -ExpectedTarget $nodeExe `
        -ExpectedArguments "`"$entrypoint`"" `
        -ExpectedWorkingDirectory $installRootCanon `
        -ExpectedAppUserModelId $AppUserModelId `
        -ExpectedShortcutPath $ShortcutPath

    $scTransitionAuthorized = $false
    if ($preSc.Existed -and $scOwnership.IsConflict) {
        if ($AllowTransitionFromInstallRoot) {
            $transOldSc = Get-ExpectedWinHelmShortcutState -InstallRoot $AllowTransitionFromInstallRoot -NodePath $nodeExe -ShortcutPath $ShortcutPath -AppUserModelId $AppUserModelId
            $transOldScCheck = Test-CurrentShortcutAgainstExpectedState `
                -CurrentShortcutState $preSc `
                -ExpectedTarget $transOldSc.TargetPath `
                -ExpectedArguments $transOldSc.Arguments `
                -ExpectedWorkingDirectory $transOldSc.WorkingDirectory `
                -ExpectedAppUserModelId $transOldSc.AppUserModelId `
                -ExpectedShortcutPath $transOldSc.ShortcutPath
            if ($transOldScCheck.IsExactOwned) {
                $scTransitionAuthorized = $true
            }
        }
        if (-not $scTransitionAuthorized) {
            throw "CONFLICT: Start menu shortcut exists and belongs to another application: $($preSc.TargetPath)"
        }
    }

    # 3. Transaction staging: Advisory Receipt (Non-Authoritative)
    $stagedReceipt = [PSCustomObject]@{
        schemaVersion = 5
        installationId = [System.Guid]::NewGuid().ToString()
        installedAt = (Get-Date).ToUniversalTime().ToString("o")
        installRoot = $installRootCanon
        nodeExePath = $nodeExe
        entrypointPath = $entrypoint
        protocolKey = $RegistryRoot
        expectedProtocolCommand = $expectedCommand
        expectedShortcutPath = $ShortcutPath
        expectedShortcutTarget = $nodeExe
        expectedShortcutArguments = "`"$entrypoint`""
        expectedShortcutWorkingDirectory = $installRootCanon
        expectedAppUserModelId = $AppUserModelId
        packageVersion = "1.4.1"
        entrypointSha256 = $entrySha
        advisoryNote = "Non-authoritative metadata. Live current state controls mutation."
    }

    $rollbackNeeded = $true
    try {
        # 4. Configure Start Menu Shortcut
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut(
            $ShortcutPath,
            $nodeExe,
            "`"$entrypoint`"",
            $installRootCanon,
            $AppUserModelId,
            "WinHelm Process Controller"
        )

        # 5. Configure Registry Protocol
        if (-not (Test-Path -LiteralPath $RegistryRoot)) {
            New-Item -Path $RegistryRoot -Force -ErrorAction Stop | Out-Null
        }
        Set-ItemProperty -LiteralPath $RegistryRoot -Name "(default)" -Value "URL:WinHelm Approval Protocol" -Force -ErrorAction Stop
        Set-ItemProperty -LiteralPath $RegistryRoot -Name "URL Protocol" -Value "" -Force -ErrorAction Stop

        $cmdKey = Join-Path $RegistryRoot "shell\open\command"
        if (-not (Test-Path -LiteralPath $cmdKey)) {
            New-Item -Path $cmdKey -Force -ErrorAction Stop | Out-Null
        }
        Set-ItemProperty -LiteralPath $cmdKey -Name "(default)" -Value $expectedCommand -Force -ErrorAction Stop

        # 6. Verify Readback
        $readReg = Get-RegistryProtocolState -RegistryRoot $RegistryRoot
        if ($readReg.CommandValue -ne $expectedCommand) {
            throw "Readback verification failed: Registry command does not match expected."
        }
        $readSc = Get-ShortcutState -ShortcutPath $ShortcutPath
        if ($readSc.AppUserModelId -ne $AppUserModelId) {
            throw "Readback verification failed: Shortcut AppUserModelID does not match expected."
        }

        # 7. Non-Secret Native Integration Self-Check
        $selfCheck = Test-WinHelmApprovalNativeSelfCheck -NodeExe $nodeExe -EntrypointPath $entrypoint
        if (-not $selfCheck.Success) {
            throw "Native integration self-check failed: $($selfCheck.Message)"
        }

        # 8. Save Advisory Receipt
        Save-Receipt -InstallRoot $installRootCanon -Receipt $stagedReceipt

        $rollbackNeeded = $false
        return [PSCustomObject]@{
            Status = "ready"
            Code = "INSTALL_SUCCESS"
            Message = "Native approval integration installed and verified successfully."
            Receipt = $stagedReceipt
        }
    }
    finally {
        if ($rollbackNeeded) {
            Write-Verbose "Installation failed; rolling back to pre-state captured in this transaction."
            if (-not $preReg.Existed) {
                if (Test-Path -LiteralPath $RegistryRoot) {
                    Remove-Item -LiteralPath $RegistryRoot -Recurse -Force -ErrorAction SilentlyContinue
                }
            } else {
                if ($preReg.CommandValue) {
                    $cmdKey = Join-Path $RegistryRoot "shell\open\command"
                    Set-ItemProperty -LiteralPath $cmdKey -Name "(default)" -Value $preReg.CommandValue -Force -ErrorAction SilentlyContinue
                }
            }

            if (-not $preSc.Existed) {
                if (Test-Path -LiteralPath $ShortcutPath) {
                    Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
                }
            } else {
                [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut(
                    $ShortcutPath,
                    $preSc.TargetPath,
                    $preSc.Arguments,
                    $preSc.WorkingDirectory,
                    $preSc.AppUserModelId,
                    "WinHelm"
                )
            }

            Remove-Receipt -InstallRoot $installRootCanon
        }
    }
}

# =========================================================================
# REPAIR ENGINE (R5 Option B)
# Repairs based strictly on LIVE CURRENT STATE.
# =========================================================================

function Repair-WinHelmApprovalIntegration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$RegistryRoot = $script:DefaultProtocolKey,
        [string]$ShortcutPath,
        [string]$NodePath,
        [string]$AppUserModelId = $script:DefaultAppUserModelId,
        [string]$TrustAnchorRoot = $null
    )

    $status = Get-WinHelmApprovalIntegrationStatus `
        -InstallRoot $InstallRoot `
        -RegistryRoot $RegistryRoot `
        -ShortcutPath $ShortcutPath `
        -ExpectedAppUserModelId $AppUserModelId `
        -NodePath $NodePath

    if ($status.status -eq "ready") {
        return [PSCustomObject]@{
            Status = "ready"
            Code = "ALREADY_VALID"
            Message = "Approval UX integration is already healthy; no repair needed."
        }
    }

    if ($status.status -eq "conflict") {
        throw "CONFLICT: Cannot repair: $($status.message)"
    }

    if ($status.status -ne "needs_repair") {
        throw "Cannot repair: status is '$($status.status)' ($($status.message))"
    }

    return (Install-WinHelmApprovalIntegration `
        -InstallRoot $InstallRoot `
        -NodePath $NodePath `
        -RegistryRoot $RegistryRoot `
        -ShortcutPath $ShortcutPath `
        -AppUserModelId $AppUserModelId)
}

# =========================================================================
# UPGRADE ENGINE (R5 Option B)
# Preflight validates live current state against deterministic OLD expected state.
# =========================================================================

function Update-WinHelmApprovalIntegration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$OldInstallRoot,
        [Parameter(Mandatory=$true)][string]$NewInstallRoot,
        [string]$RegistryRoot = $script:DefaultProtocolKey,
        [string]$ShortcutPath,
        [string]$NodePath,
        [string]$AppUserModelId = $script:DefaultAppUserModelId,
        [string]$TrustAnchorRoot = $null
    )

    $oldRootCanon = Get-CanonicalPath $OldInstallRoot
    $newRootCanon = Get-CanonicalPath $NewInstallRoot
    if ($oldRootCanon -eq $newRootCanon) {
        throw "Old and new install roots must differ for upgrade."
    }

    if (-not $ShortcutPath) { $ShortcutPath = Get-DefaultProgramsShortcut }
    $nodeExe = if ($NodePath) { Get-CanonicalPath $NodePath } else { Get-DefaultNodeExe }

    # 1. Deterministic Expected State of OLD WinHelm (derived from OldInstallRoot, NOT receipt!)
    $oldExpectedProto = Get-ExpectedWinHelmProtocolState -InstallRoot $oldRootCanon -NodePath $nodeExe -RegistryRoot $RegistryRoot
    $oldExpectedSc = Get-ExpectedWinHelmShortcutState -InstallRoot $oldRootCanon -NodePath $nodeExe -ShortcutPath $ShortcutPath -AppUserModelId $AppUserModelId

    $currentReg = Get-RegistryProtocolState -RegistryRoot $RegistryRoot
    $currentSc = Get-ShortcutState -ShortcutPath $ShortcutPath

    # 2. Check Live State against OLD Expected State
    if (-not $currentReg.Existed) {
        throw "CONFLICT: Protocol registration key is missing. Cannot perform in-place upgrade."
    }
    $regOwnership = Test-CurrentProtocolAgainstExpectedState -CurrentRegistryState $currentReg -ExpectedCommand $oldExpectedProto.ExpectedCommand
    if (-not $regOwnership.IsExactOwned) {
        throw "CONFLICT: Current protocol command does not match old installed WinHelm state ($($currentReg.CommandValue)). Preserving foreign or modified state."
    }

    if (-not $currentSc.Existed) {
        throw "CONFLICT: Current shortcut is missing. Cannot perform in-place upgrade."
    }
    $scOwnership = Test-CurrentShortcutAgainstExpectedState `
        -CurrentShortcutState $currentSc `
        -ExpectedTarget $oldExpectedSc.TargetPath `
        -ExpectedArguments $oldExpectedSc.Arguments `
        -ExpectedWorkingDirectory $oldExpectedSc.WorkingDirectory `
        -ExpectedAppUserModelId $oldExpectedSc.AppUserModelId `
        -ExpectedShortcutPath $oldExpectedSc.ShortcutPath
    if (-not $scOwnership.IsExactOwned) {
        throw "CONFLICT: Current shortcut does not match old installed WinHelm state (target: $($currentSc.TargetPath), args: $($currentSc.Arguments)). Preserving foreign or modified shortcut."
    }

    # Preflight Passed! Live state exactly matches OLD WinHelm.
    $preUpgradeReg = $currentReg
    $preUpgradeSc = $currentSc
    $rollbackNeeded = $true

    try {
        $res = Install-WinHelmApprovalIntegration `
            -InstallRoot $newRootCanon `
            -NodePath $nodeExe `
            -RegistryRoot $RegistryRoot `
            -ShortcutPath $ShortcutPath `
            -AppUserModelId $AppUserModelId `
            -AllowTransitionFromInstallRoot $oldRootCanon `
            -Force

        $newReceipt = Read-Receipt -InstallRoot $newRootCanon
        if ($newReceipt) {
            $newReceipt | Add-Member -MemberType NoteProperty -Name "upgradedFrom" -Value $oldRootCanon -Force
            Save-Receipt -InstallRoot $newRootCanon -Receipt $newReceipt
        }

        $rollbackNeeded = $false
        return [PSCustomObject]@{
            Status = "ready"
            Code = "UPGRADE_SUCCESS"
            Message = "Approval UX integration upgraded successfully."
            OldInstallRoot = $oldRootCanon
            NewInstallRoot = $newRootCanon
        }
    }
    finally {
        if ($rollbackNeeded) {
            Write-Verbose "Upgrade failed; rolling back to prior old installation state."
            if ($preUpgradeReg.CommandValue) {
                $cmdKey = Join-Path $RegistryRoot "shell\open\command"
                if (Test-Path -LiteralPath $cmdKey) {
                    Set-ItemProperty -LiteralPath $cmdKey -Name "(default)" -Value $preUpgradeReg.CommandValue -Force -ErrorAction SilentlyContinue
                }
            }
            if ($preUpgradeSc.Existed) {
                [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut(
                    $ShortcutPath,
                    $preUpgradeSc.TargetPath,
                    $preUpgradeSc.Arguments,
                    $preUpgradeSc.WorkingDirectory,
                    $preUpgradeSc.AppUserModelId,
                    "WinHelm"
                )
            }
            Remove-Receipt -InstallRoot $newRootCanon
        }
    }
}

# =========================================================================
# UNINSTALL ENGINE (R5 Option B)
# Deletes exact WinHelm integration state.
# Arbitrary persisted prior-state restoration is REMOVED from the contract.
# =========================================================================

function Uninstall-WinHelmApprovalIntegration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [string]$RegistryRoot = $script:DefaultProtocolKey,
        [string]$ShortcutPath,
        [string]$NodePath,
        [string]$AppUserModelId = $script:DefaultAppUserModelId,
        [string]$TrustAnchorRoot = $null
    )

    Initialize-ShortcutHelper
    $installRootCanon = Get-CanonicalPath $InstallRoot
    if (-not $ShortcutPath) { $ShortcutPath = Get-DefaultProgramsShortcut }
    $nodeExe = if ($NodePath) { Get-CanonicalPath $NodePath } else { try { Get-DefaultNodeExe } catch { $null } }

    # Deterministic CURRENT expected WinHelm state
    $expectedProto = Get-ExpectedWinHelmProtocolState -InstallRoot $installRootCanon -NodePath $nodeExe -RegistryRoot $RegistryRoot
    $expectedSc = Get-ExpectedWinHelmShortcutState -InstallRoot $installRootCanon -NodePath $nodeExe -ShortcutPath $ShortcutPath -AppUserModelId $AppUserModelId

    $currentReg = Get-RegistryProtocolState -RegistryRoot $RegistryRoot
    $currentSc = Get-ShortcutState -ShortcutPath $ShortcutPath

    # 1. Ownership preflight checks on Registry (Live State comparison)
    if ($currentReg.Existed) {
        $regOwnership = Test-CurrentProtocolAgainstExpectedState -CurrentRegistryState $currentReg -ExpectedCommand $expectedProto.ExpectedCommand
        if (-not $regOwnership.IsExactOwned) {
            throw "CONFLICT: Current protocol command was modified by another actor or does not belong to this installation ($($currentReg.CommandValue)). Preserving foreign state."
        }
    }

    # 2. Ownership preflight checks on Shortcut (Live State comparison)
    if ($currentSc.Existed) {
        $scOwnership = Test-CurrentShortcutAgainstExpectedState `
            -CurrentShortcutState $currentSc `
            -ExpectedTarget $expectedSc.TargetPath `
            -ExpectedArguments $expectedSc.Arguments `
            -ExpectedWorkingDirectory $expectedSc.WorkingDirectory `
            -ExpectedAppUserModelId $expectedSc.AppUserModelId `
            -ExpectedShortcutPath $expectedSc.ShortcutPath

        if (-not $scOwnership.IsExactOwned) {
            throw "CONFLICT: Current shortcut target or arguments were modified by another actor or belong to another application ($($currentSc.TargetPath)). Preserving foreign shortcut."
        }
    }

    # Both preflights passed (or components are absent)!
    # 3. Uninstall Protocol Registry (Delete exact WinHelm key; NO prior foreign state restoration from receipt!)
    if ($currentReg.Existed) {
        Remove-Item -LiteralPath $RegistryRoot -Recurse -Force -ErrorAction Stop
    }

    # 4. Uninstall Shortcut (Delete exact WinHelm shortcut; NO prior foreign state restoration from receipt!)
    if ($currentSc.Existed) {
        Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction Stop
    }

    # 5. Remove Advisory Receipt file
    Remove-Receipt -InstallRoot $installRootCanon

    return [PSCustomObject]@{
        Status = "uninstalled"
        Code = "UNINSTALL_SUCCESS"
        Message = "Native approval integration uninstalled safely."
    }
}

Export-ModuleMember -Function `
    Get-WinHelmApprovalIntegrationStatus, `
    Get-ExpectedWinHelmProtocolState, `
    Get-ExpectedWinHelmShortcutState, `
    Test-CurrentProtocolAgainstExpectedState, `
    Test-CurrentShortcutAgainstExpectedState, `
    Test-ExactInstalledProtocolOwnership, `
    Test-ExactInstalledShortcutOwnership, `
    Test-WinHelmApprovalNativeSelfCheck, `
    Install-WinHelmApprovalIntegration, `
    Repair-WinHelmApprovalIntegration, `
    Update-WinHelmApprovalIntegration, `
    Uninstall-WinHelmApprovalIntegration, `
    Initialize-ShortcutHelper, `
    Get-ReceiptVerificationResult, `
    Read-Receipt, `
    Save-Receipt, `
    Remove-Receipt, `
    Save-ReceiptAndAnchor, `
    Remove-ReceiptAndAnchor, `
    Get-CanonicalPath, `
    Build-ProtocolCommand
