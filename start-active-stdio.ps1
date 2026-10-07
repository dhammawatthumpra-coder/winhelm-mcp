# WinHelm tracked active-stdio launcher (M3A-P2).
#
# Contract:
#   - resolves the active-backend marker (default <launcher root>\temp\winhelm.active-backend.json,
#     overridable via WINHELM_ACTIVE_BACKEND_MARKER for tests/transition);
#   - validates the marker schema (schemaVersion 1), backendRoot, configPath,
#     the built dist\index.js, and — when expectedHead is present — the exact
#     Git HEAD of the backend repository;
#   - executes the exact built entrypoint in stdio mode with the exact config
#     path, resolving node.exe explicitly (WINHELM_NODE_EXECUTABLE_PATH wins);
#   - preserves the child exit code; diagnostics go to stderr only;
#   - never prints auth tokens, config contents, or any secret values;
#   - fails closed on every missing/malformed/stale input.

param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail-Stdio([string]$Message) {
    [Console]::Error.WriteLine("[winhelm active-stdio] $Message")
    exit 1
}

$LauncherRoot = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$MarkerPath = [System.Environment]::GetEnvironmentVariable("WINHELM_ACTIVE_BACKEND_MARKER")
if ([string]::IsNullOrWhiteSpace($MarkerPath)) {
    $MarkerPath = Join-Path $LauncherRoot "temp\winhelm.active-backend.json"
}

if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
    Fail-Stdio "Active-backend marker not found: $MarkerPath"
}

$rawMarker = $null
try {
    $rawMarker = [System.IO.File]::ReadAllText($MarkerPath)
} catch {
    Fail-Stdio "Cannot read active-backend marker: $($_.Exception.Message)"
}

$spec = $null
try {
    $spec = $rawMarker | ConvertFrom-Json
} catch {
    Fail-Stdio "Cannot parse active-backend marker as JSON: $($_.Exception.Message)"
}

$schemaVersion = $null
try {
    if ($null -ne $spec.schemaVersion) { $schemaVersion = [int]$spec.schemaVersion }
} catch {
    Fail-Stdio "Active-backend marker schemaVersion is not an integer"
}
if ($null -eq $schemaVersion) {
    Fail-Stdio "Active-backend marker is missing schemaVersion"
}
if ($schemaVersion -ne 1) {
    Fail-Stdio "Unsupported active-backend marker schemaVersion: $schemaVersion"
}

$backendRoot = ""
$configPath = ""
$expectedHead = ""
try {
    if ($null -ne $spec.backendRoot) { $backendRoot = [string]$spec.backendRoot }
    if ($null -ne $spec.configPath) { $configPath = [string]$spec.configPath }
    if ($null -ne $spec.expectedHead) { $expectedHead = [string]$spec.expectedHead }
} catch {
    Fail-Stdio "Active-backend marker is missing required fields"
}
if ([string]::IsNullOrWhiteSpace($backendRoot)) {
    Fail-Stdio "Active-backend marker is missing backendRoot"
}
if ([string]::IsNullOrWhiteSpace($configPath)) {
    Fail-Stdio "Active-backend marker is missing configPath"
}

if (-not (Test-Path -LiteralPath $backendRoot -PathType Container)) {
    Fail-Stdio "Active backend root is unavailable: $backendRoot"
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Fail-Stdio "Active config is unavailable: $configPath"
}

$indexPath = Join-Path $backendRoot "dist\index.js"
if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    Fail-Stdio "Active backend is not built (missing dist): $indexPath"
}

if (-not [string]::IsNullOrWhiteSpace($expectedHead)) {
    $actualHead = $null
    try {
        $gitOutput = & git -C $backendRoot rev-parse HEAD 2>$null
        if ($LASTEXITCODE -ne 0) {
            Fail-Stdio "Cannot verify active backend HEAD (git rev-parse failed)"
        }
        $actualHead = ([string](@($gitOutput)[0])).Trim().ToLowerInvariant()
    } catch {
        Fail-Stdio "Cannot verify active backend HEAD"
    }
    if ([string]::IsNullOrWhiteSpace($actualHead)) {
        Fail-Stdio "Cannot verify active backend HEAD (empty git output)"
    }
    if ($actualHead -ne $expectedHead.Trim().ToLowerInvariant()) {
        Fail-Stdio "Active backend HEAD mismatch. expected=$($expectedHead.Trim().ToLowerInvariant()) actual=$actualHead"
    }
}

$nodeExecutable = [System.Environment]::GetEnvironmentVariable("WINHELM_NODE_EXECUTABLE_PATH")
if (-not [string]::IsNullOrWhiteSpace($nodeExecutable)) {
    if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
        Fail-Stdio "WINHELM_NODE_EXECUTABLE_PATH does not point to a file: $nodeExecutable"
    }
} else {
    $resolved = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $resolved) {
        Fail-Stdio "Cannot resolve node.exe; set WINHELM_NODE_EXECUTABLE_PATH explicitly"
    }
    $nodeExecutable = $resolved.Source
}

try {
    Push-Location -LiteralPath $backendRoot
} catch {
    Fail-Stdio "Cannot enter active backend root: $backendRoot"
}

try {
    & $nodeExecutable $indexPath --stdio --config $configPath
    $childExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

exit $childExitCode
