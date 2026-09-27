# Build Standalone Windows Executable (winhelm.exe)
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName
Set-Location $ProjectDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Building Standalone winhelm.exe..." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Compile TypeScript
Write-Host "Step 1: Compiling TypeScript..." -ForegroundColor Yellow
npx rimraf dist
npx tsc

# 2. Bundle with esbuild
Write-Host "Step 2: Bundling with esbuild..." -ForegroundColor Yellow
npx esbuild src/index.ts --bundle --platform=node --target=node22 --outfile=dist/bundle.cjs --format=cjs

# 3. Generate SEA Blob
Write-Host "Step 3: Generating Single Executable Blob..." -ForegroundColor Yellow
node --experimental-sea-config sea-config.json

# 4. Copy node.exe
Write-Host "Step 4: Preparing Executable Binary..." -ForegroundColor Yellow
$nodeSource = (Get-Command node -ErrorAction Stop).Source
Copy-Item $nodeSource -Destination dist\winhelm.exe -Force

# 5. Inject Blob
Write-Host "Step 5: Injecting code into winhelm.exe..." -ForegroundColor Yellow
npx --yes postject dist\winhelm.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "  [OK] Standalone Binary Created Successfully!" -ForegroundColor Green
Write-Host "  Path: $ProjectDir\dist\winhelm.exe" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
