[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $R5Root,
    [Parameter(Mandatory)] [string] $R6Root,
    [Parameter(Mandatory)] [string] $R6BaselineRoot,
    [Parameter(Mandatory)] [string] $R7Root,
    [Parameter(Mandatory)] [string] $R8Root
)

$ErrorActionPreference = 'Stop'
$model = 'WINHELM_R7_R6_RECOVERY_MODEL'
$serviceName = 'WinHelmGoTlsIngressHardeningR1'
$expectedIdentity = 'NT SERVICE\WinHelmGoTlsIngressHardeningR1'
$checks = 0
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-Requirement([bool] $Condition, [string] $Name) {
    $script:checks++
    if ($Condition) {
        Write-Output "PASS $Name"
    } else {
        $script:failures.Add("FAIL $Name") | Out-Null
        Write-Output "FAIL $Name"
    }
}

function Get-Text([string] $Path) {
    return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop)
}

function Test-ClassPresent([string] $Text, [string] $Class) {
    return ($Text -match ('class=' + [regex]::Escape($Class) + '(?=\s|$)'))
}

function Strip-LineComments([string] $Text) {
    $kept = foreach ($line in ($Text -split "`n")) {
        if (-not $line.TrimStart().StartsWith('//')) { $line }
    }
    return ($kept -join "`n")
}

# --- R6A handle-access helpers (text only; no SCM contact) ---
function Get-MethodBody([string] $Text, [string] $StartMarker, [string] $EndMarker) {
    $start = $Text.IndexOf($StartMarker, [System.StringComparison]::Ordinal)
    if ($start -lt 0) { return $null }
    $end = $Text.IndexOf($EndMarker, $start + $StartMarker.Length, [System.StringComparison]::Ordinal)
    if ($end -lt 0) { return $Text.Substring($start) }
    return $Text.Substring($start, $end - $start)
}

function Get-OpenServiceMaskExpression([string] $MethodBody) {
    if ($null -eq $MethodBody) { return $null }
    $m = [regex]::Match($MethodBody, 'OpenService\(manager,\s*serviceName,\s*([^)]+)\)')
    if (-not $m.Success) { return $null }
    return $m.Groups[1].Value.Trim()
}

function Get-ConstHexValue([string] $Text, [string] $Name) {
    $m = [regex]::Match($Text, ('private const uint ' + $Name + '\s*=\s*0x([0-9A-Fa-f]+)\s*;'))
    if (-not $m.Success) { return $null }
    return [Convert]::ToUInt32($m.Groups[1].Value, 16)
}

function Measure-AccessMask([string] $Expression, [hashtable] $ValueMap) {
    $mask = [uint32] 0
    foreach ($token in ($Expression -split '\|')) {
        $name = $token.Trim()
        if (-not $ValueMap.ContainsKey($name)) { return -1 }
        $mask = $mask -bor ([uint32] $ValueMap[$name])
    }
    return [int] $mask
}

function New-QfailureText([string] $Reset, [string[]] $ActionLines, [string] $RebootMsg = '', [string] $CommandLine = '') {
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('[SC] QueryServiceConfig2 SUCCESS')
    $lines.Add('')
    $lines.Add(('SERVICE_NAME: ' + $script:serviceName))
    $lines.Add(('        RESET_PERIOD (in seconds)    : ' + $Reset))
    $lines.Add(('        REBOOT_MESSAGE               : ' + $RebootMsg))
    $lines.Add(('        COMMAND_LINE                 : ' + $CommandLine))
    if ($ActionLines.Count -gt 0) {
        $lines.Add(('        FAILURE_ACTIONS              : ' + $ActionLines[0]))
        for ($index = 1; $index -lt $ActionLines.Count; $index++) {
            $lines.Add(('                                       ' + $ActionLines[$index]))
        }
    }
    return ($lines -join "`r`n")
}

function New-FlagText([string] $Value) {
    $lines = @(
        '[SC] QueryServiceConfig2 SUCCESS',
        '',
        ('SERVICE_NAME: ' + $script:serviceName),
        ('FAILURE_ACTIONS_ON_NONCRASH_FAILURES:  ' + $Value)
    )
    return ($lines -join "`r`n")
}

function New-Blob([uint32] $Reset, [object[]] $Entries) {
    $bytes = [System.Collections.Generic.List[byte]]::new()
    $bytes.AddRange([System.BitConverter]::GetBytes($Reset))
    $bytes.AddRange([System.BitConverter]::GetBytes([uint32] 0))
    $bytes.AddRange([System.BitConverter]::GetBytes([uint32] 0))
    $bytes.AddRange([System.BitConverter]::GetBytes([uint32] $Entries.Count))
    $bytes.AddRange([System.BitConverter]::GetBytes([uint32] 20))
    foreach ($entry in $Entries) {
        $bytes.AddRange([System.BitConverter]::GetBytes([uint32] $entry[0]))
        $bytes.AddRange([System.BitConverter]::GetBytes([uint32] $entry[1]))
    }
    return , $bytes.ToArray()
}

function Invoke-FixtureCase([string] $Name, [string] $QF, [string] $QFF, [byte[]] $Blob, [string[]] $ExpectClasses, [bool] $ExpectPass) {
    $dir = Join-Path $script:fixtureRoot $Name
    New-Item -ItemType Directory -Path $dir | Out-Null
    Set-Content -LiteralPath (Join-Path $dir 'qfailure.txt') -Value $QF -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $dir 'qfailureflag.txt') -Value $QFF -Encoding ASCII
    if ($null -ne $Blob) {
        [System.IO.File]::WriteAllBytes((Join-Path $dir 'failureactions.bin'), $Blob)
    }
    $out = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:verifierPath -FixtureDir $dir 2>&1)
    $exit = $LASTEXITCODE
    $text = ($out | ForEach-Object { [string] $_ }) -join "`n"
    if ($ExpectPass) {
        Assert-Requirement ($exit -eq 0) ("fixture " + $Name + " passes")
        Assert-Requirement ($text -match 'PASS class=recovery_policy model=WINHELM_R7_R6_RECOVERY_MODEL mode=fixture') ("fixture " + $Name + " reports the stable PASS line")
    } else {
        Assert-Requirement ($exit -eq 1) ("fixture " + $Name + " fails closed")
        foreach ($class in $ExpectClasses) {
            Assert-Requirement (Test-ClassPresent $text $class) ("fixture " + $Name + " reports " + $class)
        }
    }
    Write-Output ("FIXTURE " + $Name + " exit=" + $exit + " expected=" + (($ExpectClasses | ForEach-Object { [string] $_ }) -join ','))
}

$r5Item = Get-Item -LiteralPath $R5Root -ErrorAction Stop
$r6Item = Get-Item -LiteralPath $R6Root -ErrorAction Stop
$r7Item = Get-Item -LiteralPath $R7Root -ErrorAction Stop
$r8Item = Get-Item -LiteralPath $R8Root -ErrorAction Stop
$r5Package = Join-Path $r5Item.FullName 'package'
$r6Package = Join-Path $r6Item.FullName 'package'
$r7Package = Join-Path $r7Item.FullName 'package'
$r8Package = Join-Path $r8Item.FullName 'package'
$configurePath = Join-Path $r6Package 'configure-recovery.ps1'
$verifierPath = Join-Path $r6Package 'verify-recovery.ps1'
$installerPath = Join-Path $r6Package 'install-service.ps1'
$r8MainText = Get-Text (Join-Path $r8Item.FullName 'main.go')
$serviceHostPath = Join-Path $r8Item.FullName 'service_windows.go'
$swText = ''
if (Test-Path -LiteralPath $serviceHostPath -PathType Leaf) { $swText = Get-Text $serviceHostPath }

Write-Output ("HARNESS recovery_regression model=" + $model + " r5=" + $r5Item.FullName + " r6=" + $r6Item.FullName + " r6baseline=" + (Get-Item -LiteralPath $R6BaselineRoot).FullName + " r7=" + $r7Item.FullName + " r8=" + $r8Item.FullName)
Write-Output 'HARNESS note=read-only harness; no -Apply; no service mutation; no service start; native access probe targets a freshly verified nonexistent name only; no listener may bind during the harness'

$svcBefore = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$cimBefore = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $serviceName) -ErrorAction SilentlyContinue
$qfBefore = (@(& sc.exe qfailure $serviceName 2>&1) | ForEach-Object { [string] $_ }) -join "`n"
$qffBefore = (@(& sc.exe qfailureflag $serviceName 2>&1) | ForEach-Object { [string] $_ }) -join "`n"
$upstreamPidsBefore = @((Get-NetTCPConnection -State Listen -LocalPort 64239 -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) | Sort-Object)

Write-Output 'SECTION R5_RED'
$redStart = $failures.Count
$r5InstallerText = Get-Text (Join-Path $r5Package 'install-service.ps1')
$r5RuntimeText = Get-Text (Join-Path $r5Package 'service-runtime.json')
Assert-Requirement (-not (Test-Path -LiteralPath (Join-Path $r5Package 'configure-recovery.ps1'))) 'r5_red configure script absent from R5'
Assert-Requirement (-not (Test-Path -LiteralPath (Join-Path $r5Package 'verify-recovery.ps1'))) 'r5_red verify script absent from R5'
Assert-Requirement ($r5InstallerText -notmatch 'configure-recovery') 'r5_red R5 installer has no recovery configuration hook'
Assert-Requirement ($r5InstallerText -notmatch 'recovery_policy') 'r5_red R5 installer has no recovery policy marker'
Assert-Requirement ($r5RuntimeText -notmatch 'resetPeriodSeconds') 'r5_red R5 runtime definition has no structured recovery policy'
$redOk = ($failures.Count -eq $redStart)

Write-Output 'SECTION R6_GREEN'
$greenStart = $failures.Count
$configureText = Get-Text $configurePath
$verifierText = Get-Text $verifierPath
$installerText = Get-Text $installerPath
$runtime = Get-Text (Join-Path $r6Package 'service-runtime.json') | ConvertFrom-Json
$policy = $runtime.recoveryPolicy

Assert-Requirement (Test-Path -LiteralPath $configurePath -PathType Leaf) 'r6_green configure-recovery.ps1 present'
Assert-Requirement (Test-Path -LiteralPath $verifierPath -PathType Leaf) 'r6_green verify-recovery.ps1 present'
Assert-Requirement (Test-Path -LiteralPath (Join-Path $r6Package 'regression-recovery.ps1') -PathType Leaf) 'r6_green regression-recovery.ps1 present'
Assert-Requirement ($null -ne $policy) 'r6_green structured recovery policy present'
if ($null -ne $policy) {
    Assert-Requirement ([int] $policy.resetPeriodSeconds -eq 86400) 'r6_green reset period equals 86400'
    $actionList = @($policy.actions)
    Assert-Requirement ($actionList.Count -eq 3) 'r6_green exactly three ordered actions'
    if ($actionList.Count -eq 3) {
        Assert-Requirement (($actionList[0].type -eq 'restart') -and ([int] $actionList[0].delayMs -eq 30000)) 'r6_green action 1 restart/30000'
        Assert-Requirement (($actionList[1].type -eq 'restart') -and ([int] $actionList[1].delayMs -eq 300000)) 'r6_green action 2 restart/300000'
        Assert-Requirement (($actionList[2].type -eq 'none') -and ([int] $actionList[2].delayMs -eq 0)) 'r6_green action 3 none/0 terminal'
    }
    Assert-Requirement (@($actionList | Where-Object { $_.type -eq 'restart' }).Count -eq 2) 'r6_green exactly two automatic restarts'
    Assert-Requirement ($actionList[-1].type -eq 'none') 'r6_green no cyclic or unbounded restart action'
    Assert-Requirement ($policy.failureActionsOnNonCrashFailures -eq $true) 'r6_green failure actions on non-crash failures true'
    Assert-Requirement ([int] $policy.boundedAutomaticRestartCount -eq 2) 'r6_green bounded automatic restart count two'
    Assert-Requirement ($policy.terminalFailureOwnerVisible -eq $true) 'r6_green terminal failure owner visible'
    Assert-Requirement ($policy.rebootAction -eq $false) 'r6_green no reboot action'
    Assert-Requirement ($policy.recoveryCommand -eq $false) 'r6_green no recovery command'
}

Assert-Requirement ($configureText -match 'ChangeServiceConfig2') 'r6_green configure materializes the policy via ChangeServiceConfig2'
Assert-Requirement ($configureText -match 'new SC_ACTION\[3\]') 'r6_green materialized action array holds exactly three entries'
Assert-Requirement ($configureText -match '\[2\]\.Type = SC_ACTION_NONE') 'r6_green terminal none entry materialized'
Assert-Requirement ($configureText -match 'SC_ACTION_RESTART') 'r6_green restart entries materialized'
Assert-Requirement ($configureText -match 'SERVICE_CONFIG_FAILURE_ACTIONS_FLAG') 'r6_green non-crash flag configuration present'
Assert-Requirement ($configureText -match 'sc\.exe failure accepts only') 'r6_green mechanism limitation documented'
Assert-Requirement ($configureText -match 'repeats the last') 'r6_green SCM repeat-last-action reasoning documented'
Assert-Requirement ($configureText -notmatch '(?im)^\s*&?\s*sc\.exe\s+failure\s') 'r6_green no sc.exe failure set command used or needed'
Assert-Requirement ($configureText -match 'lpRebootMsg = ""') 'r6_green reboot message left empty'
Assert-Requirement ($configureText -match 'lpCommand = ""') 'r6_green recovery command left empty'
Assert-Requirement ($configureText -match 'Status -ne .Stopped.') 'r6_green stop guard present before apply'
Assert-Requirement ($configureText -match 'must remain stopped') 'r6_green stop guard rejects a running service'
Assert-Requirement ($configureText -match '\[uint32\] 86400') 'r6_green configure carries reset 86400'
Assert-Requirement ($configureText -match '\[uint32\] 30000') 'r6_green configure carries first restart delay'
Assert-Requirement ($configureText -match '\[uint32\] 300000') 'r6_green configure carries second restart delay'

$dryRunStart = $configureText.IndexOf('if (-not $Apply)', [System.StringComparison]::Ordinal)
$shouldProcessIndex = $configureText.IndexOf('$PSCmdlet.ShouldProcess', [System.StringComparison]::Ordinal)
Assert-Requirement ($dryRunStart -ge 0 -and $shouldProcessIndex -gt $dryRunStart) 'r6_green dry-run branch precedes the mutating branch'
if ($dryRunStart -ge 0 -and $shouldProcessIndex -gt $dryRunStart) {
    # The dry-run branch ends at its own exit; the apply lane afterwards starts with
    # the read-only exists/stopped guard, so slice to the branch exit only.
    $dryRunEnd = $configureText.IndexOf('exit 0', $dryRunStart, [System.StringComparison]::Ordinal)
    Assert-Requirement ($dryRunEnd -gt $dryRunStart -and $dryRunEnd -lt $shouldProcessIndex) 'r6_green dry-run branch terminates before the mutating branch'
    $dryRunBlock = $configureText.Substring($dryRunStart, $dryRunEnd - $dryRunStart + 6)
    Assert-Requirement ($dryRunBlock -notmatch 'Add-Type') 'r6_green dry-run branch never compiles the native mechanism'
    Assert-Requirement ($dryRunBlock -notmatch 'Get-Service|Get-CimInstance') 'r6_green dry-run branch performs no service query'
    Assert-Requirement ($dryRunBlock -notmatch '(?im)&\s') 'r6_green dry-run branch performs no invocation'
    Assert-Requirement ($dryRunBlock -match 'reset=86400') 'r6_green dry-run branch prints reset 86400'
    Assert-Requirement ($dryRunBlock -match 'service_started=false') 'r6_green dry-run branch states the service is not started'
}

Assert-Requirement ($verifierText -match 'PASS class=recovery_policy') 'r6_green verifier reports the stable PASS class'
Assert-Requirement ($verifierText -match 'none_terminal_missing') 'r6_green verifier encodes the boundedness failure class'
Assert-Requirement ($verifierText -match 'GetValue\(.FailureActions.\)') 'r6_green verifier reads the raw failure actions value'
Assert-Requirement ($verifierText -match 'ReadAllBytes') 'r6_green verifier carries the fixture test seam'
Assert-Requirement ($verifierText -notmatch '(?i)ChangeServiceConfig2') 'r6_green verifier cannot configure anything'
Assert-Requirement ($verifierText -notmatch '(?im)^\s*&?\s*sc\.exe\s+(failure|failureflag|config|create|delete|start|stop)\b') 'r6_green verifier issues no mutating sc command'
Assert-Requirement ($verifierText -notmatch '(?i)\b(Start-Service|Stop-Service|Set-Service|New-Service|Remove-Service)\b') 'r6_green verifier issues no service control command'
Assert-Requirement ($verifierText -notmatch '(?i)\b(Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Set-Acl)\b') 'r6_green verifier writes no item'

$configureCallIndex = $installerText.IndexOf('configure-recovery.ps1', [System.StringComparison]::Ordinal)
$verifyCallIndex = $installerText.IndexOf('verify-recovery.ps1', [System.StringComparison]::Ordinal)
$installedStoppedIndex = $installerText.IndexOf('INSTALLED_STOPPED', [System.StringComparison]::Ordinal)
$createInvokeIndex = $installerText.IndexOf('& sc.exe @createArgs', [System.StringComparison]::Ordinal)
$deleteIndex = $installerText.IndexOf('& sc.exe delete', [System.StringComparison]::Ordinal)
$configArgsIndex = $installerText.IndexOf('$configArgs =', [System.StringComparison]::Ordinal)
$configInvokeIndex = $installerText.IndexOf('& sc.exe @configArgs', [System.StringComparison]::Ordinal)

Assert-Requirement ($configureCallIndex -ge 0) 'r6_green installer invokes configure-recovery.ps1'
Assert-Requirement ($verifyCallIndex -gt $configureCallIndex) 'r6_green installer invokes verify-recovery.ps1 after configure'
Assert-Requirement ($installedStoppedIndex -gt $verifyCallIndex) 'r6_green final installed output follows recovery verification'
Assert-Requirement ($installerText.Contains('recovery_policy=configured_verified')) 'r6_green final installed output records the verified recovery policy'
Assert-Requirement ($installerText.Contains('recovery policy configuration failed')) 'r6_green installer throws when recovery configuration fails'
Assert-Requirement ($installerText.Contains('recovery policy verification failed')) 'r6_green installer throws when recovery verification fails'
Assert-Requirement ($configureCallIndex -gt $createInvokeIndex) 'r6_green recovery configuration runs after service registration'
Assert-Requirement ($deleteIndex -gt $verifyCallIndex) 'r6_green self-rollback deletion remains reachable after recovery steps'
Assert-Requirement ($configArgsIndex -gt $createInvokeIndex -and $configInvokeIndex -gt $configArgsIndex) 'r6_green final identity configuration step order preserved'
Assert-Requirement ($installerText.Contains('# Managed/virtual service accounts require a NULL password: omit the password argument entirely.')) 'r6_green R5 NULL-password note preserved'
Assert-Requirement ($installerText.Contains("@('config', `$serviceName, 'obj=', `$ServiceIdentity)")) 'r6_green R5 password-omitting identity configuration preserved'
if ($configArgsIndex -ge 0 -and $configInvokeIndex -gt $configArgsIndex) {
    $configBlock = $installerText.Substring($configArgsIndex, $configInvokeIndex - $configArgsIndex)
    Assert-Requirement ($configBlock -notmatch '(?i)password') 'r6_green identity configuration still omits any password argument'
}
Assert-Requirement ($installerText.Contains('PLAN recovery_policy=reset=86400; actions=restart/30000,restart/300000,none/0; failureflag=true')) 'r6_green installer dry-run prints the exact recovery plan'
Assert-Requirement ($installerText.Contains('PLAN recovery_config_verified_after_registration_with_service_stopped=true service_started=false')) 'r6_green installer dry-run states recovery verification before any start'

foreach ($pair in @(@('install-service.ps1', $installerText), @('configure-recovery.ps1', $configureText), @('verify-recovery.ps1', $verifierText))) {
    $scriptName = $pair[0]
    $scriptText = $pair[1]
    Assert-Requirement ($scriptText -notmatch '(?im)^\s*Start-Service\b') ("no_start Start-Service absent in " + $scriptName)
    Assert-Requirement ($scriptText -notmatch '(?im)&\s*sc\.exe\s+start\b') ("no_start sc.exe start absent in " + $scriptName)
    Assert-Requirement ($scriptText -notmatch '(?i)\bStartService\b') ("no_start StartService absent in " + $scriptName)
}
$greenOk = ($failures.Count -eq $greenStart)

Write-Output 'SECTION HANDLE_ACCESS'
# R6A handle-access contract regression: R6 baseline RED (restart action mutation handle
# lacks SERVICE_START) and R6A GREEN (exact least-privilege mask including SERVICE_START).
# The native probe below only ever targets a freshly generated, verified-nonexistent service
# name and therefore cannot mutate any existing service.
$accessStart = $failures.Count

$r6RedStart = $failures.Count
$r6bItem = Get-Item -LiteralPath $R6BaselineRoot -ErrorAction Stop
$r6bConfigurePath = Join-Path $r6bItem.FullName 'package\configure-recovery.ps1'
Assert-Requirement (Test-Path -LiteralPath $r6bConfigurePath -PathType Leaf) 'r6_red baseline configure-recovery.ps1 present'
$r6bText = Get-Text $r6bConfigurePath
Assert-Requirement (-not [bool] ($r6bText -cmatch 'SERVICE_START')) 'r6_red baseline defines no SERVICE_START access right'
Assert-Requirement ($r6bText -match 'actions\[0\]\.Type\s*=\s*SC_ACTION_RESTART') 'r6_red baseline materializes restart as action[0]'
Assert-Requirement ($r6bText -match 'actions\[1\]\.Type\s*=\s*SC_ACTION_RESTART') 'r6_red baseline materializes restart as action[1]'
$r6bActionsBody = Get-MethodBody $r6bText 'public static int ConfigureFailureActions(string serviceName' 'public static int ConfigureFailureActionsFlag(string serviceName'
Assert-Requirement ($null -ne $r6bActionsBody) 'r6_red baseline ConfigureFailureActions method found'
$r6bMaskExpr = Get-OpenServiceMaskExpression $r6bActionsBody
Assert-Requirement ($null -ne $r6bMaskExpr) 'r6_red baseline OpenService access expression found'
if ($null -ne $r6bMaskExpr) {
    $r6bTokens = @(($r6bMaskExpr -split '\|') | ForEach-Object { $_.Trim() })
    Assert-Requirement ($r6bTokens -ccontains 'SERVICE_CHANGE_CONFIG') 'r6_red baseline handle requests SERVICE_CHANGE_CONFIG'
    Assert-Requirement ($r6bTokens -ccontains 'SERVICE_QUERY_CONFIG') 'r6_red baseline handle requests SERVICE_QUERY_CONFIG'
    Assert-Requirement (-not ($r6bTokens -ccontains 'SERVICE_START')) 'r6_red baseline restart mutation handle lacks SERVICE_START'
    $r6bMask = Measure-AccessMask $r6bMaskExpr @{ 'SERVICE_QUERY_CONFIG' = [uint32] 0x0001; 'SERVICE_CHANGE_CONFIG' = [uint32] 0x0002 }
    Assert-Requirement ($r6bMask -eq 0x0003) 'r6_red baseline computed mask 0x0003 violates the restart handle access contract'
    Write-Output ("HANDLE_ACCESS r6_baseline restart_actions=true mask=" + ('0x{0:X4}' -f [uint32] $r6bMask) + " expression='" + $r6bMaskExpr + "'")
}
$r6RedOk = ($failures.Count -eq $r6RedStart)

$r6aGreenStart = $failures.Count
Assert-Requirement ($configureText -cmatch 'private const uint SERVICE_START\s*=\s*0x0010\s*;') 'r6a_green SERVICE_START declared exactly as 0x0010'
$startValue = Get-ConstHexValue $configureText 'SERVICE_START'
Assert-Requirement (($null -ne $startValue) -and ([uint32] $startValue -eq [uint32] 0x0010)) 'r6a_green parsed SERVICE_START numeric value is 0x0010'
$startTokenCount = ([regex]::Matches($configureText, 'SERVICE_START')).Count
Assert-Requirement ($startTokenCount -eq 2) 'r6a_green SERVICE_START appears exactly at its declaration and the restart mutation handle'
$r6aMaskValues = @{}
foreach ($symbol in 'SERVICE_QUERY_CONFIG', 'SERVICE_CHANGE_CONFIG', 'SERVICE_START') {
    $value = Get-ConstHexValue $configureText $symbol
    if ($null -ne $value) { $r6aMaskValues[$symbol] = [uint32] $value }
}
$actionsBody = Get-MethodBody $configureText 'public static int ConfigureFailureActions(string serviceName' 'public static int ConfigureFailureActionsFlag(string serviceName'
Assert-Requirement ($null -ne $actionsBody) 'r6a_green ConfigureFailureActions method found'
$actionsMaskExpr = Get-OpenServiceMaskExpression $actionsBody
Assert-Requirement ($null -ne $actionsMaskExpr) 'r6a_green ConfigureFailureActions OpenService access expression found'
if ($null -ne $actionsMaskExpr) {
    $actionTokens = @(($actionsMaskExpr -split '\|') | ForEach-Object { $_.Trim() })
    Assert-Requirement ($actionTokens.Count -eq 3) 'r6a_green restart mutation handle carries exactly three rights'
    Assert-Requirement ($actionTokens -ccontains 'SERVICE_CHANGE_CONFIG') 'r6a_green restart mutation handle includes SERVICE_CHANGE_CONFIG'
    Assert-Requirement ($actionTokens -ccontains 'SERVICE_QUERY_CONFIG') 'r6a_green restart mutation handle includes SERVICE_QUERY_CONFIG'
    Assert-Requirement ($actionTokens -ccontains 'SERVICE_START') 'r6a_green restart mutation handle includes SERVICE_START'
    $actionsMask = Measure-AccessMask $actionsMaskExpr $r6aMaskValues
    Assert-Requirement ($actionsMask -eq 0x0013) 'r6a_green computed restart mutation access mask is 0x0013'
    Write-Output ("HANDLE_ACCESS r6a_restart_handle mask=" + ('0x{0:X4}' -f [uint32] $actionsMask) + " expression='" + $actionsMaskExpr + "'")
}
$flagBody = Get-MethodBody $configureText 'public static int ConfigureFailureActionsFlag(string serviceName' "'@"
Assert-Requirement ($null -ne $flagBody) 'r6a_green ConfigureFailureActionsFlag method found'
$flagMaskExpr = Get-OpenServiceMaskExpression $flagBody
Assert-Requirement ($null -ne $flagMaskExpr) 'r6a_green flag-only OpenService access expression found'
if ($null -ne $flagMaskExpr) {
    $flagTokens = @(($flagMaskExpr -split '\|') | ForEach-Object { $_.Trim() })
    Assert-Requirement ($flagTokens.Count -eq 2) 'r6a_green flag-only path keeps two rights'
    Assert-Requirement ($flagTokens -ccontains 'SERVICE_CHANGE_CONFIG') 'r6a_green flag-only path keeps SERVICE_CHANGE_CONFIG'
    Assert-Requirement ($flagTokens -ccontains 'SERVICE_QUERY_CONFIG') 'r6a_green flag-only path keeps SERVICE_QUERY_CONFIG'
    Assert-Requirement (-not ($flagTokens -ccontains 'SERVICE_START')) 'r6a_green flag-only path does not inherit SERVICE_START'
    $flagMask = Measure-AccessMask $flagMaskExpr $r6aMaskValues
    Assert-Requirement ($flagMask -eq 0x0003) 'r6a_green computed flag-only access mask is 0x0003'
    Write-Output ("HANDLE_ACCESS r6a_flag_handle mask=" + ('0x{0:X4}' -f [uint32] $flagMask) + " expression='" + $flagMaskExpr + "'")
}
Assert-Requirement (([regex]::Matches($flagBody, 'SERVICE_START')).Count -eq 0) 'r6a_green flag-only method body references no SERVICE_START'
$managerTokens = @([regex]::Matches($configureText, 'SC_MANAGER_[A-Z_]+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
Assert-Requirement (($managerTokens.Count -eq 1) -and ($managerTokens[0] -ceq 'SC_MANAGER_CONNECT')) 'r6a_green SCM manager access not broadened beyond SC_MANAGER_CONNECT'
$serviceTokens = @([regex]::Matches($configureText, 'SERVICE_[A-Z_]+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
$expectedServiceTokens = @('SERVICE_CHANGE_CONFIG', 'SERVICE_CONFIG_FAILURE_ACTIONS', 'SERVICE_CONFIG_FAILURE_ACTIONS_FLAG', 'SERVICE_FAILURE_ACTIONS', 'SERVICE_FAILURE_ACTIONS_FLAG', 'SERVICE_QUERY_CONFIG', 'SERVICE_START') | Sort-Object -Unique
Assert-Requirement (($serviceTokens -join ',') -ceq ($expectedServiceTokens -join ',')) 'r6a_green only query/change/start rights plus the config info levels appear'
foreach ($forbidden in @('SERVICE_ALL_ACCESS', 'SERVICE_STOP', 'SERVICE_PAUSE_CONTINUE', 'SERVICE_INTERROGATE', 'SERVICE_USER_DEFINED_CONTROL', 'WRITE_DAC', 'WRITE_OWNER', 'GENERIC_ALL', 'GENERIC_READ', 'GENERIC_WRITE', 'GENERIC_EXECUTE', 'MAXIMUM_ALLOWED')) {
    Assert-Requirement (-not [bool] ($configureText -cmatch [regex]::Escape($forbidden))) ('r6a_green forbidden broad right absent: ' + $forbidden)
}
Assert-Requirement (([regex]::Matches($configureText, '(?m)\bDELETE\b')).Count -eq 0) 'r6a_green forbidden delete right absent'
Assert-Requirement (([regex]::Matches($configureText, 'CloseServiceHandle\(service\)')).Count -eq 2) 'r6a_green both native methods still close their service handle'
Assert-Requirement (([regex]::Matches($configureText, 'CloseServiceHandle\(manager\)')).Count -eq 2) 'r6a_green both native methods still close their manager handle'
Assert-Requirement (([regex]::Matches($configureText, 'Marshal\.FreeHGlobal\(payload\)')).Count -eq 2) 'r6a_green payload cleanup preserved in both methods'
Assert-Requirement (([regex]::Matches($configureText, 'actionsPin\.Free\(\)')).Count -eq 1) 'r6a_green pinned action-array cleanup preserved'
Assert-Requirement (([regex]::Matches($configureText, 'Marshal\.GetLastWin32Error\(\)')).Count -eq 6) 'r6a_green fail-closed error reporting preserved on all six failure paths'
Assert-Requirement (-not [bool] ($configureText -cmatch '\bStartService\b')) 'r6a_green no StartService API introduced'
Assert-Requirement (-not [bool] ($configureText -cmatch '(?m)^\s*Start-Service\b')) 'r6a_green no Start-Service introduced'
Assert-Requirement (-not [bool] ($configureText -cmatch '(?m)&\s*sc\.exe\s+start\b')) 'r6a_green no sc.exe start introduced'
Assert-Requirement ($configureText -match '\[uint32\] 86400,') 'r6a_green apply path still carries reset 86400'
Assert-Requirement ($configureText -match '\[uint32\] 30000,') 'r6a_green apply path still carries first restart delay 30000'
Assert-Requirement ($configureText -match '\[uint32\] 300000\)') 'r6a_green apply path still carries second restart delay 300000'

$nativeMatch = [regex]::Match($configureText, "(?s)\`$recoveryNativeSource = @'\r?\n(.*?)\r?\n'@")
Assert-Requirement ($nativeMatch.Success) 'r6a_native embedded C# source extracted from the corrective script'
if ($nativeMatch.Success) {
    $nativeSource = $nativeMatch.Groups[1].Value
    $compileError = $null
    try {
        if (-not ('WinHelmR6Recovery' -as [type])) {
            Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
        }
    } catch { $compileError = $_.Exception.Message }
    Assert-Requirement ($null -eq $compileError) 'r6a_native embedded C# compiles cleanly'
    if ($null -eq $compileError) {
        $reflectionFlags = [System.Reflection.BindingFlags]'NonPublic,Static'
        $fieldCases = @(
            @('SERVICE_QUERY_CONFIG', 0x0001), @('SERVICE_CHANGE_CONFIG', 0x0002), @('SERVICE_START', 0x0010),
            @('SC_MANAGER_CONNECT', 0x0001), @('SC_ACTION_RESTART', 1), @('SC_ACTION_NONE', 0)
        )
        foreach ($case in $fieldCases) {
            $field = [WinHelmR6Recovery].GetField([string] $case[0], $reflectionFlags)
            $caseOk = ($null -ne $field) -and ([uint32] $field.GetRawConstantValue() -eq [uint32] $case[1])
            Assert-Requirement $caseOk ('r6a_native compiled constant ' + $case[0] + ' = 0x' + ('{0:X4}' -f [uint32] $case[1]))
        }
        $probeName = 'R6AProbeNonexistent' + [guid]::NewGuid().ToString('N').Substring(0, 12)
        Assert-Requirement ($null -eq (Get-Service -Name $probeName -ErrorAction SilentlyContinue)) 'r6a_native probe name verified nonexistent before the probe'
        $probeActionsRc = [WinHelmR6Recovery]::ConfigureFailureActions($probeName, [uint32] 86400, [uint32] 30000, [uint32] 300000)
        $probeFlagRc = [WinHelmR6Recovery]::ConfigureFailureActionsFlag($probeName)
        Write-Output ("HANDLE_ACCESS native_probe rc_actions=" + $probeActionsRc + " rc_flag=" + $probeFlagRc + " probe_name=" + $probeName)
        Assert-Requirement ($probeActionsRc -eq 1060) 'r6a_native restart-action probe fails closed win32=1060 against a nonexistent name'
        Assert-Requirement ($probeFlagRc -eq 1060) 'r6a_native flag probe fails closed win32=1060 against a nonexistent name'
        Assert-Requirement ($null -eq (Get-Service -Name $probeName -ErrorAction SilentlyContinue)) 'r6a_native probe created or mutated no service'
    }
}
$r6aGreenOk = ($failures.Count -eq $r6aGreenStart)
$accessOk = ($failures.Count -eq $accessStart)

Write-Output 'SECTION AST_PARSE'
$astStart = $failures.Count
$parseFailureCount = 0
$astFiles = @(Get-ChildItem -LiteralPath $r6Package -Filter '*.ps1' -File)
$astFiles += @(Get-ChildItem -LiteralPath $r7Package -Filter '*.ps1' -File)
Assert-Requirement ($astFiles.Count -eq 30) 'ast_parse both corrective package script sets enumerated (14 R6A + 16 R7)'
foreach ($r8ChangedScript in @('install-service.ps1', 'regression-recovery.ps1')) {
    $candidate = Join-Path $r8Package $r8ChangedScript
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $astFiles += @(Get-Item -LiteralPath $candidate) }
}
Assert-Requirement ($astFiles.Count -eq 32) 'ast_parse R8 changed package scripts enumerated (30 inherited + 2 R8-changed)'
foreach ($file in ($astFiles | Sort-Object FullName)) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref] $tokens, [ref] $parseErrors) | Out-Null
    if (@($parseErrors).Count -gt 0) {
        $parseFailureCount++
        Write-Output ("PARSE " + $file.Name + " astErrors=" + @($parseErrors).Count)
    } else {
        Write-Output ("PARSE " + $file.Name + " astErrors=0")
    }
}
Assert-Requirement ($parseFailureCount -eq 0) 'all R6A, R7 and R8-changed package PowerShell scripts parse with zero AST errors'
$astOk = ($failures.Count -eq $astStart)

Write-Output 'SECTION FIXTURES'
$fixtureStart = $failures.Count
$fixtureRoot = Join-Path $env:TEMP ('r6-recovery-fixtures-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
    $actionPost = @('RESTART -- Delay = 30000 milliseconds.', 'RESTART -- Delay = 300000 milliseconds.')
    $blobPass = New-Blob 86400 @(@(1, 30000), @(1, 300000), @(0, 0))
    $blobPassHex = [System.BitConverter]::ToString($blobPass).Replace('-', '')
    $canonicalHex = '80510100' + '00000000' + '00000000' + '03000000' + '14000000' + '01000000' + '30750000' + '01000000' + 'E0930400' + '00000000' + '00000000'
    Assert-Requirement ($blobPassHex -eq $canonicalHex) 'fixture canonical recovery blob matches the accepted SCM registry layout'

    $qPost = New-QfailureText -Reset '86400' -ActionLines $actionPost

    Invoke-FixtureCase 'pre_apply_missing' (New-QfailureText -Reset '0' -ActionLines @()) (New-FlagText 'FALSE') $null @('reset_mismatch', 'action_sequence_mismatch', 'noncrash_flag_false', 'registry_blob_missing') $false
    Invoke-FixtureCase 'post_apply_pass' $qPost (New-FlagText 'TRUE') $blobPass @() $true
    Invoke-FixtureCase 'post_apply_pass_explicit_none' (New-QfailureText -Reset '86400' -ActionLines @($actionPost[0], $actionPost[1], 'NONE -- Delay = 0 milliseconds.')) (New-FlagText 'TRUE') $blobPass @() $true
    Invoke-FixtureCase 'wrong_first_delay' (New-QfailureText -Reset '86400' -ActionLines @('RESTART -- Delay = 20000 milliseconds.', $actionPost[1])) (New-FlagText 'TRUE') $blobPass @('action_sequence_mismatch') $false
    Invoke-FixtureCase 'extra_restart_action' (New-QfailureText -Reset '86400' -ActionLines @($actionPost[0], $actionPost[1], 'RESTART -- Delay = 60000 milliseconds.')) (New-FlagText 'TRUE') $blobPass @('action_sequence_mismatch') $false
    Invoke-FixtureCase 'order_swapped' (New-QfailureText -Reset '86400' -ActionLines @($actionPost[1], $actionPost[0])) (New-FlagText 'TRUE') $blobPass @('action_sequence_mismatch') $false
    Invoke-FixtureCase 'reboot_action' (New-QfailureText -Reset '86400' -ActionLines @($actionPost[0], 'REBOOT -- Delay = 60000 milliseconds.')) (New-FlagText 'TRUE') $blobPass @('reboot_action_present', 'action_sequence_mismatch') $false
    Invoke-FixtureCase 'run_process_action' (New-QfailureText -Reset '86400' -ActionLines @($actionPost[0], 'RUN PROCESS -- Delay = 60000 milliseconds.')) (New-FlagText 'TRUE') $blobPass @('recovery_command_present', 'action_sequence_mismatch') $false
    Invoke-FixtureCase 'flag_false' $qPost (New-FlagText 'FALSE') $blobPass @('noncrash_flag_false') $false
    Invoke-FixtureCase 'flag_malformed' $qPost (New-FlagText 'MAYBE') $blobPass @('noncrash_flag_unreadable') $false
    Invoke-FixtureCase 'blob_two_restarts_no_terminal' $qPost (New-FlagText 'TRUE') (New-Blob 86400 @(@(1, 30000), @(1, 300000))) @('none_terminal_missing') $false
    Invoke-FixtureCase 'blob_absent' $qPost (New-FlagText 'TRUE') $null @('registry_blob_missing') $false
    $qAmbiguous = $qPost.Replace('RESET_PERIOD (in seconds)    : 86400', "RESET_PERIOD (in seconds)    : 86400`r`n        RESET_PERIOD (in seconds)    : 86400")
    Invoke-FixtureCase 'qfailure_ambiguous' $qAmbiguous (New-FlagText 'TRUE') $blobPass @('qfailure_parse_ambiguous') $false
    Invoke-FixtureCase 'reboot_message_present' (New-QfailureText -Reset '86400' -ActionLines $actionPost -RebootMsg 'the system is restarting') (New-FlagText 'TRUE') $blobPass @('reboot_message_present') $false
    Invoke-FixtureCase 'command_line_present' (New-QfailureText -Reset '86400' -ActionLines $actionPost -CommandLine 'cmd.exe /c restart') (New-FlagText 'TRUE') $blobPass @('recovery_command_present') $false
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
$fixturesOk = ($failures.Count -eq $fixtureStart)

Write-Output 'SECTION DRYRUN'
$dryStart = $failures.Count
$dryOut = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $configurePath 2>&1)
$dryExit = $LASTEXITCODE
$dryText = ($dryOut | ForEach-Object { [string] $_ }) -join "`n"
Assert-Requirement ($dryExit -eq 0) 'configure dry-run exits zero'
Assert-Requirement ($dryText -match 'reset=86400') 'configure dry-run prints reset 86400'
Assert-Requirement ($dryText -match [regex]::Escape('actions=restart/30000,restart/300000,none/0')) 'configure dry-run prints the exact ordered actions'
Assert-Requirement ($dryText -match 'failureflag=true') 'configure dry-run prints failureflag true'
Assert-Requirement ($dryText -match 'service_started=false') 'configure dry-run states the service is not started'
$qfAfterDry = (@(& sc.exe qfailure $serviceName 2>&1) | ForEach-Object { [string] $_ }) -join "`n"
$qffAfterDry = (@(& sc.exe qfailureflag $serviceName 2>&1) | ForEach-Object { [string] $_ }) -join "`n"
Assert-Requirement ($qfAfterDry -eq $qfBefore) 'recovery actions unchanged by the dry-run'
Assert-Requirement ($qffAfterDry -eq $qffBefore) 'recovery flag unchanged by the dry-run'
$dryOk = ($failures.Count -eq $dryStart)

Write-Output 'SECTION LIVE_VERIFY_PREAPPLY'
# The verifier is bidirectional with respect to the live registration: while
# the recovery policy is still missing it must fail closed with the four
# mismatch classes; once the accepted policy is materialized on the service it
# must pass. The invoked world is derived from the SCM text captured at the top
# of the harness, so the section stays valid before and after the accepted
# recovery apply. The deterministic fail-closed proof for a missing policy
# lives in the FIXTURES section (pre_apply_missing).
$liveStart = $failures.Count
$liveOut = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifierPath 2>&1)
$liveExit = $LASTEXITCODE
$liveText = ($liveOut | ForEach-Object { [string] $_ }) -join "`n"
$liveApplied = ($qfBefore -match 'RESET_PERIOD \(in seconds\)\s*:\s*86400') -and ($qfBefore -match 'RESTART -- Delay = 30000 milliseconds\.') -and ($qfBefore -match 'RESTART -- Delay = 300000 milliseconds\.') -and ($qffBefore -match 'FAILURE_ACTIONS_ON_NONCRASH_FAILURES:\s+TRUE')
if ($liveApplied) {
    Assert-Requirement ($liveExit -eq 0) 'live verifier passes on the materialized recovery policy'
    Assert-Requirement (Test-ClassPresent $liveText 'recovery_policy') 'live verifier reports the recovery policy class'
} else {
    Assert-Requirement ($liveExit -eq 1) 'live verifier fails closed before the recovery apply'
    foreach ($class in @('reset_mismatch', 'action_sequence_mismatch', 'noncrash_flag_false', 'registry_blob_missing')) {
        Assert-Requirement (Test-ClassPresent $liveText $class) ("live verifier reports " + $class)
    }
}
$liveOk = ($failures.Count -eq $liveStart)

Write-Output 'SECTION INSTALL_DRYRUN'
$installStart = $failures.Count
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
# The installer refusal message arrives on stderr; keep the strict preference for
# every other check but allow this one capture to merge stderr without throwing.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$installOut = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installerPath -Root $r6Item.FullName 2>&1)
$installExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
$installText = ($installOut | ForEach-Object { [string] $_ }) -join "`n"
if ($null -ne $existingService) {
    Assert-Requirement ($installExit -ne 0) 'installer dry-run refuses while the service already exists'
    Assert-Requirement ($installText -match 'service already exists') 'installer dry-run refusal names the pre-existing service'
} else {
    Assert-Requirement ($installExit -eq 0) 'installer dry-run exits zero when no service is registered'
    Assert-Requirement ($installText -match 'recovery_policy=reset=86400') 'installer dry-run prints the recovery policy plan'
}
$installOk = ($failures.Count -eq $installStart)

Write-Output 'SECTION FROZEN_PARITY'
$parityStart = $failures.Count
$frozenSame = @(
    'alpn_prod_test.go', 'config.json', 'deviation_test.go', 'go.mod', 'go.sum',
    'hardening_r1_test.go', 'hardening_test.go', 'main.go', 'main_test.go', 'matrix_dev_test.go',
    'policy_test.go', 'route-golden.json', 'state_acl_test.go', 'state_test.go', 'windows_security.go',
    'winhelm-go-tls-ingress-hardening-r1.exe',
    'package\acl-policy.json', 'package\config.template.json', 'package\enroll.ps1', 'package\log-policy.json',
    'package\prepare-acl.ps1', 'package\privacy-scan.ps1', 'package\rollback.ps1', 'package\start-service.ps1',
    'package\status.ps1', 'package\stop-service.ps1', 'package\uninstall-service.ps1', 'package\upgrade.ps1',
    'package\verify-acl.ps1'
)
foreach ($rel in $frozenSame) {
    $r5File = Join-Path $r5Item.FullName $rel
    $r6File = Join-Path $r6Item.FullName $rel
    $same = (Test-Path -LiteralPath $r5File -PathType Leaf) -and (Test-Path -LiteralPath $r6File -PathType Leaf)
    if ($same) {
        $same = ((Get-FileHash -Algorithm SHA256 -LiteralPath $r5File).Hash -eq (Get-FileHash -Algorithm SHA256 -LiteralPath $r6File).Hash)
    }
    Assert-Requirement $same ("frozen identical " + $rel)
}
$designedDifferent = @('package\install-service.ps1', 'package\service-runtime.json', 'package\README.md')
foreach ($rel in $designedDifferent) {
    $r5File = Join-Path $r5Item.FullName $rel
    $r6File = Join-Path $r6Item.FullName $rel
    $changed = (Test-Path -LiteralPath $r5File -PathType Leaf) -and (Test-Path -LiteralPath $r6File -PathType Leaf)
    if ($changed) {
        $changed = ((Get-FileHash -Algorithm SHA256 -LiteralPath $r5File).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $r6File).Hash)
    }
    Assert-Requirement $changed ("designed change present " + $rel)
}
foreach ($rel in @('package\configure-recovery.ps1', 'package\verify-recovery.ps1', 'package\regression-recovery.ps1')) {
    Assert-Requirement ((Test-Path -LiteralPath (Join-Path $r6Item.FullName $rel) -PathType Leaf) -and (-not (Test-Path -LiteralPath (Join-Path $r5Item.FullName $rel)))) ("r6_only " + $rel)
}
Assert-Requirement ((Test-Path -LiteralPath (Join-Path $r5Package 'acl-rollback-snapshot.json') -PathType Leaf) -and (-not (Test-Path -LiteralPath (Join-Path $r6Package 'acl-rollback-snapshot.json')))) 'acl rollback snapshot not carried into the R6 corrective'
Assert-Requirement (-not (Test-Path -LiteralPath (Join-Path $r6Item.FullName 'state'))) 'restricted runtime directory not carried into the R6 corrective'
Assert-Requirement (-not (Test-Path -LiteralPath (Join-Path $r6Item.FullName 'logs'))) 'runtime logs directory not carried into the R6 corrective'
$parityOk = ($failures.Count -eq $parityStart)

Write-Output 'SECTION R6_TO_R6A_FREEZE'
# Byte-level freeze of the immutable R6 baseline against the R6A corrective root:
# every file must be byte-identical except the two designed R6A changes
# (configure-recovery.ps1 access contract; regression-recovery.ps1 regression extension).
$freezeStart = $failures.Count
$r6bFreezeItem = Get-Item -LiteralPath $R6BaselineRoot -ErrorAction Stop
$r6bRootFiles = @{}
foreach ($f in (Get-ChildItem -LiteralPath $r6bFreezeItem.FullName -Recurse -File)) {
    $r6bRootFiles[$f.FullName.Substring($r6bFreezeItem.FullName.Length + 1)] = $f
}
$r6aRootFiles = @{}
foreach ($f in (Get-ChildItem -LiteralPath $r6Item.FullName -Recurse -File)) {
    $r6aRootFiles[$f.FullName.Substring($r6Item.FullName.Length + 1)] = $f
}
$r6aDesignedChange = @('package\configure-recovery.ps1', 'package\regression-recovery.ps1')
Assert-Requirement ($r6bRootFiles.Count -eq 35) 'r6a_freeze immutable R6 baseline carries 35 files'
Assert-Requirement ($r6aRootFiles.Count -eq $r6bRootFiles.Count) 'r6a_freeze R6A carries the same file count as the baseline'
foreach ($rel in ($r6bRootFiles.Keys | Sort-Object)) {
    if (-not $r6aRootFiles.ContainsKey($rel)) {
        Assert-Requirement $false ('r6a_freeze counterpart present ' + $rel)
        continue
    }
    $hBase = (Get-FileHash -LiteralPath $r6bRootFiles[$rel].FullName -Algorithm SHA256).Hash
    $hNew = (Get-FileHash -LiteralPath $r6aRootFiles[$rel].FullName -Algorithm SHA256).Hash
    if ($r6aDesignedChange -contains $rel) {
        Assert-Requirement ($hBase -ne $hNew) ('r6a_freeze designed change present ' + $rel)
    } else {
        Assert-Requirement ($hBase -eq $hNew) ('r6a_freeze byte-identical ' + $rel)
    }
}
foreach ($rel in ($r6aRootFiles.Keys | Sort-Object)) {
    Assert-Requirement ($r6bRootFiles.ContainsKey($rel)) ('r6a_freeze no unauthorized addition ' + $rel)
}
foreach ($rel in @('package\verify-recovery.ps1', 'package\install-service.ps1', 'package\service-runtime.json', 'package\README.md')) {
    $hBase = (Get-FileHash -LiteralPath (Join-Path $r6bFreezeItem.FullName $rel) -Algorithm SHA256).Hash
    $hNew = (Get-FileHash -LiteralPath (Join-Path $r6Item.FullName $rel) -Algorithm SHA256).Hash
    Assert-Requirement ($hBase -eq $hNew) ('r6a_freeze prefer-exact file identical ' + $rel)
}
$freezeOk = ($failures.Count -eq $freezeStart)

Write-Output 'SECTION R6A_TO_R7_FREEZE'
# Byte-level freeze of the immutable R6A corrective against the R7 corrective
# root: every file must be byte-identical except the five designed R7 changes
# (main.go runtime/host/decoupling, rebuilt binary, extended package harness,
# extended runtime definition, extended README); the five additions are the
# only files allowed to appear.
$r7FreezeStart = $failures.Count
$r7RootFiles = @{}
foreach ($f in (Get-ChildItem -LiteralPath $r7Item.FullName -Recurse -File)) {
    $r7RootFiles[$f.FullName.Substring($r7Item.FullName.Length + 1)] = $f
}
$r7DesignedChange = @('main.go', 'winhelm-go-tls-ingress-hardening-r1.exe', 'package\regression-recovery.ps1', 'package\service-runtime.json', 'package\README.md')
$r7DesignedAddition = @('service_windows.go', 'service_host_test.go', 'public_route_test.go', 'package\public-route-control.ps1', 'package\public-route-status.ps1')
Assert-Requirement ($r6aRootFiles.Count -eq 35) 'r7_freeze R6A baseline carries 35 files'
Assert-Requirement ($r7RootFiles.Count -eq 40) 'r7_freeze R7 carries 40 files'
foreach ($rel in ($r6aRootFiles.Keys | Sort-Object)) {
    if (-not $r7RootFiles.ContainsKey($rel)) {
        Assert-Requirement $false ('r7_freeze counterpart present ' + $rel)
        continue
    }
    $hBase = (Get-FileHash -LiteralPath $r6aRootFiles[$rel].FullName -Algorithm SHA256).Hash
    $hNew = (Get-FileHash -LiteralPath $r7RootFiles[$rel].FullName -Algorithm SHA256).Hash
    if ($r7DesignedChange -contains $rel) {
        Assert-Requirement ($hBase -ne $hNew) ('r7_freeze designed change present ' + $rel)
    } else {
        Assert-Requirement ($hBase -eq $hNew) ('r7_freeze byte-identical ' + $rel)
    }
}
foreach ($rel in ($r7RootFiles.Keys | Sort-Object)) {
    if ($r6aRootFiles.ContainsKey($rel)) { continue }
    Assert-Requirement ($r7DesignedAddition -contains $rel) ('r7_freeze addition is designed ' + $rel)
}
foreach ($rel in $r7DesignedAddition) {
    Assert-Requirement ((Test-Path -LiteralPath (Join-Path $r7Item.FullName $rel) -PathType Leaf) -and (-not $r6aRootFiles.ContainsKey($rel))) ('r7_only ' + $rel)
}
$r7FreezeOk = ($failures.Count -eq $r7FreezeStart)

Write-Output 'SECTION R8_FREEZE'
# Byte-level freeze of the immutable R7 reviewed candidate against the R8
# corrective root: every file must be byte-identical except the designed R8
# changes (explicit service dispatcher, Foreground-aware route check, rebuilt
# binary, extended package harness, extended runtime definition, extended
# installer, extended README); no file may be added or removed.
$r8FreezeStart = $failures.Count
$r8RootFiles = @{}
foreach ($f in (Get-ChildItem -LiteralPath $r8Item.FullName -Recurse -File)) {
    $r8RootFiles[$f.FullName.Substring($r8Item.FullName.Length + 1)] = $f
}
$r8DesignedChange = @('main.go', 'service_windows.go', 'service_host_test.go', 'public_route_test.go', 'winhelm-go-tls-ingress-hardening-r1.exe', 'package\install-service.ps1', 'package\regression-recovery.ps1', 'package\service-runtime.json', 'package\README.md')
Assert-Requirement ($r7RootFiles.Count -eq 40) 'r8_freeze R7 reviewed candidate carries 40 files'
Assert-Requirement ($r8RootFiles.Count -eq 40) 'r8_freeze R8 carries the same file count as R7'
foreach ($rel in ($r7RootFiles.Keys | Sort-Object)) {
    if (-not $r8RootFiles.ContainsKey($rel)) {
        Assert-Requirement $false ('r8_freeze counterpart present ' + $rel)
        continue
    }
    $hBase = (Get-FileHash -LiteralPath $r7RootFiles[$rel].FullName -Algorithm SHA256).Hash
    $hNew = (Get-FileHash -LiteralPath $r8RootFiles[$rel].FullName -Algorithm SHA256).Hash
    if ($r8DesignedChange -contains $rel) {
        Assert-Requirement ($hBase -ne $hNew) ('r8_freeze designed change present ' + $rel)
    } else {
        Assert-Requirement ($hBase -eq $hNew) ('r8_freeze byte-identical ' + $rel)
    }
}
foreach ($rel in ($r8RootFiles.Keys | Sort-Object)) {
    Assert-Requirement ($r7RootFiles.ContainsKey($rel)) ('r8_freeze no addition or removal ' + $rel)
}
$r8FreezeOk = ($failures.Count -eq $r8FreezeStart)

Write-Output 'SECTION SERVICE_MODE_R8'
# Static contract of the explicit service mode: the registered ImagePath
# carries --service, the dispatcher is reached directly after argument parsing,
# and the production happy path no longer depends on svc.IsWindowsService().
$serviceModeStart = $failures.Count
$r8InstallerText = Get-Text (Join-Path $r8Package 'install-service.ps1')
Assert-Requirement ($r8InstallerText.Contains('--service''')) 'r8_service_mode installer ImagePath carries the explicit --service argument'
Assert-Requirement ($r8InstallerText -match '--config "\{1\}" --service''') 'r8_service_mode installer binPath template places --service with the config argument'
Assert-Requirement (-not [bool] ($r8InstallerText -match '--login')) 'r8_service_mode installer still carries no --login'
$r8RuntimeText = Get-Text (Join-Path $r8Package 'service-runtime.json')
Assert-Requirement ($r8RuntimeText.Contains('"--service"')) 'r8_service_mode runtime normal arguments carry --service'
Assert-Requirement ($r8RuntimeText.Contains('"serviceModeArgument": "--service"')) 'r8_service_mode runtime names the explicit service mode argument'
$r8RuntimeObj = $r8RuntimeText | ConvertFrom-Json
Assert-Requirement ([bool] (@($r8RuntimeObj.normalArguments) -contains '--service')) 'r8_service_mode runtime normal arguments object includes --service'
Assert-Requirement ($r8MainText.Contains('flag.Bool("service", false,')) 'r8_service_mode main declares the explicit service flag'
Assert-Requirement ($r8MainText.Contains('if serviceMode {')) 'r8_service_mode main takes the --service branch directly after parsing'
Assert-Requirement ($r8MainText.Contains('runEntrypoint(*configPath, *loginOnly, *serviceMode)')) 'r8_service_mode parsed flag reaches the dispatcher'
Assert-Requirement (($r8MainText.Contains('serviceHostRunner(configPath, loginOnly)')) -and ($swText.Contains('serviceHostRunner    = runServiceHost'))) 'r8_service_mode service host entry remains the dispatcher call'
Assert-Requirement (-not [bool] ((Strip-LineComments (Get-Text (Join-Path $r8Item.FullName 'main.go'))) -match 'svc\.IsWindowsService\(\)')) 'r8_service_mode production dispatch never calls the SCM autodetector'
Assert-Requirement ((Get-Text (Join-Path $r8Package 'enroll.ps1')).Contains('--login')) 'r8_service_mode enrollment remains the explicit --login lane'
$serviceModeOk = ($failures.Count -eq $serviceModeStart)

Write-Output 'SECTION ROUTE_FOREGROUND_R8'
# Static contract of the Foreground-aware route inactivity: routeActive must
# inspect ServeConfig.Foreground with the same predicate so a foreground
# TCP/443 or funnel session counts as active, and no raw ServeConfig content
# may be logged.
$fgStart = $failures.Count
$routeActiveBody = Get-MethodBody $r8MainText 'func (c *publicRouteController) routeActive(' "`nfunc "
Assert-Requirement ($null -ne $routeActiveBody) 'r8_foreground routeActive body extracted'
if ($null -ne $routeActiveBody) {
    Assert-Requirement ($routeActiveBody.Contains('sc.Foreground')) 'r8_foreground routeActive inspects ServeConfig.Foreground'
    Assert-Requirement ($routeActiveBody.Contains('c.routeActive(fg)')) 'r8_foreground foreground sessions use the same active predicate'
    Assert-Requirement ($routeActiveBody.Contains('sc.AllowFunnel[c.routeHostPort()]')) 'r8_foreground top-level funnel host check preserved'
    Assert-Requirement ($routeActiveBody.Contains('sc.TCP[publicRoutePort]')) 'r8_foreground top-level TCP 443 check preserved'
    Assert-Requirement ($routeActiveBody.Contains('sc.IsFunnelOn()')) 'r8_foreground funnel-anywhere check preserved'
    Assert-Requirement (-not [bool] ($routeActiveBody -match 'logger|emit|log\.')) 'r8_foreground routeActive logs nothing (no raw ServeConfig content)'
}
Assert-Requirement (-not [bool] ($r8MainText -match 'log\.Print.*ServeConfig')) 'r8_foreground no raw ServeConfig printing anywhere'
Assert-Requirement ($r8MainText.Contains('ensureInactive(ctx, "startup_prelisten")')) 'r8_foreground startup prelisten confirmation present'
Assert-Requirement ($r8MainText.Contains('ensureInactive(ctx, "startup_preready")')) 'r8_foreground startup preready confirmation present'
$fgOk = ($failures.Count -eq $fgStart)

Write-Output 'SECTION SERVICE_HOST_R7'
# Static contract of the native SCM service host lane.
$serviceHostStart = $failures.Count
Assert-Requirement (Test-Path -LiteralPath $serviceHostPath -PathType Leaf) 'r7_service_host service_windows.go present'
foreach ($needle in @('svc.Run(winhelmServiceName,', 'svc.IsWindowsService()', 'svc.StartPending', 'svc.Running', 'svc.AcceptStop | svc.AcceptShutdown', 'svc.StopPending', 'CheckPoint: checkpoint', 'serviceFailureExitCode')) {
    Assert-Requirement ($swText.Contains($needle)) ('r7_service_host contains ' + $needle)
}
Assert-Requirement (-not $swText.Contains('svc.Stopped')) 'r7_service_host never publishes the terminal Stopped itself'
Assert-Requirement ($swText -match 'serviceStartPendingInterval\s*=\s*5 \* time\.Second') 'r7_service_host start pending interval pinned to 5s'
Assert-Requirement ($swText -match 'serviceStopWaitHardCap\s*=\s*45 \* time\.Minute') 'r7_service_host stop wait hard cap pinned to 45m'
$loginGateIndex = $swText.IndexOf('errServiceLoginForbidden', [System.StringComparison]::Ordinal)
$dispatchIndex = $swText.IndexOf('svc.Run(', [System.StringComparison]::Ordinal)
Assert-Requirement ($loginGateIndex -ge 0 -and $dispatchIndex -gt $loginGateIndex) 'r7_service_host login refusal precedes the dispatcher'
Assert-Requirement ($swText.Contains('--config is required')) 'r7_service_host refuses an empty config before the dispatcher'
foreach ($needle in @('SetServeConfig', 'SetFunnel', 'SetTCPForwarding', 'net.Listen', 'NamedPipe')) {
    Assert-Requirement (-not $swText.Contains($needle)) ('r7_service_host contains none of the public-route surface: ' + $needle)
}
Assert-Requirement ($r8MainText.Contains('serviceHostRunner(configPath, loginOnly)')) 'r7_service_host console/service dispatch present in main.go'
Assert-Requirement ($r8MainText.Contains('detectWindowsService()')) 'r7_service_host detection seam present in main.go'
Assert-Requirement ($swText.Contains('detectWindowsService = isWindowsService')) 'r7_service_host detection seam binds the SCM detector'
Assert-Requirement ($swText.Contains('serviceHostRunner    = runServiceHost')) 'r7_service_host service host seam binds the dispatcher entry'
Assert-Requirement ($r8MainText.Contains('winhelmServiceName = "WinHelmGoTlsIngressHardeningR1"')) 'r7_service_host dispatcher name constant exact'
$r7InstallerText = Get-Text (Join-Path $r7Package 'install-service.ps1')
Assert-Requirement ($r7InstallerText.Contains("'WinHelmGoTlsIngressHardeningR1'")) 'r7_service_host installer registers the exact dispatcher name'
Assert-Requirement (-not [bool] ($r7InstallerText -match '--login')) 'r7_service_host normal installer carries no --login'
Assert-Requirement ((Get-Text (Join-Path $r7Package 'enroll.ps1')).Contains('--login')) 'r7_service_host enrollment remains the explicit --login lane'
$r7Runtime = Get-Text (Join-Path $r7Package 'service-runtime.json') | ConvertFrom-Json
$hostBlock = $r7Runtime.serviceHost
$routeBlock = $r7Runtime.publicRoute
Assert-Requirement ($null -ne $hostBlock) 'r7_service_host runtime definition carries the host block'
if ($null -ne $hostBlock) {
    Assert-Requirement ($hostBlock.dispatcher -eq 'golang.org/x/sys/windows/svc') 'r7_service_host runtime dispatcher pinned'
    Assert-Requirement ($hostBlock.loginInServiceMode -eq $false) 'r7_service_host runtime forbids login in service mode'
    Assert-Requirement ([int] $hostBlock.startPendingIntervalMs -eq 5000) 'r7_service_host runtime start pending interval 5000ms'
    Assert-Requirement ([int] $hostBlock.waitHintMs -eq 30000) 'r7_service_host runtime wait hint 30000ms'
    Assert-Requirement ([int] $hostBlock.stopWaitHardCapMs -eq 2700000) 'r7_service_host runtime stop hard cap 2700000ms'
    Assert-Requirement ((@($hostBlock.acceptedControls) -join ',') -ceq 'stop,shutdown,interrogate') 'r7_service_host runtime accepted controls exact'
    Assert-Requirement ($hostBlock.consoleNoFlag -eq 'fail_closed') 'r7_service_host runtime console lane fails closed'
}
Assert-Requirement ($null -ne $routeBlock) 'r7_service_host runtime definition carries the public route block'
if ($null -ne $routeBlock) {
    Assert-Requirement ($routeBlock.normalStartup -eq 'inactive') 'r7_service_host runtime normal startup inactive'
    Assert-Requirement ($routeBlock.activationMode -eq 'explicit_admin_control_request') 'r7_service_host runtime activation is an explicit admin request'
    Assert-Requirement ([int] $routeBlock.targetPublicPort -eq 443) 'r7_service_host runtime target port 443'
    Assert-Requirement ($routeBlock.targetLocalListener -eq '127.0.0.1:19447') 'r7_service_host runtime target listener exact'
    Assert-Requirement ([int] $routeBlock.pollIntervalSeconds -eq 5) 'r7_service_host runtime poll interval 5s'
    Assert-Requirement ($routeBlock.secretsInStatus -eq $false) 'r7_service_host runtime status carries no secrets'
    Assert-Requirement ($routeBlock.controlHelper -eq 'public-route-control.ps1') 'r7_service_host runtime names the control helper'
    Assert-Requirement ($routeBlock.readOnlyVerifier -eq 'public-route-status.ps1') 'r7_service_host runtime names the read-only verifier'
}
$serviceHostOk = ($failures.Count -eq $serviceHostStart)

Write-Output 'SECTION PUBLIC_DECOUPLING_R7'
# Static contract of the public activation decoupling: the normal run path only
# ever confirms inactivity; activation lives behind the explicit admin control
# request handled by the same tsnet owner.
$decouplingStart = $failures.Count
$routeCallCount = ([regex]::Matches($r8MainText, [regex]::Escape('SetFunnel('))).Count
$forwardCount = ([regex]::Matches($r8MainText, [regex]::Escape('SetTCPForwarding('))).Count
$activationEventCount = ([regex]::Matches($r8MainText, [regex]::Escape('PUBLIC_SERVE_ACTIVE'))).Count
Assert-Requirement ($routeCallCount -eq 1) 'r7_decoupling exactly one funnel mapping site'
Assert-Requirement ($forwardCount -eq 1) 'r7_decoupling exactly one forwarding mapping site'
Assert-Requirement ($activationEventCount -eq 1) 'r7_decoupling exactly one explicit activation event site'
Assert-Requirement ($r8MainText -match 'controlDirName\s*=\s*"control"') 'r7_decoupling control directory name pinned'
Assert-Requirement ($r8MainText -match 'controlRequestName\s*=\s*"request.json"') 'r7_decoupling request file name pinned'
Assert-Requirement ($r8MainText -match 'controlStatusName\s*=\s*"status.json"') 'r7_decoupling status file name pinned'
Assert-Requirement ($r8MainText -match 'controlPollInterval\s*=\s*5 \* time\.Second') 'r7_decoupling poll interval pinned to 5s'
Assert-Requirement ($r8MainText.Contains('"public_route"')) 'r7_decoupling sanitized status carries the public route field'
$bodyText = Get-MethodBody $r8MainText 'func runIngress(' "`nfunc "
Assert-Requirement ($null -ne $bodyText) 'r7_decoupling runIngress body extracted'
if ($null -ne $bodyText) {
    Assert-Requirement (-not $bodyText.Contains('PUBLIC_SERVE_ACTIVE')) 'r7_decoupling activation event outside the normal run path'
    Assert-Requirement (-not $bodyText.Contains('isolated_funnel_contract')) 'r7_decoupling old isolated funnel contract removed from the run path'
    Assert-Requirement (-not $bodyText.Contains('log.Fatal')) 'r7_decoupling run path returns errors instead of fatal exits'
    Assert-Requirement ($bodyText.Contains('control.process(ctx)')) 'r7_decoupling control request processed in the run loop'
    Assert-Requirement ($bodyText.Contains('discardStaleRequest()')) 'r7_decoupling stale request discarded at startup'
    Assert-Requirement ($bodyText.Contains('clearRoute(ctx, "stop")')) 'r7_decoupling stop path clears the public route'
    Assert-Requirement ($bodyText.Contains('CONTROL_STATUS_WRITE_FAILED')) 'r7_decoupling status write failures are observable'
}
$decouplingOrder = @(
    'acquireStateLock(stateDir)',
    'srv.Up(startupCtx)',
    'srv.LocalClient()',
    'controlDir := filepath.Join(stateDir, controlDirName)',
    'control.discardStaleRequest()',
    'ensureInactive(ctx, "startup_prelisten")',
    'manager.refresh(ctx)',
    'net.Listen("tcp", cfg.Listen)',
    'ensureInactive(ctx, "startup_preready")',
    'GO_TLS_INGRESS_READY',
    '"public_route": "inactive"',
    'ready()'
)
$orderOk = $true
$lastIndex = -1
foreach ($marker in $decouplingOrder) {
    $idx = $r8MainText.IndexOf($marker, [System.StringComparison]::Ordinal)
    if (($idx -lt 0) -or ($idx -le $lastIndex)) {
        $orderOk = $false
        Write-Output ('ORDER_VIOLATION ' + $marker)
        break
    }
    $lastIndex = $idx
}
Assert-Requirement $orderOk 'r7_decoupling startup ordering strictly increasing'
$controlScript = Join-Path $r7Package 'public-route-control.ps1'
$statusScript = Join-Path $r7Package 'public-route-status.ps1'
$controlText = Get-Text $controlScript
$statusText = Get-Text $statusScript
Assert-Requirement ($controlText.Contains("ValidateSet('activate', 'deactivate')")) 'r7_control action set restricted to activate/deactivate'
Assert-Requirement ($controlText.Contains('127.0.0.1:19447')) 'r7_control pins the exact local listener'
Assert-Requirement ($controlText.Contains('Move-Item')) 'r7_control publishes the request via a same-directory move'
Assert-Requirement ($controlText.Contains('request.json')) 'r7_control targets the one-shot request file'
Assert-Requirement ($controlText -match '(?m)if \(-not \$Apply\)') 'r7_control is dry-run by default'
Assert-Requirement ($controlText.Contains('service is not running')) 'r7_control refuses to write while the service is not running'
Assert-Requirement ($controlText.Contains('already pending')) 'r7_control refuses to overwrite a pending request'
foreach ($forbidden in @('Start-Process', 'Start-Service', 'Stop-Service', 'Restart-Service', 'New-Service', 'Remove-Service', 'sc\.exe', '\.exe', 'Remove-Item', 'Set-Content', 'Add-Content', 'Out-File', 'Set-ItemProperty', 'New-ItemProperty', 'Set-Acl')) {
    Assert-Requirement (-not [bool] ($controlText -match $forbidden)) ('r7_control mutation-free: ' + $forbidden)
}
foreach ($forbidden in @('Start-Process', 'Start-Service', 'Stop-Service', 'Restart-Service', 'Set-Service', 'New-Service', 'Remove-Service', 'sc\.exe', '\.exe', 'Remove-Item', 'Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Set-ItemProperty', 'New-ItemProperty', 'Remove-ItemProperty', 'Set-Acl', 'Move-Item')) {
    Assert-Requirement (-not [bool] ($statusText -match $forbidden)) ('r7_status read-only: ' + $forbidden)
}
foreach ($verdictName in @('NOT_INSTALLED', 'STOPPED_NO_STATUS_FILE', 'STOPPED_ROUTE_INACTIVE', 'STOPPED_ROUTE_MAY_BE_STALE', 'STOPPED_STATUS_UNVERIFIABLE', 'LISTENER_WITHOUT_SERVICE', 'LISTENER_EVIDENCE_UNAVAILABLE', 'RUNNING_LOCAL_READY_PUBLIC_INACTIVE', 'RUNNING_PUBLIC_ACTIVE', 'RUNNING_STATUS_UNVERIFIABLE', 'RUNNING_WITHOUT_LISTENER', 'RUNNING_ROUTE_ACTIVE_WITHOUT_LISTENER')) {
    Assert-Requirement ($statusText.Contains($verdictName)) ('r7_status verdict name present: ' + $verdictName)
}
Assert-Requirement ($statusText.Contains('Get-NetTCPConnection')) 'r7_status observes the local listener read-only'
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$ctrlDryActivate = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controlScript -Root $r7Item.FullName -Action activate 2>&1)
$ctrlDryActivateExit = $LASTEXITCODE
$ctrlDryDeactivate = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controlScript -Root $r7Item.FullName -Action deactivate 2>&1)
$ctrlDryDeactivateExit = $LASTEXITCODE
$ctrlDryBogus = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controlScript -Root $r7Item.FullName -Action rebind 2>&1)
$ctrlDryBogusExit = $LASTEXITCODE
$statusProbe = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $statusScript -Root $r7Item.FullName 2>&1)
$statusProbeExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
$ctrlActivateText = ($ctrlDryActivate | ForEach-Object { [string] $_ }) -join "`n"
$ctrlDeactivateText = ($ctrlDryDeactivate | ForEach-Object { [string] $_ }) -join "`n"
$statusProbeText = ($statusProbe | ForEach-Object { [string] $_ }) -join "`n"
Assert-Requirement ($ctrlDryActivateExit -eq 0) 'r7_control activate dry-run exits zero'
Assert-Requirement ($ctrlActivateText -match 'DRY_RUN model=WINHELM_R7_PUBLIC_ROUTE_CONTROL') 'r7_control activate dry-run prints the stable model line'
Assert-Requirement ($ctrlActivateText -match 'action=activate') 'r7_control activate dry-run names the action'
Assert-Requirement ($ctrlActivateText -match 'writes=0') 'r7_control activate dry-run reports zero writes'
Assert-Requirement ($ctrlActivateText -match 'service_started=false') 'r7_control activate dry-run states the service is not started'
Assert-Requirement ($ctrlDryDeactivateExit -eq 0) 'r7_control deactivate dry-run exits zero'
Assert-Requirement ($ctrlDeactivateText -match 'action=deactivate') 'r7_control deactivate dry-run names the action'
Assert-Requirement ($ctrlDryBogusExit -ne 0) 'r7_control rejects an action outside activate/deactivate'
Assert-Requirement ($statusProbeExit -eq 0) 'r7_status verifier exits zero for the stopped unattended service'
Assert-Requirement ($statusProbeText -match 'verdict=STOPPED_NO_STATUS_FILE') 'r7_status reports the stopped/no-status-file verdict'
Assert-Requirement ($statusProbeText -match 'listener_19447=absent') 'r7_status observes no local listener'
Assert-Requirement (-not (Test-Path -LiteralPath (Join-Path $r7Item.FullName 'state'))) 'r7_control dry-runs created no state directory'
$decouplingOk = ($failures.Count -eq $decouplingStart)

Write-Output 'SECTION CONSOLE_FAIL_CLOSED_R7'
# The corrective console lane must fail closed: no-flag, missing-config,
# --service-without-config and --service --login invocations are denied without
# readiness events, activation events, or artifacts anywhere in the working
# directory. The service-lane probes use a nonexistent config path only, so
# every refusal is deterministic before any state access.
$consoleStart = $failures.Count
$correctiveExe = Join-Path $r8Item.FullName 'winhelm-go-tls-ingress-hardening-r1.exe'
Assert-Requirement (Test-Path -LiteralPath $correctiveExe -PathType Leaf) 'r7_console corrective binary present'
$consoleDir = Join-Path $env:TEMP ('r7-console-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $consoleDir | Out-Null
try {
    $prevConsoleEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location $consoleDir
    try {
        $svcLoginOut = @(& $correctiveExe --service --login --config (Join-Path $consoleDir 'missing-config.json') 2>&1)
        $svcLoginExit = $LASTEXITCODE
        $svcNoConfigOut = @(& $correctiveExe --service 2>&1)
        $svcNoConfigExit = $LASTEXITCODE
        $noArgOut = @(& $correctiveExe 2>&1)
        $noArgExit = $LASTEXITCODE
        $missingConfigOut = @(& $correctiveExe --config (Join-Path $consoleDir 'missing-config.json') 2>&1)
        $missingConfigExit = $LASTEXITCODE
        $versionOut = @(& $correctiveExe --version 2>&1)
        $versionExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $ErrorActionPreference = $prevConsoleEap
    $svcLoginText = ($svcLoginOut | ForEach-Object { [string] $_ }) -join "`n"
    $svcNoConfigText = ($svcNoConfigOut | ForEach-Object { [string] $_ }) -join "`n"
    $noArgText = ($noArgOut | ForEach-Object { [string] $_ }) -join "`n"
    $missingConfigText = ($missingConfigOut | ForEach-Object { [string] $_ }) -join "`n"
    $versionText = ($versionOut | ForEach-Object { [string] $_ }) -join "`n"
    Assert-Requirement ($svcLoginExit -ne 0) 'r7_console --service --login is denied'
    Assert-Requirement ($svcLoginText -match '--login is not available in service mode') 'r7_console --service --login denial names the forbidden login'
    Assert-Requirement ($svcLoginText -notmatch 'GO_TLS_INGRESS_READY') 'r7_console --service --login emits no readiness event'
    Assert-Requirement ($svcNoConfigExit -ne 0) 'r7_console --service without config is denied'
    Assert-Requirement ($svcNoConfigText -match '--config is required') 'r7_console --service denial names the required config'
    Assert-Requirement ($svcNoConfigText -notmatch 'GO_TLS_INGRESS_READY') 'r7_console --service without config emits no readiness event'
    Assert-Requirement ($noArgExit -ne 0) 'r7_console no-flag invocation is denied'
    Assert-Requirement ($noArgText -match '--config is required') 'r7_console no-flag denial names the required config'
    Assert-Requirement ($noArgText -notmatch 'GO_TLS_INGRESS_READY') 'r7_console no readiness event without a config'
    Assert-Requirement ($noArgText -notmatch 'PUBLIC_SERVE_ACTIVE') 'r7_console no public activation without a config'
    Assert-Requirement ($missingConfigExit -ne 0) 'r7_console missing config file is denied'
    Assert-Requirement ($missingConfigText -notmatch 'GO_TLS_INGRESS_READY') 'r7_console missing config emits no readiness event'
    Assert-Requirement ($versionExit -eq 0) 'r7_console version flag exits zero'
    Assert-Requirement ($versionText -match 'winhelm-v1\.4-r8-service-explicit-mode') 'r7_console version reports the exact R8 build label'
    $consoleArtifacts = @(Get-ChildItem -LiteralPath $consoleDir -Force)
    Assert-Requirement ($consoleArtifacts.Count -eq 0) 'r7_console console invocations created no artifacts in the working directory'
} finally {
    Remove-Item -LiteralPath $consoleDir -Recurse -Force -ErrorAction SilentlyContinue
}
$consoleOk = ($failures.Count -eq $consoleStart)

Write-Output 'SECTION BOUNDARY_END'
$boundaryStart = $failures.Count
$svcAfter = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$cimAfter = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $serviceName) -ErrorAction SilentlyContinue
$qfAfter = (@(& sc.exe qfailure $serviceName 2>&1) | ForEach-Object { [string] $_ }) -join "`n"
$qffAfter = (@(& sc.exe qfailureflag $serviceName 2>&1) | ForEach-Object { [string] $_ }) -join "`n"
Assert-Requirement (($null -ne $svcBefore) -and ($null -ne $svcAfter)) 'installed service present before and after the harness'
Assert-Requirement (($null -ne $svcAfter) -and ($svcAfter.Status -eq 'Stopped')) 'installed service still stopped after the harness'
Assert-Requirement (($null -ne $cimAfter) -and ($cimAfter.StartName -eq $expectedIdentity)) 'installed service identity unchanged after the harness'
Assert-Requirement ($qfAfter -eq $qfBefore) 'installed recovery actions unchanged during the harness'
Assert-Requirement ($qffAfter -eq $qffBefore) 'installed recovery flag unchanged during the harness'
$listenLocal = @(Get-NetTCPConnection -State Listen -LocalPort 19447 -ErrorAction SilentlyContinue)
$upstreamPidsAfter = @((Get-NetTCPConnection -State Listen -LocalPort 64239 -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) | Sort-Object)
Write-Output ("BOUNDARY_END upstream_listen_pids_before=" + ($upstreamPidsBefore -join ',') + " after=" + ($upstreamPidsAfter -join ','))
Assert-Requirement ($listenLocal.Count -eq 0) 'no listener bound on the local ingress port after the harness'
Assert-Requirement (($upstreamPidsBefore -join ',') -eq ($upstreamPidsAfter -join ',')) 'upstream listener ownership unchanged during the harness'
$boundaryOk = ($failures.Count -eq $boundaryStart)

if ($failures.Count -gt 0) {
    Write-Output ("SUMMARY FAIL count=" + $failures.Count + " checks=" + $checks)
    exit 1
}
Write-Output ("R5_RED verdict=" + $(if ($redOk) { 'RECOVERY_POLICY_NOT_MATERIALIZED' } else { 'UNEXPECTED' }))
Write-Output ("R6_RED verdict=" + $(if ($r6RedOk) { 'RESTART_HANDLE_MISSING_SERVICE_START' } else { 'UNEXPECTED' }))
Write-Output 'R6_GREEN verdict=RECOVERY_POLICY_MATERIALIZED_AND_INTEGRATED'
Write-Output ("R6A_GREEN verdict=" + $(if ($r6aGreenOk) { 'RESTART_HANDLE_ACCESS_CONTRACT_SATISFIED' } else { 'UNEXPECTED' }))
Write-Output 'FIXTURES verdict=ALL_SCENARIOS_AS_EXPECTED'
Write-Output 'DRYRUN verdict=NO_MUTATION'
Write-Output 'PREAPPLY_LIVE verdict=CONTROLLED_FAIL_PREAPPLY'
Write-Output 'PARITY verdict=R5_BYTES_EXACT'
Write-Output ("R6A_FREEZE verdict=" + $(if ($freezeOk) { 'R6_TO_R6A_BYTES_EXACT_EXCEPT_DESIGNED_CHANGE' } else { 'UNEXPECTED' }))
Write-Output ("R6A_TO_R7_FREEZE verdict=" + $(if ($r7FreezeOk) { 'R6A_TO_R7_BYTES_EXACT_EXCEPT_DESIGNED_CHANGE' } else { 'UNEXPECTED' }))
Write-Output ("SERVICE_HOST verdict=" + $(if ($serviceHostOk) { 'NATIVE_SCM_SERVICE_DISPATCH_BOUNDED_FAIL_CLOSED' } else { 'UNEXPECTED' }))
Write-Output ("R8_FREEZE verdict=" + $(if ($r8FreezeOk) { 'R7_TO_R8_BYTES_EXACT_EXCEPT_DESIGNED_CHANGE' } else { 'UNEXPECTED' }))
Write-Output ("SERVICE_MODE verdict=" + $(if ($serviceModeOk) { 'EXPLICIT_SERVICE_MODE_ARGUMENT_DISPATCHED' } else { 'UNEXPECTED' }))
Write-Output ("ROUTE_FOREGROUND verdict=" + $(if ($fgOk) { 'FOREGROUND_AWARE_ROUTE_INACTIVITY' } else { 'UNEXPECTED' }))
Write-Output ("PUBLIC_DECOUPLING verdict=" + $(if ($decouplingOk) { 'LOCAL_READY_WITHOUT_PUBLIC_ACTIVATION_CONTROL_GATED' } else { 'UNEXPECTED' }))
Write-Output ("CONSOLE_FAIL_CLOSED verdict=" + $(if ($consoleOk) { 'NO_FLAG_CONSOLE_EXECUTION_DENIED' } else { 'UNEXPECTED' }))
Write-Output 'BOUNDARY verdict=INSTALLED_SERVICE_UNTOUCHED'
Write-Output ("SUMMARY PASS checks=" + $checks)
exit 0
