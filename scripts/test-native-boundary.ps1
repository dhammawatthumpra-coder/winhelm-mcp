[CmdletBinding()]
param(
    [string]$BuildRoot = "D:\mcp\winhelm-native-build\m2a-nb1",
    [ValidateSet("Release","Debug")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "build-native-boundary.ps1") -BuildRoot $BuildRoot -Configuration $Configuration

$buildDir = Join-Path $BuildRoot $Configuration
$prod = Join-Path $buildDir "$Configuration\winhelm_native.node"
$test = Join-Path $buildDir "$Configuration\winhelm_native_test.node"

$env:WINHELM_NATIVE_PROD_ADDON = $prod
$env:WINHELM_NATIVE_TEST_ADDON = $test

$testFile = Join-Path (Split-Path -Parent $PSScriptRoot) "native\test\native-boundary.test.mjs"
& node --test $testFile
if ($LASTEXITCODE -ne 0) {
    throw "Native boundary conformance tests failed: $LASTEXITCODE"
}
