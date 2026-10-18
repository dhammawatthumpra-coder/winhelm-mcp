[CmdletBinding()]
param(
    [string] $ServiceName = 'WinHelmGoTlsIngressHardeningR1',
    [string] $FixtureDir
)

$ErrorActionPreference = 'Stop'
$model = 'WINHELM_R7_R6_RECOVERY_MODEL'
$expectedServiceName = 'WinHelmGoTlsIngressHardeningR1'
if ($ServiceName -ne $expectedServiceName) {
    throw "service name must remain $expectedServiceName"
}
$mode = if ($FixtureDir) { 'fixture' } else { 'live' }

$failures = [System.Collections.Generic.List[string]]::new()
function Add-Failure([string] $Class, [string] $Surface, [string] $Detail) {
    $line = "FAIL class=$Class surface=$Surface"
    if ($Detail) { $line += " detail=$Detail" }
    if (-not $failures.Contains($line)) { $failures.Add($line) | Out-Null }
}

function Get-SingleLabelValue([string[]] $Lines, [string] $Label) {
    $values = @()
    $pattern = '^\s*' + [regex]::Escape($Label) + '\s*:\s*(.*?)\s*$'
    foreach ($line in $Lines) {
        $match = [regex]::Match($line, $pattern)
        if ($match.Success) { $values += $match.Groups[1].Value }
    }
    return $values
}

Write-Output ("VERIFY_RECOVERY model=" + $model + " mode=" + $mode + " service=" + $ServiceName)

$qfailureText = $null
$qfailureflagText = $null
$blob = $null

if ($mode -eq 'live') {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        Add-Failure 'service_missing' 'service'
    } elseif ($service.Status -ne 'Stopped') {
        Add-Failure 'service_not_stopped' 'service' ("status=" + $service.Status)
    }

    $qfailureOutput = @(& sc.exe qfailure $ServiceName 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Add-Failure 'qfailure_query_failed' 'qfailure' ("exit=" + $LASTEXITCODE)
    } else {
        $qfailureText = ($qfailureOutput | ForEach-Object { [string] $_ }) -join "`n"
    }

    $qfailureflagOutput = @(& sc.exe qfailureflag $ServiceName 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Add-Failure 'qfailureflag_query_failed' 'qfailureflag' ("exit=" + $LASTEXITCODE)
    } else {
        $qfailureflagText = ($qfailureflagOutput | ForEach-Object { [string] $_ }) -join "`n"
    }

    # Read the raw SCM failure-actions blob from the service registry key. The
    # terminal none action is not shown by sc.exe qfailure display output, so the
    # registry blob is the authoritative boundedness check. Read-only access.
    try {
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services\' + $ServiceName)
        if ($null -eq $key) {
            Add-Failure 'registry_unreadable' 'registry'
        } else {
            try {
                $value = $key.GetValue('FailureActions')
            } finally {
                $key.Close()
            }
            if ($null -eq $value) {
                Add-Failure 'registry_blob_missing' 'registry'
            } elseif ($value -is [byte[]]) {
                $blob = $value
            } else {
                Add-Failure 'registry_blob_mismatch' 'registry' ('type=' + $value.GetType().Name)
            }
        }
    } catch {
        Add-Failure 'registry_unreadable' 'registry' ("detail=" + $_.Exception.Message)
    }
} else {
    $fixtureRoot = (Get-Item -LiteralPath $FixtureDir -ErrorAction Stop).FullName
    $qfailurePath = Join-Path $fixtureRoot 'qfailure.txt'
    $qfailureflagPath = Join-Path $fixtureRoot 'qfailureflag.txt'
    if (-not (Test-Path -LiteralPath $qfailurePath -PathType Leaf)) { throw 'fixture qfailure.txt is missing' }
    if (-not (Test-Path -LiteralPath $qfailureflagPath -PathType Leaf)) { throw 'fixture qfailureflag.txt is missing' }
    $qfailureText = Get-Content -LiteralPath $qfailurePath -Raw
    $qfailureflagText = Get-Content -LiteralPath $qfailureflagPath -Raw
    $blobPath = Join-Path $fixtureRoot 'failureactions.bin'
    if (-not (Test-Path -LiteralPath $blobPath -PathType Leaf)) {
        Add-Failure 'registry_blob_missing' 'registry'
    } else {
        try {
            $blob = [System.IO.File]::ReadAllBytes($blobPath)
        } catch {
            Add-Failure 'registry_unreadable' 'registry' ("detail=" + $_.Exception.Message)
        }
    }
}

if ($null -ne $qfailureText) {
    $lines = @($qfailureText -split "\r?\n")

    $nameValues = @(Get-SingleLabelValue $lines 'SERVICE_NAME')
    if ($nameValues.Count -ne 1 -or $nameValues[0] -ne $ServiceName) {
        Add-Failure 'qfailure_parse_ambiguous' 'qfailure' ("service_name_lines=" + $nameValues.Count)
    }

    $resetValues = @(Get-SingleLabelValue $lines 'RESET_PERIOD (in seconds)')
    if ($resetValues.Count -ne 1) {
        Add-Failure 'qfailure_parse_ambiguous' 'qfailure' ("reset_period_lines=" + $resetValues.Count)
    } elseif ($resetValues[0] -eq 'INFINITE') {
        Add-Failure 'reset_mismatch' 'qfailure' 'RESET_PERIOD=INFINITE'
    } elseif ($resetValues[0] -match '^\d+$') {
        if ([uint32] $resetValues[0] -ne 86400) {
            Add-Failure 'reset_mismatch' 'qfailure' ("RESET_PERIOD=" + $resetValues[0])
        }
    } else {
        Add-Failure 'qfailure_parse_ambiguous' 'qfailure' ("reset_period_token='" + $resetValues[0] + "'")
    }

    $rebootValues = @(Get-SingleLabelValue $lines 'REBOOT_MESSAGE')
    if ($rebootValues.Count -ne 1) {
        Add-Failure 'qfailure_parse_ambiguous' 'qfailure' ("reboot_message_lines=" + $rebootValues.Count)
    } elseif ($rebootValues[0]) {
        Add-Failure 'reboot_message_present' 'qfailure'
    }

    $commandValues = @(Get-SingleLabelValue $lines 'COMMAND_LINE')
    if ($commandValues.Count -ne 1) {
        Add-Failure 'qfailure_parse_ambiguous' 'qfailure' ("command_line_lines=" + $commandValues.Count)
    } elseif ($commandValues[0]) {
        Add-Failure 'recovery_command_present' 'qfailure'
    }

    $headerCount = 0
    foreach ($line in $lines) {
        if ($line -match '^\s*FAILURE_ACTIONS\s*:') { $headerCount++ }
    }
    if ($headerCount -gt 1) {
        Add-Failure 'qfailure_parse_ambiguous' 'qfailure' ("failure_actions_lines=" + $headerCount)
    }

    $actions = @()
    $multiplePerLine = $false
    foreach ($line in $lines) {
        $lineMatches = [regex]::Matches($line, '(RESTART|REBOOT|RUN PROCESS|NONE) -- Delay = (\d+) milliseconds\.')
        if ($lineMatches.Count -gt 1) { $multiplePerLine = $true }
        foreach ($match in $lineMatches) {
            $actions += , @($match.Groups[1].Value, [uint32] $match.Groups[2].Value)
        }
    }
    $delayOccurrences = ([regex]::Matches($qfailureText, '--\s*Delay\s*=')).Count
    if ($multiplePerLine -or (@($actions).Count -ne $delayOccurrences)) {
        Add-Failure 'qfailure_parse_ambiguous' 'qfailure' ("actions=" + @($actions).Count + " delay_tokens=" + $delayOccurrences)
    }

    foreach ($action in $actions) {
        if ($action[0] -eq 'REBOOT') { Add-Failure 'reboot_action_present' 'qfailure' ("delay=" + $action[1]) }
        if ($action[0] -eq 'RUN PROCESS') { Add-Failure 'recovery_command_present' 'qfailure' ("delay=" + $action[1]) }
    }

    $sequence = (($actions | ForEach-Object { $_[0].Replace(' ', '_') + ':' + [string] $_[1] }) -join '|')
    if ($sequence -notin @('RESTART:30000|RESTART:300000', 'RESTART:30000|RESTART:300000|NONE:0')) {
        if ($sequence) {
            Add-Failure 'action_sequence_mismatch' 'qfailure' ("sequence=" + $sequence)
        } else {
            Add-Failure 'action_sequence_mismatch' 'qfailure' 'sequence=none'
        }
    }
}

if ($null -ne $qfailureflagText) {
    $flagLines = @($qfailureflagText -split "\r?\n")
    $flagValues = @(Get-SingleLabelValue $flagLines 'FAILURE_ACTIONS_ON_NONCRASH_FAILURES')
    if ($flagValues.Count -ne 1) {
        Add-Failure 'noncrash_flag_unreadable' 'qfailureflag' ("lines=" + $flagValues.Count)
    } elseif ($flagValues[0].ToUpperInvariant() -eq 'TRUE') {
        # expected: non-crash failures count as failures
    } elseif ($flagValues[0].ToUpperInvariant() -eq 'FALSE') {
        Add-Failure 'noncrash_flag_false' 'qfailureflag'
    } else {
        Add-Failure 'noncrash_flag_unreadable' 'qfailureflag' ("value='" + $flagValues[0] + "'")
    }
}

if ($null -ne $blob) {
    if ($blob.Length -lt 20) {
        Add-Failure 'registry_blob_mismatch' 'registry' ("bytes=" + $blob.Length)
    } else {
        $resetSeconds = [System.BitConverter]::ToUInt32($blob, 0)
        $actionCount = [System.BitConverter]::ToUInt32($blob, 12)
        if ((20 + ($actionCount * 8)) -gt $blob.Length) {
            Add-Failure 'registry_blob_mismatch' 'registry' ("cActions=" + $actionCount + " bytes=" + $blob.Length)
        } else {
            $entries = @()
            for ($index = 0; $index -lt $actionCount; $index++) {
                $offset = 20 + ($index * 8)
                $entries += , @([System.BitConverter]::ToUInt32($blob, $offset), [System.BitConverter]::ToUInt32($blob, $offset + 4))
            }
            $terminalNone = $false
            if ($actionCount -ge 1) {
                $last = $entries[$actionCount - 1]
                $terminalNone = ($last[0] -eq 0) -and ($last[1] -eq 0)
            }
            if (-not $terminalNone) {
                Add-Failure 'none_terminal_missing' 'registry' ("cActions=" + $actionCount)
            } else {
                $exact = ($resetSeconds -eq 86400) -and
                    ($actionCount -eq 3) -and
                    ($entries[0][0] -eq 1) -and ($entries[0][1] -eq 30000) -and
                    ($entries[1][0] -eq 1) -and ($entries[1][1] -eq 300000)
                if (-not $exact) {
                    Add-Failure 'registry_blob_mismatch' 'registry' ("reset=" + $resetSeconds + " cActions=" + $actionCount)
                }
            }
        }
    }
}

if ($failures.Count -gt 0) {
    $failures | Sort-Object | ForEach-Object { Write-Output $_ }
    Write-Output ("FAIL count=" + $failures.Count + " model=$model mode=$mode")
    exit 1
}
Write-Output "PASS class=recovery_policy model=$model mode=$mode"
exit 0
