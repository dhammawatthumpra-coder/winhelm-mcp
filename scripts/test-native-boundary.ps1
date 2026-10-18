[CmdletBinding()]
param(
    [string]$BuildRoot = "native/build",
    [ValidateSet("Release","Debug")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "build-native-boundary.ps1") -BuildRoot $BuildRoot -Configuration $Configuration

$buildDir = Join-Path $BuildRoot $Configuration
$prod = Join-Path $buildDir "$Configuration\winhelm_native.node"
$test = Join-Path $buildDir "$Configuration\winhelm_native_test.node"
$child = Join-Path $buildDir "$Configuration\a4_child.exe"
if (-not (Test-Path -LiteralPath $child)) { throw "Missing a4_child.exe test helper: $child" }

$env:WINHELM_NATIVE_PROD_ADDON = $prod
$env:WINHELM_NATIVE_TEST_ADDON = $test
$env:WINHELM_A4_CHILD = $child

$repoRoot = Split-Path -Parent $PSScriptRoot
$testFiles = @(
    (Join-Path $repoRoot "native\test\native-boundary.test.mjs"),
    (Join-Path $repoRoot "native\test\native-stdio-env.test.mjs")
)
& node --test @testFiles
if ($LASTEXITCODE -ne 0) {
    throw "Native boundary conformance tests failed: $LASTEXITCODE"
}
