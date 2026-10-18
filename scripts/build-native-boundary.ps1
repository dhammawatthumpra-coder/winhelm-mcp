[CmdletBinding()]
param(
    [string]$BuildRoot = "native/build",
    [ValidateSet("Release","Debug")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$expectedNode = "v24.15.0"
$actualNode = (& node --version).Trim()
if ($actualNode -ne $expectedNode) {
    throw "Exact Node runtime required: $expectedNode; observed: $actualNode"
}

$napi = (& node -p "process.versions.napi").Trim()
if ($napi -ne "10") {
    throw "Expected Node-API version 10 for Node v24.15.0; observed: $napi"
}

$vs = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
$msvc = Join-Path $vs "VC\Tools\MSVC\14.44.35207"
if (-not (Test-Path -LiteralPath $msvc)) {
    throw "Required MSVC v143 14.44.35207 not found: $msvc"
}

$sdkInclude = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0"
if (-not (Test-Path -LiteralPath $sdkInclude)) {
    throw "Required Windows SDK 10.0.26100.0 not found"
}

$nodeCache = Join-Path $env:LOCALAPPDATA "node-gyp\Cache\24.15.0"
$nodeInclude = Join-Path $nodeCache "include\node"
$nodeLib = Join-Path $nodeCache "x64\node.lib"

if (-not (Test-Path -LiteralPath (Join-Path $nodeInclude "node_api.h"))) {
    throw "Exact Node v24.15.0 node_api.h not found in node-gyp cache"
}
if (-not (Test-Path -LiteralPath $nodeLib)) {
    throw "Exact Node v24.15.0 x64 node.lib not found in node-gyp cache"
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$nativeSource = Join-Path $sourceRoot "native"
$buildDir = Join-Path $BuildRoot $Configuration

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$configureArgs = @(
    "-S", $nativeSource,
    "-B", $buildDir,
    "-G", "Visual Studio 17 2022",
    "-A", "x64",
    "-T", "v143,version=14.44.35207",
    "-DCMAKE_SYSTEM_VERSION=10.0.26100.0",
    "-DNODE_INCLUDE_DIR=$nodeInclude",
    "-DNODE_LIB_FILE=$nodeLib"
)
& cmake @configureArgs
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed: $LASTEXITCODE" }

& cmake --build $buildDir --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) { throw "CMake build failed: $LASTEXITCODE" }

$prod = Join-Path $buildDir "$Configuration\winhelm_native.node"
$test = Join-Path $buildDir "$Configuration\winhelm_native_test.node"
if (-not (Test-Path -LiteralPath $prod)) { throw "Missing production addon: $prod" }
if (-not (Test-Path -LiteralPath $test)) { throw "Missing test addon: $test" }

[pscustomobject]@{
    build_root = $BuildRoot
    configuration = $Configuration
    node = $actualNode
    napi = $napi
    msvc_toolset = "14.44.35207"
    windows_sdk = "10.0.26100.0"
    production_addon = $prod
    test_addon = $test
} | ConvertTo-Json -Depth 3
