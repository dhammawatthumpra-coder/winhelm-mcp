[CmdletBinding()]
param([Parameter(Mandatory)] [string] $Path)

$ErrorActionPreference = 'Stop'
$forbidden = @('remote_address', 'remote_port', 'bearer', 'token', 'code', 'state', 'pkce', 'invite', 'private_key', 'raw_bootstrap_identifier')
$failures = @()
foreach ($file in Get-ChildItem -LiteralPath $Path -File -Recurse -Force) {
    if ($file.FullName -match '\\(state|tsnet-state|oauth|dpapi)\\') { continue }
    $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop
    foreach ($word in $forbidden) {
        if ($text -match "(?i)\b$([regex]::Escape($word))\b") {
            $failures += "FORBIDDEN_LITERAL:$word"
        }
    }
}
if ($failures.Count -gt 0) {
    $failures | Sort-Object -Unique | ForEach-Object { Write-Output "FAIL class=$_" }
    exit 1
}
Write-Output 'PASS class=privacy_floor'
