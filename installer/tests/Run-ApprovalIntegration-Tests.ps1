# Run-ApprovalIntegration-Tests.ps1
# Automated Test Suite for WinHelm v1.4.1 Approval UX Installer / Setup Assistant Integration
# Revision: R5 (Option B: Non-Authoritative Receipt Redesign / Reduced Destructive Restoration Model)

Set-StrictMode -Version 2.0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Split-Path -Parent $scriptDir
$modulePath = Join-Path $workspaceRoot "src\WinHelm.ApprovalInstaller.psm1"

Import-Module $modulePath -Force

$candidateRoot = "D:\mcp\winhelm-v1.4.1-approval-ux-r1"
$testBaseDir = Join-Path ([System.IO.Path]::GetTempPath()) "winhelm-approval-test-$([System.Guid]::NewGuid())"
New-Item -ItemType Directory -Path $testBaseDir -Force | Out-Null

$results = [System.Collections.Generic.List[PSCustomObject]]::new()

function Record-TestResult {
    param(
        [string]$TestName,
        [bool]$Passed,
        [string]$Details = ""
    )
    $obj = [PSCustomObject]@{
        TestName = $TestName
        Passed = $Passed
        Details = $Details
    }
    $results.Add($obj)
    $statusStr = if ($Passed) { "[PASS]" } else { "[FAIL]" }
    Write-Host "$statusStr $TestName - $Details"
}

function New-MockWinHelmPackage {
    param([Parameter(Mandatory=$true)][string]$Path)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    Copy-Item (Join-Path $candidateRoot "dist") $Path -Recurse -Force
    Copy-Item (Join-Path $candidateRoot "package.json") (Join-Path $Path "package.json") -Force
    $targetModules = Join-Path $Path "node_modules"
    if (-not (Test-Path -LiteralPath $targetModules)) {
        New-Item -ItemType Junction -Path $targetModules -Target (Join-Path $candidateRoot "node_modules") | Out-Null
    }
}

try {
    Write-Host "=== STARTING WINHELM APPROVAL UX INSTALLER TEST SUITE (R5 OPTION B) ==="
    Write-Host "Temp Test Base: $testBaseDir"

    # Setup primary mock install root
    $mockInstallRoot = Join-Path $testBaseDir "InstalledWinHelm"
    New-MockWinHelmPackage -Path $mockInstallRoot

    $testRegRoot = "HKCU:\Software\Classes\winhelm-approval-test-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
    $testShortcut = Join-Path $testBaseDir "Shortcuts\WinHelm.lnk"
    New-Item -ItemType Directory -Path (Split-Path -Parent $testShortcut) -Force | Out-Null

    # Test 1: Status inspector reports UNAVAILABLE when not configured
    try {
        $st = Get-WinHelmApprovalIntegrationStatus -InstallRoot $mockInstallRoot -RegistryRoot $testRegRoot -ShortcutPath $testShortcut
        $p = ($st.status -eq "unavailable" -and $st.code -eq "NOT_CONFIGURED")
        Record-TestResult "test-status-inspector-unavailable" $p "Reported status=$($st.status), code=$($st.code)"
    } catch {
        Record-TestResult "test-status-inspector-unavailable" $false $_.Exception.Message
    }

    # Test 2: Clean install from absent state
    try {
        $res = Install-WinHelmApprovalIntegration `
            -InstallRoot $mockInstallRoot `
            -RegistryRoot $testRegRoot `
            -ShortcutPath $testShortcut
        
        $st = Get-WinHelmApprovalIntegrationStatus -InstallRoot $mockInstallRoot -RegistryRoot $testRegRoot -ShortcutPath $testShortcut
        $p = ($res.Status -eq "ready" -and $st.status -eq "ready" -and $st.code -eq "OK")
        Record-TestResult "test-clean-install" $p "Install returned ready; status=$($st.status)"
    } catch {
        Record-TestResult "test-clean-install" $false $_.Exception.Message
    }

    # Test 3: Idempotent install
    try {
        $res2 = Install-WinHelmApprovalIntegration `
            -InstallRoot $mockInstallRoot `
            -RegistryRoot $testRegRoot `
            -ShortcutPath $testShortcut `
            -Force
        
        $st2 = Get-WinHelmApprovalIntegrationStatus -InstallRoot $mockInstallRoot -RegistryRoot $testRegRoot -ShortcutPath $testShortcut
        $p = ($res2.Status -eq "ready" -and $st2.status -eq "ready")
        Record-TestResult "test-idempotent-install" $p "Re-install returned ready; status=$($st2.status)"
    } catch {
        Record-TestResult "test-idempotent-install" $false $_.Exception.Message
    }

    # Test 4: Owned valid repair reports ALREADY_VALID
    try {
        $repairRes = Repair-WinHelmApprovalIntegration `
            -InstallRoot $mockInstallRoot `
            -RegistryRoot $testRegRoot `
            -ShortcutPath $testShortcut
        
        $p = ($repairRes.Status -eq "ready" -and $repairRes.Code -eq "ALREADY_VALID")
        Record-TestResult "test-owned-valid-repair" $p "Repair returned code=$($repairRes.Code)"
    } catch {
        Record-TestResult "test-owned-valid-repair" $false $_.Exception.Message
    }

    # =========================================================================
    # PRESERVED R3 MANDATORY ADVERSARIAL TESTS (1 to 10)
    # =========================================================================

    # Test 5 [R3-Mandatory-1]: Foreign executable copied/renamed to node.exe + exact entrypoint substring
    try {
        $r3LookRoot = Join-Path $testBaseDir "R3LookalikeRoot"
        New-MockWinHelmPackage -Path $r3LookRoot
        $r3LookReg = "HKCU:\Software\Classes\winhelm-approval-test-r3look-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r3LookSc = Join-Path $testBaseDir "Shortcuts\R3Look.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r3LookRoot -RegistryRoot $r3LookReg -ShortcutPath $r3LookSc | Out-Null

        $fakeBinDir = Join-Path $testBaseDir "FakeRuntime"
        New-Item -ItemType Directory -Path $fakeBinDir -Force | Out-Null
        $fakeNodeExe = Join-Path $fakeBinDir "node.exe"
        Copy-Item "C:\Windows\System32\notepad.exe" $fakeNodeExe -Force

        $entrypointCanon = Join-Path (Get-CanonicalPath $r3LookRoot) "dist\index.js"
        $injectedArgs = "--foreign `"$entrypointCanon`" --extra"
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($r3LookSc, $fakeNodeExe, $injectedArgs, $r3LookRoot, "WinHelm", "Lookalike")

        $stLook = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r3LookRoot -RegistryRoot $r3LookReg -ShortcutPath $r3LookSc
        
        $threwRepair = $false
        try {
            Repair-WinHelmApprovalIntegration -InstallRoot $r3LookRoot -RegistryRoot $r3LookReg -ShortcutPath $r3LookSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwRepair = $true }
        }

        $threwUninstall = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $r3LookRoot -RegistryRoot $r3LookReg -ShortcutPath $r3LookSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwUninstall = $true }
        }

        $scAfter = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($r3LookSc)
        $preservedSc = ($scAfter.TargetPath -eq $fakeNodeExe -and $scAfter.Arguments -eq $injectedArgs)

        $p = ($stLook.status -eq "conflict" -and $stLook.code -eq "FOREIGN_SHORTCUT_CONFLICT" -and $threwRepair -and $threwUninstall -and $preservedSc)
        Record-TestResult "test-r3-mandatory-1-lookalike-node-exe" $p "Look-alike node.exe classified as conflict; Repair/Uninstall threw CONFLICT and preserved shortcut"

        Remove-Item -LiteralPath $r3LookReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-1-lookalike-node-exe" $false $_.Exception.Message
    }

    # Test 6 [R3-Mandatory-2]: Expected node.exe target + injected extra arguments
    try {
        $r3ArgsRoot = Join-Path $testBaseDir "R3InjectedArgsRoot"
        New-MockWinHelmPackage -Path $r3ArgsRoot
        $r3ArgsReg = "HKCU:\Software\Classes\winhelm-approval-test-r3args-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r3ArgsSc = Join-Path $testBaseDir "Shortcuts\R3Args.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r3ArgsRoot -RegistryRoot $r3ArgsReg -ShortcutPath $r3ArgsSc | Out-Null

        $realNode = (Get-Command node).Source
        $entrypointCanon = Join-Path (Get-CanonicalPath $r3ArgsRoot) "dist\index.js"
        $injectedArgs = "`"$entrypointCanon`" --malicious-extra-arg"
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($r3ArgsSc, $realNode, $injectedArgs, $r3ArgsRoot, "WinHelm", "InjectedArgs")

        $stArgs = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r3ArgsRoot -RegistryRoot $r3ArgsReg -ShortcutPath $r3ArgsSc

        $threwRepair = $false
        try {
            Repair-WinHelmApprovalIntegration -InstallRoot $r3ArgsRoot -RegistryRoot $r3ArgsReg -ShortcutPath $r3ArgsSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwRepair = $true }
        }

        $threwUninstall = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $r3ArgsRoot -RegistryRoot $r3ArgsReg -ShortcutPath $r3ArgsSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwUninstall = $true }
        }

        $scAfter = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($r3ArgsSc)
        $preservedSc = ($scAfter.Arguments -eq $injectedArgs)

        $p = ($stArgs.status -eq "conflict" -and $stArgs.code -eq "FOREIGN_SHORTCUT_CONFLICT" -and $threwRepair -and $threwUninstall -and $preservedSc)
        Record-TestResult "test-r3-mandatory-2-injected-shortcut-arguments" $p "Injected shortcut arguments classified as conflict; Repair/Uninstall threw CONFLICT and preserved args"

        Remove-Item -LiteralPath $r3ArgsReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-2-injected-shortcut-arguments" $false $_.Exception.Message
    }

    # Test 7 [R3-Mandatory-3]: Upgrade with foreign node.exe look-alike
    try {
        $upLookRoot1 = Join-Path $testBaseDir "UpLookV1"
        New-MockWinHelmPackage -Path $upLookRoot1
        $upLookRoot2 = Join-Path $testBaseDir "UpLookV2"
        New-MockWinHelmPackage -Path $upLookRoot2

        $upLookReg = "HKCU:\Software\Classes\winhelm-approval-test-uplook-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $upLookSc = Join-Path $testBaseDir "Shortcuts\UpLook.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $upLookRoot1 -RegistryRoot $upLookReg -ShortcutPath $upLookSc | Out-Null

        $fakeBinDir = Join-Path $testBaseDir "FakeRuntimeUp"
        New-Item -ItemType Directory -Path $fakeBinDir -Force | Out-Null
        $fakeNodeExe = Join-Path $fakeBinDir "node.exe"
        Copy-Item "C:\Windows\System32\notepad.exe" $fakeNodeExe -Force
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($upLookSc, $fakeNodeExe, "dist\index.js", $upLookRoot1, "WinHelm", "LookalikeUp")

        $threwUpgrade = $false
        try {
            Update-WinHelmApprovalIntegration -OldInstallRoot $upLookRoot1 -NewInstallRoot $upLookRoot2 -RegistryRoot $upLookReg -ShortcutPath $upLookSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwUpgrade = $true }
        }

        $scAfter = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($upLookSc)
        $preservedSc = ($scAfter.TargetPath -eq $fakeNodeExe)

        $p = ($threwUpgrade -and $preservedSc)
        Record-TestResult "test-r3-mandatory-3-upgrade-lookalike-node-exe" $p "Upgrade rejected foreign node.exe look-alike shortcut preflight and preserved shortcut"

        Remove-Item -LiteralPath $upLookReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-3-upgrade-lookalike-node-exe" $false $_.Exception.Message
    }

    # Test 8 [R3-Mandatory-4]: Upgrade with injected shortcut arguments
    try {
        $upArgsRoot1 = Join-Path $testBaseDir "UpArgsV1"
        New-MockWinHelmPackage -Path $upArgsRoot1
        $upArgsRoot2 = Join-Path $testBaseDir "UpArgsV2"
        New-MockWinHelmPackage -Path $upArgsRoot2

        $upArgsReg = "HKCU:\Software\Classes\winhelm-approval-test-upargs-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $upArgsSc = Join-Path $testBaseDir "Shortcuts\UpArgs.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $upArgsRoot1 -RegistryRoot $upArgsReg -ShortcutPath $upArgsSc | Out-Null

        $realNode = (Get-Command node).Source
        $entrypointCanon = Join-Path (Get-CanonicalPath $upArgsRoot1) "dist\index.js"
        $injectedArgs = "`"$entrypointCanon`" --extra-param"
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($upArgsSc, $realNode, $injectedArgs, $upArgsRoot1, "WinHelm", "InjectedArgsUp")

        $threwUpgrade = $false
        try {
            Update-WinHelmApprovalIntegration -OldInstallRoot $upArgsRoot1 -NewInstallRoot $upArgsRoot2 -RegistryRoot $upArgsReg -ShortcutPath $upArgsSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwUpgrade = $true }
        }

        $scAfter = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($upArgsSc)
        $preservedSc = ($scAfter.Arguments -eq $injectedArgs)

        $p = ($threwUpgrade -and $preservedSc)
        Record-TestResult "test-r3-mandatory-4-upgrade-injected-arguments" $p "Upgrade rejected injected shortcut arguments in preflight and preserved shortcut"

        Remove-Item -LiteralPath $upArgsReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-4-upgrade-injected-arguments" $false $_.Exception.Message
    }

    # Test 9 [R3-Mandatory-5]: Foreign registry command containing installRoot substring
    try {
        $subRoot = Join-Path $testBaseDir "SubstrRoot"
        New-MockWinHelmPackage -Path $subRoot
        $subReg = "HKCU:\Software\Classes\winhelm-approval-test-sub-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $subSc = Join-Path $testBaseDir "Shortcuts\Sub.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $subRoot -RegistryRoot $subReg -ShortcutPath $subSc | Out-Null

        $foreignCmdWithRoot = "`"C:\Windows\System32\cmd.exe`" /c echo `"$subRoot`" `"%1`""
        Set-ItemProperty -LiteralPath (Join-Path $subReg "shell\open\command") -Name "(default)" -Value $foreignCmdWithRoot -Force

        $threwUninstall = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $subRoot -RegistryRoot $subReg -ShortcutPath $subSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwUninstall = $true }
        }

        $cmdAfter = (Get-ItemProperty -LiteralPath (Join-Path $subReg "shell\open\command")).'(default)'
        $preserved = ($cmdAfter -eq $foreignCmdWithRoot)

        $p = ($threwUninstall -and $preserved)
        Record-TestResult "test-r3-mandatory-5-uninstall-foreign-registry-mentioning-installroot" $p "Uninstall rejected foreign command mentioning installRoot and preserved it"

        Remove-Item -LiteralPath $subReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-5-uninstall-foreign-registry-mentioning-installroot" $false $_.Exception.Message
    }

    # Test 10 [R3-Mandatory-6]: Foreign registry command containing entrypoint substring
    try {
        $entrySubRoot = Join-Path $testBaseDir "EntrySubstrRoot"
        New-MockWinHelmPackage -Path $entrySubRoot
        $entrySubReg = "HKCU:\Software\Classes\winhelm-approval-test-entrysub-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $entrySubSc = Join-Path $testBaseDir "Shortcuts\EntrySub.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $entrySubRoot -RegistryRoot $entrySubReg -ShortcutPath $entrySubSc | Out-Null

        $entrypointCanon = Join-Path (Get-CanonicalPath $entrySubRoot) "dist\index.js"
        $foreignCmdWithEntry = "`"C:\Windows\System32\notepad.exe`" `"$entrypointCanon`" `"%1`""
        Set-ItemProperty -LiteralPath (Join-Path $entrySubReg "shell\open\command") -Name "(default)" -Value $foreignCmdWithEntry -Force

        $threwUninstall = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $entrySubRoot -RegistryRoot $entrySubReg -ShortcutPath $entrySubSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwUninstall = $true }
        }

        $cmdAfter = (Get-ItemProperty -LiteralPath (Join-Path $entrySubReg "shell\open\command")).'(default)'
        $preserved = ($cmdAfter -eq $foreignCmdWithEntry)

        $p = ($threwUninstall -and $preserved)
        Record-TestResult "test-r3-mandatory-6-uninstall-foreign-registry-mentioning-entrypoint" $p "Uninstall rejected foreign command mentioning entrypoint substring and preserved it"

        Remove-Item -LiteralPath $entrySubReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-6-uninstall-foreign-registry-mentioning-entrypoint" $false $_.Exception.Message
    }

    # Test 11 [R3-Mandatory-7]: Exact healthy state lifecycle (Install -> Ready -> Clean Uninstall)
    try {
        $healthyRoot = Join-Path $testBaseDir "HealthyRoot"
        New-MockWinHelmPackage -Path $healthyRoot
        $healthyReg = "HKCU:\Software\Classes\winhelm-approval-test-healthy-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $healthySc = Join-Path $testBaseDir "Shortcuts\Healthy.lnk"

        $instRes = Install-WinHelmApprovalIntegration -InstallRoot $healthyRoot -RegistryRoot $healthyReg -ShortcutPath $healthySc
        $stHealthy = Get-WinHelmApprovalIntegrationStatus -InstallRoot $healthyRoot -RegistryRoot $healthyReg -ShortcutPath $healthySc
        $uninstRes = Uninstall-WinHelmApprovalIntegration -InstallRoot $healthyRoot -RegistryRoot $healthyReg -ShortcutPath $healthySc

        $regCleaned = (-not (Test-Path -LiteralPath $healthyReg))
        $scCleaned = (-not (Test-Path -LiteralPath $healthySc))
        $receiptCleaned = (-not (Test-Path -LiteralPath (Join-Path $healthyRoot ".winhelm-installer-receipt.json")))

        $p = ($instRes.Status -eq "ready" -and $stHealthy.status -eq "ready" -and $uninstRes.Status -eq "uninstalled" -and $regCleaned -and $scCleaned -and $receiptCleaned)
        Record-TestResult "test-r3-mandatory-7-exact-healthy-state-lifecycle" $p "Exact healthy installation installs, reports ready, and uninstalls cleanly"
    } catch {
        Record-TestResult "test-r3-mandatory-7-exact-healthy-state-lifecycle" $false $_.Exception.Message
    }

    # Test 12 [R3-Mandatory-8]: AUMID-only drift on otherwise exact shortcut -> needs_repair and Repair succeeds
    try {
        $aumidRoot = Join-Path $testBaseDir "AumidDriftRoot"
        New-MockWinHelmPackage -Path $aumidRoot
        $aumidReg = "HKCU:\Software\Classes\winhelm-approval-test-aumid-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $aumidSc = Join-Path $testBaseDir "Shortcuts\Aumid.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $aumidRoot -RegistryRoot $aumidReg -ShortcutPath $aumidSc | Out-Null

        $realNode = (Get-Command node).Source
        $entrypointCanon = Join-Path (Get-CanonicalPath $aumidRoot) "dist\index.js"
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($aumidSc, $realNode, "`"$entrypointCanon`"", $aumidRoot, "DriftedAumid", "Drift")

        $stDrift = Get-WinHelmApprovalIntegrationStatus -InstallRoot $aumidRoot -RegistryRoot $aumidReg -ShortcutPath $aumidSc
        $repairRes = Repair-WinHelmApprovalIntegration -InstallRoot $aumidRoot -RegistryRoot $aumidReg -ShortcutPath $aumidSc
        $stRepaired = Get-WinHelmApprovalIntegrationStatus -InstallRoot $aumidRoot -RegistryRoot $aumidReg -ShortcutPath $aumidSc

        $p = ($stDrift.status -eq "needs_repair" -and $repairRes.Status -eq "ready" -and $stRepaired.status -eq "ready" -and $stRepaired.details.aumidMatches)
        Record-TestResult "test-r3-mandatory-8-aumid-only-drift-repair" $p "AUMID-only drift detected as needs_repair and repaired successfully back to WinHelm"

        Remove-Item -LiteralPath $aumidReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-8-aumid-only-drift-repair" $false $_.Exception.Message
    }

    # Test 13 [R3-Mandatory-9]: Missing shortcut under owned state -> needs_repair and Repair succeeds
    try {
        $missScRoot = Join-Path $testBaseDir "MissScRoot"
        New-MockWinHelmPackage -Path $missScRoot
        $missScReg = "HKCU:\Software\Classes\winhelm-approval-test-misssc-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $missScSc = Join-Path $testBaseDir "Shortcuts\MissSc.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $missScRoot -RegistryRoot $missScReg -ShortcutPath $missScSc | Out-Null
        Remove-Item -LiteralPath $missScSc -Force

        $stMiss = Get-WinHelmApprovalIntegrationStatus -InstallRoot $missScRoot -RegistryRoot $missScReg -ShortcutPath $missScSc
        $repairRes = Repair-WinHelmApprovalIntegration -InstallRoot $missScRoot -RegistryRoot $missScReg -ShortcutPath $missScSc
        $stRepaired = Get-WinHelmApprovalIntegrationStatus -InstallRoot $missScRoot -RegistryRoot $missScReg -ShortcutPath $missScSc

        $p = ($stMiss.status -eq "needs_repair" -and $repairRes.Status -eq "ready" -and $stRepaired.status -eq "ready" -and (Test-Path -LiteralPath $missScSc))
        Record-TestResult "test-r3-mandatory-9-missing-shortcut-repair" $p "Missing shortcut detected as needs_repair and recreated by Repair"

        Remove-Item -LiteralPath $missScReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-9-missing-shortcut-repair" $false $_.Exception.Message
    }

    # Test 14 [R3-Mandatory-10]: Missing protocol command under owned state -> needs_repair and Repair succeeds
    try {
        $missProtoRoot = Join-Path $testBaseDir "MissProtoRoot"
        New-MockWinHelmPackage -Path $missProtoRoot
        $missProtoReg = "HKCU:\Software\Classes\winhelm-approval-test-missproto-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $missProtoSc = Join-Path $testBaseDir "Shortcuts\MissProto.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $missProtoRoot -RegistryRoot $missProtoReg -ShortcutPath $missProtoSc | Out-Null
        Remove-Item -LiteralPath (Join-Path $missProtoReg "shell\open\command") -Recurse -Force

        $stMiss = Get-WinHelmApprovalIntegrationStatus -InstallRoot $missProtoRoot -RegistryRoot $missProtoReg -ShortcutPath $missProtoSc
        $repairRes = Repair-WinHelmApprovalIntegration -InstallRoot $missProtoRoot -RegistryRoot $missProtoReg -ShortcutPath $missProtoSc
        $stRepaired = Get-WinHelmApprovalIntegrationStatus -InstallRoot $missProtoRoot -RegistryRoot $missProtoReg -ShortcutPath $missProtoSc

        $p = ($stMiss.status -eq "needs_repair" -and $repairRes.Status -eq "ready" -and $stRepaired.status -eq "ready" -and $stRepaired.details.commandMatches)
        Record-TestResult "test-r3-mandatory-10-missing-protocol-command-repair" $p "Missing protocol command detected as needs_repair and recreated by Repair"

        Remove-Item -LiteralPath $missProtoReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r3-mandatory-10-missing-protocol-command-repair" $false $_.Exception.Message
    }

    # =========================================================================
    # MANDATORY R5 SAME-USER ADVERSARIAL TESTS (Section 16 of Work Order R5)
    # Proves that persisted receipt is non-authoritative and live state controls.
    # =========================================================================

    # Test 15 [R5-Mandatory-1]: Forge receipt expectedProtocolCommand to bless foreign Registry
    # Live state governs: status=conflict, Repair/Upgrade/Uninstall preserve foreign command
    try {
        $r5T1Root = Join-Path $testBaseDir "R5T1WinHelm"
        New-MockWinHelmPackage -Path $r5T1Root
        $r5T1Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t1-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T1Sc = Join-Path $testBaseDir "Shortcuts\R5T1.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r5T1Root -RegistryRoot $r5T1Reg -ShortcutPath $r5T1Sc | Out-Null

        # Foreign actor replaces registry command with notepad
        $foreignCmd = '"C:\Windows\System32\notepad.exe" "%1"'
        Set-ItemProperty -LiteralPath (Join-Path $r5T1Reg "shell\open\command") -Name "(default)" -Value $foreignCmd -Force

        # Attacker modifies receipt expectedProtocolCommand to match foreign command
        $receiptPath = Join-Path (Get-CanonicalPath $r5T1Root) ".winhelm-installer-receipt.json"
        $rc = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        $rc.expectedProtocolCommand = $foreignCmd
        $rc | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Force

        $st = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T1Root -RegistryRoot $r5T1Reg -ShortcutPath $r5T1Sc

        $repairThrew = $false
        try {
            Repair-WinHelmApprovalIntegration -InstallRoot $r5T1Root -RegistryRoot $r5T1Reg -ShortcutPath $r5T1Sc | Out-Null
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $repairThrew = $true }
        }

        $upgradeThrew = $false
        try {
            $dummyNewRoot = Join-Path $testBaseDir "DummyUpgradeR5T1"
            New-MockWinHelmPackage -Path $dummyNewRoot
            Update-WinHelmApprovalIntegration -OldInstallRoot $r5T1Root -NewInstallRoot $dummyNewRoot -RegistryRoot $r5T1Reg -ShortcutPath $r5T1Sc | Out-Null
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $upgradeThrew = $true }
        }

        $uninstallThrew = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $r5T1Root -RegistryRoot $r5T1Reg -ShortcutPath $r5T1Sc | Out-Null
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $uninstallThrew = $true }
        }

        $currentCmd = (Get-ItemProperty -LiteralPath (Join-Path $r5T1Reg "shell\open\command")).'(default)'
        $foreignPreserved = ($currentCmd -eq $foreignCmd)

        $p = ($st.status -eq "conflict" -and $st.code -eq "FOREIGN_REGISTRATION_CONFLICT" -and `
              $repairThrew -and $upgradeThrew -and $uninstallThrew -and $foreignPreserved)

        Record-TestResult "test-r5-mandatory-1-forge-receipt-protocol-command" $p "Forged receipt expectedProtocolCommand ignored: live state reports conflict, Repair/Upgrade/Uninstall preserve foreign command"

        Remove-Item -LiteralPath $r5T1Reg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r5-mandatory-1-forge-receipt-protocol-command" $false $_.Exception.Message
    }

    # Test 16 [R5-Mandatory-2]: Forge receipt shortcut target/args/workdir/AUMID to bless foreign Shortcut
    try {
        $r5T2Root = Join-Path $testBaseDir "R5T2WinHelm"
        New-MockWinHelmPackage -Path $r5T2Root
        $r5T2Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t2-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T2Sc = Join-Path $testBaseDir "Shortcuts\R5T2.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r5T2Root -RegistryRoot $r5T2Reg -ShortcutPath $r5T2Sc | Out-Null

        # Foreign actor replaces shortcut with calc.exe
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($r5T2Sc, "C:\Windows\System32\calc.exe", "/foreign", "C:\Windows", "ForeignCalc", "Calc")

        # Attacker modifies receipt to bless this foreign shortcut
        $receiptPath = Join-Path (Get-CanonicalPath $r5T2Root) ".winhelm-installer-receipt.json"
        $rc = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        $rc.expectedShortcutTarget = "C:\Windows\System32\calc.exe"
        $rc.expectedShortcutArguments = "/foreign"
        $rc.expectedShortcutWorkingDirectory = "C:\Windows"
        $rc.expectedAppUserModelId = "ForeignCalc"
        $rc | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Force

        $st = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T2Root -RegistryRoot $r5T2Reg -ShortcutPath $r5T2Sc

        $repairThrew = $false
        try {
            Repair-WinHelmApprovalIntegration -InstallRoot $r5T2Root -RegistryRoot $r5T2Reg -ShortcutPath $r5T2Sc | Out-Null
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $repairThrew = $true }
        }

        $uninstallThrew = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $r5T2Root -RegistryRoot $r5T2Reg -ShortcutPath $r5T2Sc | Out-Null
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $uninstallThrew = $true }
        }

        $scDetails = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($r5T2Sc)
        $foreignPreserved = ($scDetails.TargetPath.Contains("calc.exe"))

        $p = ($st.status -eq "conflict" -and $st.code -eq "FOREIGN_SHORTCUT_CONFLICT" -and `
              $repairThrew -and $uninstallThrew -and $foreignPreserved)

        Record-TestResult "test-r5-mandatory-2-forge-receipt-shortcut-identity" $p "Forged receipt shortcut fields ignored: live state reports conflict, Repair/Uninstall preserve foreign shortcut"

        Remove-Item -LiteralPath $r5T2Reg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r5-mandatory-2-forge-receipt-shortcut-identity" $false $_.Exception.Message
    }

    # Test 17 [R5-Mandatory-3]: Forge receipt preState to calc.exe/notepad.exe -> Uninstall never restores attacker state
    try {
        $r5T3Root = Join-Path $testBaseDir "R5T3WinHelm"
        New-MockWinHelmPackage -Path $r5T3Root
        $r5T3Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t3-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T3Sc = Join-Path $testBaseDir "Shortcuts\R5T3.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r5T3Root -RegistryRoot $r5T3Reg -ShortcutPath $r5T3Sc | Out-Null

        # Attacker injects malicious restoration preState into receipt
        $receiptPath = Join-Path (Get-CanonicalPath $r5T3Root) ".winhelm-installer-receipt.json"
        $rc = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        $rc | Add-Member -MemberType NoteProperty -Name "preState" -Value ([PSCustomObject]@{
            protocol = [PSCustomObject]@{
                existed = $true
                commandValue = '"C:\Windows\System32\calc.exe" "%1"'
            }
            shortcut = [PSCustomObject]@{
                existed = $true
                targetPath = "C:\Windows\System32\notepad.exe"
            }
        }) -Force
        $rc | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Force

        # Perform Uninstall
        $uninstRes = Uninstall-WinHelmApprovalIntegration -InstallRoot $r5T3Root -RegistryRoot $r5T3Reg -ShortcutPath $r5T3Sc

        # Verify exact WinHelm was deleted, and attacker preState was NEVER written/restored
        $regExists = Test-Path -LiteralPath $r5T3Reg
        $scExists = Test-Path -LiteralPath $r5T3Sc

        $p = ($uninstRes.Status -eq "uninstalled" -and (-not $regExists) -and (-not $scExists))
        Record-TestResult "test-r5-mandatory-3-forge-receipt-prestate-never-restored" $p "Uninstall deleted exact WinHelm state and NEVER restored attacker preState (calc/notepad) to system"
    } catch {
        Record-TestResult "test-r5-mandatory-3-forge-receipt-prestate-never-restored" $false $_.Exception.Message
    }

    # Test 18 [R5-Mandatory-4]: Same-user attacker writes forged receipt -> no destructive authority gained
    try {
        $r5T4Root = Join-Path $testBaseDir "R5T4WinHelm"
        New-MockWinHelmPackage -Path $r5T4Root
        $r5T4Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t4-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T4Sc = Join-Path $testBaseDir "Shortcuts\R5T4.lnk"

        # Foreign actor owns this registry key
        New-Item -Path (Join-Path $r5T4Reg "shell\open\command") -Force | Out-Null
        Set-ItemProperty -LiteralPath (Join-Path $r5T4Reg "shell\open\command") -Name "(default)" -Value '"C:\foreign\app.exe" "%1"' -Force

        # Attacker crafts receipt claiming ownership
        $receiptPath = Join-Path (Get-CanonicalPath $r5T4Root) ".winhelm-installer-receipt.json"
        $forged = [PSCustomObject]@{
            schemaVersion = 5
            installationId = [System.Guid]::NewGuid().ToString()
            installRoot = (Get-CanonicalPath $r5T4Root)
            expectedProtocolCommand = '"C:\foreign\app.exe" "%1"'
            integrity = [PSCustomObject]@{
                algorithm = "SHA256"
                signature = "FAKESIGNATURE"
            }
        }
        $forged | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Force

        $uninstThrew = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $r5T4Root -RegistryRoot $r5T4Reg -ShortcutPath $r5T4Sc | Out-Null
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $uninstThrew = $true }
        }

        # Verify foreign command was preserved
        $cmdStillThere = (Get-ItemProperty -LiteralPath (Join-Path $r5T4Reg "shell\open\command")).'(default)' -eq '"C:\foreign\app.exe" "%1"'

        $p = ($uninstThrew -and $cmdStillThere)
        Record-TestResult "test-r5-mandatory-4-same-user-forged-receipt-no-authority" $p "Forged receipt grants zero destructive authority: Uninstall threw CONFLICT and preserved foreign command"

        Remove-Item -LiteralPath $r5T4Reg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r5-mandatory-4-same-user-forged-receipt-no-authority" $false $_.Exception.Message
    }

    # Test 19 [R5-Mandatory-5]: Delete receipt while exact live WinHelm state exists -> still classifiable, uninstall succeeds
    try {
        $r5T5Root = Join-Path $testBaseDir "R5T5WinHelm"
        New-MockWinHelmPackage -Path $r5T5Root
        $r5T5Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t5-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T5Sc = Join-Path $testBaseDir "Shortcuts\R5T5.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r5T5Root -RegistryRoot $r5T5Reg -ShortcutPath $r5T5Sc | Out-Null

        # Delete receipt file completely
        $receiptPath = Join-Path (Get-CanonicalPath $r5T5Root) ".winhelm-installer-receipt.json"
        Remove-Item -LiteralPath $receiptPath -Force

        # Live state is exact WinHelm: Status must be ready!
        $st = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T5Root -RegistryRoot $r5T5Reg -ShortcutPath $r5T5Sc
        
        # Uninstall succeeds cleanly based on live exact state
        $uninstRes = Uninstall-WinHelmApprovalIntegration -InstallRoot $r5T5Root -RegistryRoot $r5T5Reg -ShortcutPath $r5T5Sc

        $regGone = (-not (Test-Path -LiteralPath $r5T5Reg))
        $scGone = (-not (Test-Path -LiteralPath $r5T5Sc))

        $p = ($st.status -eq "ready" -and $st.details.receiptStatus -eq "MISSING" -and $uninstRes.Status -eq "uninstalled" -and $regGone -and $scGone)
        Record-TestResult "test-r5-mandatory-5-delete-receipt-exact-live-state" $p "Deleted receipt does not prevent ready status or clean uninstall of exact live WinHelm state"
    } catch {
        Record-TestResult "test-r5-mandatory-5-delete-receipt-exact-live-state" $false $_.Exception.Message
    }

    # Test 20 [R5-Mandatory-6]: Corrupt/truncate receipt while exact live WinHelm state exists -> no destructive authority change
    try {
        $r5T6Root = Join-Path $testBaseDir "R5T6WinHelm"
        New-MockWinHelmPackage -Path $r5T6Root
        $r5T6Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t6-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T6Sc = Join-Path $testBaseDir "Shortcuts\R5T6.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r5T6Root -RegistryRoot $r5T6Reg -ShortcutPath $r5T6Sc | Out-Null

        # Truncate / corrupt receipt
        $receiptPath = Join-Path (Get-CanonicalPath $r5T6Root) ".winhelm-installer-receipt.json"
        Set-Content -LiteralPath $receiptPath -Value "{ broken truncated json..." -Force

        # Status is still ready based on exact live state
        $st = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T6Root -RegistryRoot $r5T6Reg -ShortcutPath $r5T6Sc
        $uninstRes = Uninstall-WinHelmApprovalIntegration -InstallRoot $r5T6Root -RegistryRoot $r5T6Reg -ShortcutPath $r5T6Sc

        $p = ($st.status -eq "ready" -and $st.details.receiptStatus -eq "CORRUPTED" -and $uninstRes.Status -eq "uninstalled")
        Record-TestResult "test-r5-mandatory-6-corrupt-truncate-receipt-exact-live-state" $p "Corrupt receipt does not prevent ready status or clean uninstall of exact live WinHelm state"
    } catch {
        Record-TestResult "test-r5-mandatory-6-corrupt-truncate-receipt-exact-live-state" $false $_.Exception.Message
    }

    # Test 21 [R5-Mandatory-7]: Substitute receipt from another installation -> no ownership authority change
    try {
        $instA = Join-Path $testBaseDir "R5InstA"
        $instB = Join-Path $testBaseDir "R5InstB"
        New-MockWinHelmPackage -Path $instA
        New-MockWinHelmPackage -Path $instB

        $regA = "HKCU:\Software\Classes\winhelm-approval-test-r5a-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $regB = "HKCU:\Software\Classes\winhelm-approval-test-r5b-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $scA = Join-Path $testBaseDir "Shortcuts\R5A.lnk"
        $scB = Join-Path $testBaseDir "Shortcuts\R5B.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $instA -RegistryRoot $regA -ShortcutPath $scA | Out-Null
        Install-WinHelmApprovalIntegration -InstallRoot $instB -RegistryRoot $regB -ShortcutPath $scB | Out-Null

        # Copy receipt from B into A
        Copy-Item (Join-Path $instB ".winhelm-installer-receipt.json") (Join-Path $instA ".winhelm-installer-receipt.json") -Force

        # Live state of A is exact WinHelm for A -> status is ready, uninstall succeeds
        $stA = Get-WinHelmApprovalIntegrationStatus -InstallRoot $instA -RegistryRoot $regA -ShortcutPath $scA
        $uninstA = Uninstall-WinHelmApprovalIntegration -InstallRoot $instA -RegistryRoot $regA -ShortcutPath $scA

        $p = ($stA.status -eq "ready" -and $stA.details.receiptStatus -eq "BINDING_MISMATCH" -and $uninstA.Status -eq "uninstalled")
        Record-TestResult "test-r5-mandatory-7-substitute-receipt-another-install" $p "Substituted receipt does not change live ownership: status=ready, clean uninstall succeeds"

        Remove-Item -LiteralPath $regB -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r5-mandatory-7-substitute-receipt-another-install" $false $_.Exception.Message
    }

    # Test 22 [R5-Mandatory-8]: Valid-looking receipt with foreign live state -> conflict
    try {
        $r5T8Root = Join-Path $testBaseDir "R5T8WinHelm"
        New-MockWinHelmPackage -Path $r5T8Root
        $r5T8Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t8-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T8Sc = Join-Path $testBaseDir "Shortcuts\R5T8.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r5T8Root -RegistryRoot $r5T8Reg -ShortcutPath $r5T8Sc | Out-Null

        # Valid receipt exists, but live registry is mutated to foreign notepad
        Set-ItemProperty -LiteralPath (Join-Path $r5T8Reg "shell\open\command") -Name "(default)" -Value '"C:\Windows\notepad.exe" "%1"' -Force

        $st = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T8Root -RegistryRoot $r5T8Reg -ShortcutPath $r5T8Sc
        $p = ($st.status -eq "conflict" -and $st.code -eq "FOREIGN_REGISTRATION_CONFLICT")

        Record-TestResult "test-r5-mandatory-8-valid-receipt-with-foreign-live-state" $p "Valid receipt cannot override foreign live state: Status reports conflict"

        Remove-Item -LiteralPath $r5T8Reg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r5-mandatory-8-valid-receipt-with-foreign-live-state" $false $_.Exception.Message
    }

    # Test 23 [R5-Mandatory-9]: No receipt, both components absent -> install succeeds
    try {
        $r5T9Root = Join-Path $testBaseDir "R5T9WinHelm"
        New-MockWinHelmPackage -Path $r5T9Root
        $r5T9Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t9-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T9Sc = Join-Path $testBaseDir "Shortcuts\R5T9.lnk"

        # Neither receipt nor registry/shortcut exist
        $st = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T9Root -RegistryRoot $r5T9Reg -ShortcutPath $r5T9Sc
        $instRes = Install-WinHelmApprovalIntegration -InstallRoot $r5T9Root -RegistryRoot $r5T9Reg -ShortcutPath $r5T9Sc
        $stAfter = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T9Root -RegistryRoot $r5T9Reg -ShortcutPath $r5T9Sc

        $p = ($st.status -eq "unavailable" -and $st.code -eq "NOT_CONFIGURED" -and $instRes.Status -eq "ready" -and $stAfter.status -eq "ready")
        Record-TestResult "test-r5-mandatory-9-no-receipt-components-absent" $p "No receipt and absent components: reports unavailable, clean install succeeds"

        Remove-Item -LiteralPath $r5T9Reg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r5-mandatory-9-no-receipt-components-absent" $false $_.Exception.Message
    }

    # Test 24 [R5-Mandatory-10]: No receipt, exact live WinHelm state -> status/repair/uninstall behave from live state
    try {
        $r5T10Root = Join-Path $testBaseDir "R5T10WinHelm"
        New-MockWinHelmPackage -Path $r5T10Root
        $r5T10Reg = "HKCU:\Software\Classes\winhelm-approval-test-r5t10-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $r5T10Sc = Join-Path $testBaseDir "Shortcuts\R5T10.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $r5T10Root -RegistryRoot $r5T10Reg -ShortcutPath $r5T10Sc | Out-Null
        # Delete receipt
        Remove-Item -LiteralPath (Join-Path $r5T10Root ".winhelm-installer-receipt.json") -Force

        # Delete shortcut to test repair without receipt
        Remove-Item -LiteralPath $r5T10Sc -Force

        $stNeedsRepair = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T10Root -RegistryRoot $r5T10Reg -ShortcutPath $r5T10Sc
        $repairRes = Repair-WinHelmApprovalIntegration -InstallRoot $r5T10Root -RegistryRoot $r5T10Reg -ShortcutPath $r5T10Sc
        $stRepaired = Get-WinHelmApprovalIntegrationStatus -InstallRoot $r5T10Root -RegistryRoot $r5T10Reg -ShortcutPath $r5T10Sc
        $uninstRes = Uninstall-WinHelmApprovalIntegration -InstallRoot $r5T10Root -RegistryRoot $r5T10Reg -ShortcutPath $r5T10Sc

        $p = ($stNeedsRepair.status -eq "needs_repair" -and $repairRes.Status -eq "ready" -and $stRepaired.status -eq "ready" -and $uninstRes.Status -eq "uninstalled")
        Record-TestResult "test-r5-mandatory-10-no-receipt-exact-live-state-repair-uninstall" $p "No receipt: Repair and Uninstall function accurately based on exact live state"
    } catch {
        Record-TestResult "test-r5-mandatory-10-no-receipt-exact-live-state-repair-uninstall" $false $_.Exception.Message
    }

    # =========================================================================
    # TRANSACTIONAL, ROLLBACK, QUOTING & ADVERSARIAL PROTOCOL TESTS
    # =========================================================================

    # Test 25: Clean install fails closed against pre-existing foreign protocol
    try {
        $foreignInstallRoot = Join-Path $testBaseDir "AnotherApp"
        New-MockWinHelmPackage -Path $foreignInstallRoot

        $foreignReg = "HKCU:\Software\Classes\winhelm-approval-test-foreign-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        New-Item -Path (Join-Path $foreignReg "shell\open\command") -Force | Out-Null
        Set-ItemProperty -LiteralPath (Join-Path $foreignReg "shell\open\command") -Name "(default)" -Value "`"C:\foreign\app.exe`" `"%1`""

        $threwConflict = $false
        try {
            Install-WinHelmApprovalIntegration -InstallRoot $foreignInstallRoot -RegistryRoot $foreignReg -ShortcutPath (Join-Path $testBaseDir "foreign.lnk")
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwConflict = $true }
        }

        $stConflict = Get-WinHelmApprovalIntegrationStatus -InstallRoot $foreignInstallRoot -RegistryRoot $foreignReg -ShortcutPath (Join-Path $testBaseDir "foreign.lnk")
        $p = ($threwConflict -and $stConflict.status -eq "conflict" -and $stConflict.code -eq "FOREIGN_REGISTRATION_CONFLICT")
        Record-TestResult "test-foreign-protocol-conflict" $p "Foreign registration threw CONFLICT and reported status=conflict"
        
        Remove-Item -LiteralPath $foreignReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-foreign-protocol-conflict" $false $_.Exception.Message
    }

    # Test 26: Clean install fails closed against pre-existing foreign shortcut
    try {
        $foreignSc = Join-Path $testBaseDir "foreign_app.lnk"
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($foreignSc, "C:\Windows\system32\calc.exe", "", "C:\Windows", "CalculatorAppId", "Calc")

        $freshInstall = Join-Path $testBaseDir "FreshWinHelm"
        New-MockWinHelmPackage -Path $freshInstall

        $freshReg = "HKCU:\Software\Classes\winhelm-approval-test-fresh-$([System.Guid]::NewGuid().ToString().Substring(0,8))"

        $threwScConflict = $false
        try {
            Install-WinHelmApprovalIntegration -InstallRoot $freshInstall -RegistryRoot $freshReg -ShortcutPath $foreignSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwScConflict = $true }
        }

        Record-TestResult "test-foreign-shortcut-conflict" $threwScConflict "Foreign shortcut was protected against silent overwrite"
        Remove-Item -LiteralPath $foreignSc -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $freshReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-foreign-shortcut-conflict" $false $_.Exception.Message
    }

    # Test 27: Install failure rollback to exact pre-state (in-memory transaction rollback)
    try {
        $rollbackRoot = Join-Path $testBaseDir "RollbackWinHelm"
        New-MockWinHelmPackage -Path $rollbackRoot
        # Force deterministic self-check failure
        Set-Content -LiteralPath (Join-Path $rollbackRoot "dist\index.js") -Value "throw new Error('Forced self-check failure for rollback test');" -Force

        $rollbackReg = "HKCU:\Software\Classes\winhelm-approval-test-rollback-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $rollbackSc = Join-Path $testBaseDir "Shortcuts\Rollback.lnk"

        $threwRollback = $false
        try {
            Install-WinHelmApprovalIntegration `
                -InstallRoot $rollbackRoot `
                -RegistryRoot $rollbackReg `
                -ShortcutPath $rollbackSc
        } catch {
            $threwRollback = $true
        }

        # Check post-rollback state
        $postExistsReg = Test-Path -LiteralPath $rollbackReg
        $postExistsSc = Test-Path -LiteralPath $rollbackSc
        $postExistsReceipt = Test-Path -LiteralPath (Join-Path $rollbackRoot ".winhelm-installer-receipt.json")

        $p = ($threwRollback -and (-not $postExistsReg) -and (-not $postExistsSc) -and (-not $postExistsReceipt))
        Record-TestResult "test-install-failure-rollback" $p "Install failure rolled back registry, shortcut, and receipt"
    } catch {
        Record-TestResult "test-install-failure-rollback" $false $_.Exception.Message
    }

    # Test 28: Clean upgrade -> PASS
    try {
        $upgradeRoot1 = Join-Path $testBaseDir "UpgradeV1"
        New-MockWinHelmPackage -Path $upgradeRoot1

        $upgradeRoot2 = Join-Path $testBaseDir "UpgradeV2"
        New-MockWinHelmPackage -Path $upgradeRoot2

        $upReg = "HKCU:\Software\Classes\winhelm-approval-test-up-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $upSc = Join-Path $testBaseDir "Shortcuts\Up.lnk"

        # Install V1
        Install-WinHelmApprovalIntegration -InstallRoot $upgradeRoot1 -RegistryRoot $upReg -ShortcutPath $upSc | Out-Null

        # Upgrade to V2
        $upRes = Update-WinHelmApprovalIntegration -OldInstallRoot $upgradeRoot1 -NewInstallRoot $upgradeRoot2 -RegistryRoot $upReg -ShortcutPath $upSc

        $stUp = Get-WinHelmApprovalIntegrationStatus -InstallRoot $upgradeRoot2 -RegistryRoot $upReg -ShortcutPath $upSc
        $cmdVal = (Get-ItemProperty -LiteralPath (Join-Path $upReg "shell\open\command")).'(default)'

        $p = ($upRes.Status -eq "ready" -and $stUp.status -eq "ready" -and $cmdVal.Contains("UpgradeV2"))
        Record-TestResult "test-clean-upgrade" $p "Clean upgrade succeeded and pointed to UpgradeV2"
        
        Remove-Item -LiteralPath $upReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-clean-upgrade" $false $_.Exception.Message
    }

    # Test 29: Upgrade after foreign registry mutation -> CONFLICT, foreign state preserved
    try {
        $upMutRoot1 = Join-Path $testBaseDir "UpMutRegV1"
        New-MockWinHelmPackage -Path $upMutRoot1
        $upMutRoot2 = Join-Path $testBaseDir "UpMutRegV2"
        New-MockWinHelmPackage -Path $upMutRoot2

        $upMutReg = "HKCU:\Software\Classes\winhelm-approval-test-upmutreg-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $upMutSc = Join-Path $testBaseDir "Shortcuts\UpMutReg.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $upMutRoot1 -RegistryRoot $upMutReg -ShortcutPath $upMutSc | Out-Null

        # Mutate registry command to notepad
        $foreignUpCmd = "`"C:\Windows\System32\notepad.exe`" `"%1`""
        Set-ItemProperty -LiteralPath (Join-Path $upMutReg "shell\open\command") -Name "(default)" -Value $foreignUpCmd -Force

        $threwUpMutReg = $false
        try {
            Update-WinHelmApprovalIntegration -OldInstallRoot $upMutRoot1 -NewInstallRoot $upMutRoot2 -RegistryRoot $upMutReg -ShortcutPath $upMutSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwUpMutReg = $true }
        }

        $cmdAfterUp = (Get-ItemProperty -LiteralPath (Join-Path $upMutReg "shell\open\command")).'(default)'
        $preservedUpReg = ($cmdAfterUp -eq $foreignUpCmd)

        $p = ($threwUpMutReg -and $preservedUpReg)
        Record-TestResult "test-upgrade-foreign-registry-conflict" $p "Upgrade refused takeover when registry was foreign and preserved command"

        Remove-Item -LiteralPath $upMutReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-upgrade-foreign-registry-conflict" $false $_.Exception.Message
    }

    # Test 30: Upgrade after foreign shortcut mutation -> CONFLICT, foreign state preserved
    try {
        $upScRoot1 = Join-Path $testBaseDir "UpMutScV1"
        New-MockWinHelmPackage -Path $upScRoot1
        $upScRoot2 = Join-Path $testBaseDir "UpMutScV2"
        New-MockWinHelmPackage -Path $upScRoot2

        $upScReg = "HKCU:\Software\Classes\winhelm-approval-test-upmutsc-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $upScSc = Join-Path $testBaseDir "Shortcuts\UpMutSc.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $upScRoot1 -RegistryRoot $upScReg -ShortcutPath $upScSc | Out-Null

        # Mutate shortcut to notepad
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($upScSc, "C:\Windows\System32\notepad.exe", "", "C:\Windows", "ForeignApp", "Foreign")

        $threwUpMutSc = $false
        try {
            Update-WinHelmApprovalIntegration -OldInstallRoot $upScRoot1 -NewInstallRoot $upScRoot2 -RegistryRoot $upScReg -ShortcutPath $upScSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwUpMutSc = $true }
        }

        $scAfterUp = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($upScSc)
        $preservedUpSc = ($scAfterUp.TargetPath.Contains("notepad.exe") -and $scAfterUp.AppUserModelId -eq "ForeignApp")

        $p = ($threwUpMutSc -and $preservedUpSc)
        Record-TestResult "test-upgrade-foreign-shortcut-conflict" $p "Upgrade refused takeover when shortcut was foreign and preserved shortcut"

        Remove-Item -LiteralPath $upScReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-upgrade-foreign-shortcut-conflict" $false $_.Exception.Message
    }

    # Test 31: Failed upgrade -> exact prior state restored in memory
    try {
        $upFailRoot1 = Join-Path $testBaseDir "UpFailV1"
        New-MockWinHelmPackage -Path $upFailRoot1
        $upFailRoot2 = Join-Path $testBaseDir "UpFailV2"
        New-MockWinHelmPackage -Path $upFailRoot2
        # Broken entrypoint in V2
        Set-Content -LiteralPath (Join-Path $upFailRoot2 "dist\index.js") -Value "throw new Error('Broken V2 entrypoint');" -Force

        $upFailReg = "HKCU:\Software\Classes\winhelm-approval-test-upfail-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $upFailSc = Join-Path $testBaseDir "Shortcuts\UpFail.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $upFailRoot1 -RegistryRoot $upFailReg -ShortcutPath $upFailSc | Out-Null
        $cmdBeforeFail = (Get-ItemProperty -LiteralPath (Join-Path $upFailReg "shell\open\command")).'(default)'

        $threwUpFail = $false
        try {
            Update-WinHelmApprovalIntegration -OldInstallRoot $upFailRoot1 -NewInstallRoot $upFailRoot2 -RegistryRoot $upFailReg -ShortcutPath $upFailSc
        } catch {
            $threwUpFail = $true
        }

        $cmdAfterFail = (Get-ItemProperty -LiteralPath (Join-Path $upFailReg "shell\open\command")).'(default)'
        $scAfterFail = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($upFailSc)
        $receipt2Exists = Test-Path -LiteralPath (Join-Path $upFailRoot2 ".winhelm-installer-receipt.json")

        $restoredV1 = ($cmdAfterFail -eq $cmdBeforeFail -and $scAfterFail.Arguments.Contains("UpFailV1") -and (-not $receipt2Exists))
        $p = ($threwUpFail -and $restoredV1)
        Record-TestResult "test-upgrade-failure-rollback" $p "Failed upgrade rolled back exact prior V1 registry, shortcut, and cleaned new receipt"

        Remove-Item -LiteralPath $upFailReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-upgrade-failure-rollback" $false $_.Exception.Message
    }

    # Test 32: Clean uninstall removes owned state
    try {
        $uninstRoot = Join-Path $testBaseDir "UninstWinHelm"
        New-MockWinHelmPackage -Path $uninstRoot

        $uninstReg = "HKCU:\Software\Classes\winhelm-approval-test-uninst-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $uninstSc = Join-Path $testBaseDir "Shortcuts\Uninst.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $uninstRoot -RegistryRoot $uninstReg -ShortcutPath $uninstSc | Out-Null
        $uninstRes = Uninstall-WinHelmApprovalIntegration -InstallRoot $uninstRoot -RegistryRoot $uninstReg -ShortcutPath $uninstSc

        $regLeft = Test-Path -LiteralPath $uninstReg
        $scLeft = Test-Path -LiteralPath $uninstSc
        $receiptLeft = Test-Path -LiteralPath (Join-Path $uninstRoot ".winhelm-installer-receipt.json")

        $p = ($uninstRes.Status -eq "uninstalled" -and (-not $regLeft) -and (-not $scLeft) -and (-not $receiptLeft))
        Record-TestResult "test-uninstall-clean" $p "Clean uninstall removed registry, shortcut, and receipt"
    } catch {
        Record-TestResult "test-uninstall-clean" $false $_.Exception.Message
    }

    # Test 33 [R5 Option B Contract]: No arbitrary prior-state restoration in Uninstall; Install refuses foreign pre-state
    try {
        $noRestoRoot = Join-Path $testBaseDir "NoRestoWinHelm"
        New-MockWinHelmPackage -Path $noRestoRoot

        $noRestoReg = "HKCU:\Software\Classes\winhelm-approval-test-noresto-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $noRestoSc = Join-Path $testBaseDir "Shortcuts\NoResto.lnk"

        # Pre-existing foreign state
        New-Item -Path (Join-Path $noRestoReg "shell\open\command") -Force | Out-Null
        Set-ItemProperty -LiteralPath (Join-Path $noRestoReg "shell\open\command") -Name "(default)" -Value "foreign-handler.exe `"%1`""

        # Install refuses foreign state even with -Force
        $installRefused = $false
        try {
            Install-WinHelmApprovalIntegration -InstallRoot $noRestoRoot -RegistryRoot $noRestoReg -ShortcutPath $noRestoSc -Force | Out-Null
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $installRefused = $true }
        }

        # Verify foreign handler was preserved
        $foreignHandlerStillThere = (Get-ItemProperty -LiteralPath (Join-Path $noRestoReg "shell\open\command")).'(default)' -eq "foreign-handler.exe `"%1`""

        $p = ($installRefused -and $foreignHandlerStillThere)
        Record-TestResult "test-r5-install-refuses-foreign-state-preserves-prior" $p "Install refuses pre-existing foreign protocol, preventing need for arbitrary foreign-state restoration"

        Remove-Item -LiteralPath $noRestoReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-r5-install-refuses-foreign-state-preserves-prior" $false $_.Exception.Message
    }

    # Test 34: Uninstall after foreign registry mutation -> CONFLICT, foreign command preserved
    try {
        $tamperRoot = Join-Path $testBaseDir "TamperWinHelm"
        New-MockWinHelmPackage -Path $tamperRoot

        $tamperReg = "HKCU:\Software\Classes\winhelm-approval-test-tamper-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $tamperSc = Join-Path $testBaseDir "Shortcuts\Tamper.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $tamperRoot -RegistryRoot $tamperReg -ShortcutPath $tamperSc | Out-Null

        # Foreign actor mutates registry command post-install
        $foreignTamperCmd = "third-party.exe `"%1`""
        Set-ItemProperty -LiteralPath (Join-Path $tamperReg "shell\open\command") -Name "(default)" -Value $foreignTamperCmd -Force

        $threwTamperConflict = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $tamperRoot -RegistryRoot $tamperReg -ShortcutPath $tamperSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwTamperConflict = $true }
        }

        # Verify foreign state was NOT deleted and receipt was preserved
        $foreignStillThere = (Get-ItemProperty -LiteralPath (Join-Path $tamperReg "shell\open\command")).'(default)' -eq $foreignTamperCmd
        $receiptStillThere = Test-Path -LiteralPath (Join-Path $tamperRoot ".winhelm-installer-receipt.json")
        $p = ($threwTamperConflict -and $foreignStillThere -and $receiptStillThere)
        Record-TestResult "test-uninstall-foreign-registry-tampered" $p "Uninstall detected post-install foreign registry mutation, threw CONFLICT, and preserved foreign command"

        Remove-Item -LiteralPath $tamperReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-uninstall-foreign-registry-tampered" $false $_.Exception.Message
    }

    # Test 35: Uninstall after foreign shortcut mutation -> CONFLICT, foreign shortcut preserved
    try {
        $tamperScRoot = Join-Path $testBaseDir "TamperScWinHelm"
        New-MockWinHelmPackage -Path $tamperScRoot

        $tamperScReg = "HKCU:\Software\Classes\winhelm-approval-test-tampersc-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $tamperScSc = Join-Path $testBaseDir "Shortcuts\TamperSc.lnk"

        Install-WinHelmApprovalIntegration -InstallRoot $tamperScRoot -RegistryRoot $tamperScReg -ShortcutPath $tamperScSc | Out-Null

        # Foreign actor mutates shortcut post-install
        [WinHelm.Installer.ShortcutHelper]::CreateOrUpdateShortcut($tamperScSc, "C:\Windows\System32\notepad.exe", "", "C:\Windows", "ForeignApp", "Foreign")

        $threwScTamperConflict = $false
        try {
            Uninstall-WinHelmApprovalIntegration -InstallRoot $tamperScRoot -RegistryRoot $tamperScReg -ShortcutPath $tamperScSc
        } catch {
            if ($_.Exception.Message.Contains("CONFLICT")) { $threwScTamperConflict = $true }
        }

        # Verify foreign shortcut was NOT deleted and receipt was preserved
        $scDetails = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($tamperScSc)
        $foreignScStillThere = ($scDetails.Exists -and $scDetails.TargetPath.Contains("notepad.exe") -and $scDetails.AppUserModelId -eq "ForeignApp")
        $receiptStillThere = Test-Path -LiteralPath (Join-Path $tamperScRoot ".winhelm-installer-receipt.json")

        $p = ($threwScTamperConflict -and $foreignScStillThere -and $receiptStillThere)
        Record-TestResult "test-uninstall-foreign-shortcut-tampered" $p "Uninstall detected post-install foreign shortcut mutation, threw CONFLICT, and preserved foreign shortcut"

        Remove-Item -LiteralPath $tamperScReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-uninstall-foreign-shortcut-tampered" $false $_.Exception.Message
    }

    # Test 36: Paths containing spaces
    try {
        $spaceRoot = Join-Path $testBaseDir "Path With Spaces In Dir Name\WinHelm App"
        New-MockWinHelmPackage -Path $spaceRoot

        $spaceReg = "HKCU:\Software\Classes\winhelm-approval-test-space-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $spaceSc = Join-Path $testBaseDir "Shortcuts With Spaces\Win Helm.lnk"

        $resSpace = Install-WinHelmApprovalIntegration -InstallRoot $spaceRoot -RegistryRoot $spaceReg -ShortcutPath $spaceSc
        $stSpace = Get-WinHelmApprovalIntegrationStatus -InstallRoot $spaceRoot -RegistryRoot $spaceReg -ShortcutPath $spaceSc

        $cmdSpace = (Get-ItemProperty -LiteralPath (Join-Path $spaceReg "shell\open\command")).'(default)'
        $hasProperQuotes = ($cmdSpace.StartsWith('"' ) -and $cmdSpace.Contains('" "') -and $cmdSpace.EndsWith('"%1"'))

        $p = ($resSpace.Status -eq "ready" -and $stSpace.status -eq "ready" -and $hasProperQuotes)
        Record-TestResult "test-paths-with-spaces" $p "Paths with spaces correctly quoted and verified: $cmdSpace"

        Remove-Item -LiteralPath $spaceReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-paths-with-spaces" $false $_.Exception.Message
    }

    # Test 37: Behavioral Quote/Path injection safety with shell-significant valid characters: &, (), [], +, ,, '
    try {
        $specialRoot = Join-Path $testBaseDir "App (x86) & Tools [Core] + Extra, 'Special'\WinHelm App"
        New-MockWinHelmPackage -Path $specialRoot

        $specialReg = "HKCU:\Software\Classes\winhelm-approval-test-special-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
        $specialSc = Join-Path $testBaseDir "Shortcuts (x86) & More [LNK]\Win Helm.lnk"

        # Install into complex path
        $resSpecial = Install-WinHelmApprovalIntegration -InstallRoot $specialRoot -RegistryRoot $specialReg -ShortcutPath $specialSc
        $stSpecial = Get-WinHelmApprovalIntegrationStatus -InstallRoot $specialRoot -RegistryRoot $specialReg -ShortcutPath $specialSc

        $cmdSpecial = (Get-ItemProperty -LiteralPath (Join-Path $specialReg "shell\open\command")).'(default)'
        
        # Verify quoting
        $nodeExe = (Get-Command node).Source
        $entrypointSpecial = Join-Path (Get-CanonicalPath $specialRoot) "dist\index.js"
        $expectedSpecialCmd = Build-ProtocolCommand -NodeExe $nodeExe -EntrypointPath $entrypointSpecial

        $quotesMatch = ($cmdSpecial -eq $expectedSpecialCmd)

        # Behavioral test: execute native self-check on the complex path
        $selfCheckSpecial = Test-WinHelmApprovalNativeSelfCheck -NodeExe $nodeExe -EntrypointPath $entrypointSpecial
        $probePassed = ($selfCheckSpecial.Success -and $selfCheckSpecial.Message.Contains("verified successfully"))

        # Verify uninstall cleanly removes and restores
        $uninstSpecial = Uninstall-WinHelmApprovalIntegration -InstallRoot $specialRoot -RegistryRoot $specialReg -ShortcutPath $specialSc
        $cleanedUp = (-not (Test-Path -LiteralPath $specialReg)) -and (-not (Test-Path -LiteralPath $specialSc))

        $p = ($resSpecial.Status -eq "ready" -and $stSpecial.status -eq "ready" -and $quotesMatch -and $probePassed -and $uninstSpecial.Status -eq "uninstalled" -and $cleanedUp)
        Record-TestResult "test-paths-with-special-chars-behavioral" $p "Complex path with &, (), [], +, ,, ' handled safely, verified by self-check and clean uninstall"

        Remove-Item -LiteralPath $specialReg -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Record-TestResult "test-paths-with-special-chars-behavioral" $false $_.Exception.Message
    }

    # Test 38: No PATH shadowing (verified absolute executable)
    try {
        $receipt = Read-Receipt -InstallRoot $mockInstallRoot
        $nodePath = $receipt.nodeExePath
        $p = ([System.IO.Path]::IsPathRooted($nodePath) -and (Test-Path -LiteralPath $nodePath -PathType Leaf))
        Record-TestResult "test-no-path-shadowing" $p "Node executable path is absolute and verified on disk: $nodePath"
    } catch {
        Record-TestResult "test-no-path-shadowing" $false $_.Exception.Message
    }

    # Test 39: Missing handler file validation fails closed
    try {
        $missingHandlerRoot = Join-Path $testBaseDir "EmptyWinHelm"
        New-Item -ItemType Directory -Path $missingHandlerRoot -Force | Out-Null
        $threwMissing = $false
        try {
            Install-WinHelmApprovalIntegration -InstallRoot $missingHandlerRoot -RegistryRoot "HKCU:\Software\Classes\dummy"
        } catch {
            $threwMissing = $true
        }
        Record-TestResult "test-missing-handler-failure" $threwMissing "Fails closed when dist\index.js is absent"
    } catch {
        Record-TestResult "test-missing-handler-failure" $false $_.Exception.Message
    }

    # Test 40: Non-secret self check probe
    try {
        $nodeExe = (Get-Command node).Source
        $entrypoint = Join-Path $candidateRoot "dist\index.js"
        $probe = Test-WinHelmApprovalNativeSelfCheck -NodeExe $nodeExe -EntrypointPath $entrypoint
        $p = ($probe.Success -and $probe.Message.Contains("verified successfully"))
        Record-TestResult "test-self-check-probe" $p $probe.Message
    } catch {
        Record-TestResult "test-self-check-probe" $false $_.Exception.Message
    }

    # Test 41: Zero plaintext activation token in receipts, status, and test artifacts
    try {
        $allReceipts = Get-ChildItem -Path $testBaseDir -Filter "*.json" -Recurse
        $clean = $true
        foreach ($r in $allReceipts) {
            $txt = Get-Content -LiteralPath $r.FullName -Raw
            if ($txt.Contains("token") -and -not $txt.Contains("tokenVerifier") -and -not $txt.Contains("no-token")) {
                if ($txt -match 'token=[A-Za-z0-9_-]{20,}') {
                    $clean = $false
                    break
                }
            }
        }
        Record-TestResult "test-zero-plaintext-tokens" $clean "Zero plaintext tokens found in any receipt or status file"
    } catch {
        Record-TestResult "test-zero-plaintext-tokens" $false $_.Exception.Message
    }

} finally {
    # Cleanup test base dir and any leftover test keys
    Remove-Item -LiteralPath $testBaseDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRegRoot) {
        Remove-Item -LiteralPath $testRegRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "=== TEST SUITE COMPLETE ==="
$passedCount = ($results | Where-Object { $_.Passed }).Count
$totalCount = $results.Count
Write-Host "Summary: $passedCount / $totalCount Passed."

if ($passedCount -ne $totalCount) {
    throw "Test suite FAILED: $($totalCount - $passedCount) tests failed."
}
