# Run-Phase2-Integrated-Activation.ps1
# Phase 2: Integrated Approval Activation Qualification
# Verifies full end-to-end integration:
# Install -> AUMID/Shortcut -> Windows Protocol Shell Activation -> Token Verification -> Job Execution -> Replay Defense -> Safe Uninstall

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Split-Path -Parent $scriptDir
$modulePath = Join-Path $workspaceRoot "src\WinHelm.ApprovalInstaller.psm1"
$candidateRoot = "D:\mcp\winhelm-v1.4.1-approval-ux-r1"

Import-Module $modulePath -Force

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  PHASE 2: INTEGRATED APPROVAL ACTIVATION QUALIFICATION" -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Cyan

$testBaseDir = Join-Path ([System.IO.Path]::GetTempPath()) "winhelm-phase2-$([System.Guid]::NewGuid().ToString().Substring(0,8))"
New-Item -ItemType Directory -Path $testBaseDir -Force | Out-Null

$mockInstallRoot = Join-Path $testBaseDir "InstalledWinHelm"
New-Item -ItemType Directory -Path $mockInstallRoot -Force | Out-Null
Copy-Item (Join-Path $candidateRoot "dist") $mockInstallRoot -Recurse -Force
Copy-Item (Join-Path $candidateRoot "package.json") (Join-Path $mockInstallRoot "package.json") -Force
New-Item -ItemType Junction -Path (Join-Path $mockInstallRoot "node_modules") -Target (Join-Path $candidateRoot "node_modules") | Out-Null

$protocolKey = "HKCU:\Software\Classes\winhelm-approval"
$programsFolder = [Environment]::GetFolderPath('Programs')
$shortcutPath = Join-Path $programsFolder "WinHelm.lnk"

Write-Host "Install Root: $mockInstallRoot"
Write-Host "Protocol Key: $protocolKey"
Write-Host "Shortcut:     $shortcutPath"
Write-Host ""

$results = [System.Collections.Generic.List[PSCustomObject]]::new()
function Record-TestResult {
    param([string]$Name, [bool]$Passed, [string]$Details = "")
    $results.Add([PSCustomObject]@{ TestName = $Name; Passed = $Passed; Details = $Details })
    $tag = if ($Passed) { "[PASS]" } else { "[FAIL]" }
    $color = if ($Passed) { "Green" } else { "Red" }
    Write-Host "$tag $Name - $Details" -ForegroundColor $color
}

# 1. Capture Pre-State
$preRegExists = Test-Path -LiteralPath $protocolKey
$preScExists = Test-Path -LiteralPath $shortcutPath

try {
    # Step 1: Install Integration
    Write-Host "`n--- Step 1: Installing WinHelm Approval Integration ---" -ForegroundColor Yellow
    $installRes = Install-WinHelmApprovalIntegration -InstallRoot $mockInstallRoot -Force
    $installStatus = Get-WinHelmApprovalIntegrationStatus -InstallRoot $mockInstallRoot
    
    $step1Pass = ($installRes.Status -eq "ready" -and $installStatus.status -eq "ready")
    Record-TestResult "P2-1-InstallIntegration" $step1Pass "Installed and verified ready status"

    # Step 2: Verify Application Identity & Shortcut
    Write-Host "`n--- Step 2: Verifying Application Identity & Start Menu Shortcut ---" -ForegroundColor Yellow
    $scDetails = [WinHelm.Installer.ShortcutHelper]::GetShortcutDetails($shortcutPath)
    $step2Pass = ($scDetails.Exists -and $scDetails.AppUserModelId -eq "WinHelm" -and $scDetails.Arguments.Contains($mockInstallRoot))
    Record-TestResult "P2-2-ApplicationIdentity" $step2Pass "AppUserModelID=WinHelm confirmed on Start Menu shortcut"

    # Step 3: Verify Protocol Registration in HKCU
    Write-Host "`n--- Step 3: Verifying Protocol Registration ---" -ForegroundColor Yellow
    $cmdItem = (Get-ItemProperty -LiteralPath (Join-Path $protocolKey "shell\open\command")).'(default)'
    $step3Pass = ($cmdItem -and $cmdItem.Contains($mockInstallRoot) -and $cmdItem.EndsWith('approval-activate "%1"'))
    Record-TestResult "P2-3-ProtocolRegistration" $step3Pass "Verified registry protocol command correctly points to installed handler"

    # Step 4: Run Node.js E2E Protocol Activation Smoke Test
    Write-Host "`n--- Step 4: Running E2E Toast Activation and Proof-of-Possession Qualification ---" -ForegroundColor Yellow
    $e2eScript = Join-Path $testBaseDir "run-e2e.mjs"
    $journalPath = Join-Path $testBaseDir "approval-jobs.json"

    # We write a pure Node script that sets up the approval engine, emits the notification payload,
    # triggers protocol activation via Windows Shell (`Start-Process`), and checks the job transition.
    $e2eCode = @"
import { getApprovalEngine, initializeApprovalPersistence, resetApprovalEngine } from 'file:///$($mockInstallRoot.Replace('\', '/'))/dist/approval/runtime.js';
import { consumeOwnedDecisions, resetCrossProcessInstanceId } from 'file:///$($mockInstallRoot.Replace('\', '/'))/dist/approval/cross-process.js';
import { notifyApprovalPending } from 'file:///$($mockInstallRoot.Replace('\', '/'))/dist/approval/notify.js';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

async function run() {
  const journalPath = '$($journalPath.Replace('\', '/'))';
  resetCrossProcessInstanceId();
  let notifiedPayload = null;
  let toolExecuted = false;

  initializeApprovalPersistence(journalPath, {
    notifyApprovals: true,
    crossProcess: true,
    notifier: (job, activationToken) => {
      void notifyApprovalPending(job, {
        activationToken,
        journalPath,
        send: async (_url, payload) => {
          notifiedPayload = payload;
        },
      });
    },
  });

  // Request an approval job
  const outcome = getApprovalEngine().request({
    tool: 'restart_service',
    args: { service: 'spooler' },
    sessionId: 'p2-qualification-session',
    ttlMs: 60000,
    maxPending: 5,
    execute: async () => {
      toolExecuted = true;
      return { success: true };
    },
  });

  const jobId = outcome.job.id;
  await new Promise(r => setTimeout(r, 50));
  assert.ok(notifiedPayload, 'Notification payload must be created');

  const approveAction = notifiedPayload.actions.find(a => a.content === 'Approve');
  assert.ok(approveAction, 'Approve action must exist');
  const actionUri = approveAction.arguments;

  // Verify URI starts with winhelm-approval:
  assert.ok(actionUri.startsWith('winhelm-approval:decide?'), 'URI must use registered winhelm-approval protocol');
  
  // Safe Redacted logging (Zero Plaintext Token Invariant)
  const redactedUri = actionUri.replace(/token=[^&]+/, 'token=[REDACTED]');
  console.log('[E2E-INFO] Activating Protocol URI:', redactedUri);

  // Trigger Windows Shell protocol activation
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    'Start-Process \"' + actionUri + '\"'
  ]);

  // Poll for completion
  let transitioned = false;
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 100));
    consumeOwnedDecisions(
      (id) => getApprovalEngine().ownsJob(id),
      (id, decision) => {
        if (decision === 'approved') getApprovalEngine().approve(id, 'native_toast');
        else getApprovalEngine().deny(id, 'native_toast');
      },
      journalPath
    );

    const currentJob = getApprovalEngine().get(jobId);
    if (currentJob && currentJob.state === 'completed') {
      transitioned = true;
      break;
    }
  }

  assert.strictEqual(transitioned, true, 'Job must transition to completed');
  assert.strictEqual(toolExecuted, true, 'Tool callback must have executed');

  // Test Replay Resistance: Re-triggering the same actionUri must NOT succeed
  console.log('[E2E-INFO] Testing Replay Defense (Single-Use Capability)...');
  let replayErr = null;
  try {
    // Run approval-activate directly with the already consumed URI
    execFileSync(process.execPath, [
      '$($mockInstallRoot.Replace('\', '/'))/dist/index.js',
      'approval-activate',
      actionUri
    ], { stdio: 'pipe' });
  } catch (err) {
    replayErr = err;
  }
  assert.ok(replayErr !== null, 'Replay of consumed activation token must fail');

  resetApprovalEngine();
  console.log('[E2E-PASS] End-to-End protocol activation and proof-of-possession fully verified.');
}

run().catch((err) => {
  console.error('[E2E-FAIL]', err);
  process.exit(1);
});
"@
    Set-Content -LiteralPath $e2eScript -Value $e2eCode -Encoding UTF8

    $nodeExe = (Get-Command node).Source
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = "`"$e2eScript`""
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdOutTask = $proc.StandardOutput.ReadToEndAsync()
    $stdErrTask = $proc.StandardError.ReadToEndAsync()

    $procExited = $proc.WaitForExit(15000)
    if (-not $procExited) {
        try { $proc.Kill() } catch {}
    }
    [void][System.Threading.Tasks.Task]::WaitAll(@($stdOutTask, $stdErrTask), 2000)
    $stdout = if ($stdOutTask.IsCompleted) { $stdOutTask.Result } else { "" }
    $stderr = if ($stdErrTask.IsCompleted) { $stdErrTask.Result } else { "" }

    Write-Host $stdout
    if ($stderr) { Write-Host $stderr -ForegroundColor DarkYellow }

    $step4Pass = ($proc.ExitCode -eq 0 -and $stdout.Contains("[E2E-PASS]"))
    Record-TestResult "P2-4-E2EActivationQualification" $step4Pass "Windows Shell protocol activation, proof-of-possession, and replay defense passed"

} finally {
    # Step 5: Uninstall / Prior-State Restoration
    Write-Host "`n--- Step 5: Verifying Clean Uninstall and State Restoration ---" -ForegroundColor Yellow
    try {
        $uninstRes = Uninstall-WinHelmApprovalIntegration -InstallRoot $mockInstallRoot
        $postRegExists = Test-Path -LiteralPath $protocolKey
        $postScExists = Test-Path -LiteralPath $shortcutPath
        $receiptExists = Test-Path -LiteralPath (Join-Path $mockInstallRoot ".winhelm-installer-receipt.json")

        $step5Pass = ($uninstRes.Status -eq "uninstalled" -and `
                      ($postRegExists -eq $preRegExists) -and `
                      ($postScExists -eq $preScExists) -and `
                      (-not $receiptExists))
        Record-TestResult "P2-5-UninstallRestoration" $step5Pass "Prior system state restored, no dangling handler or receipt remaining"
    } catch {
        Record-TestResult "P2-5-UninstallRestoration" $false $_.Exception.Message
    }

    # Cleanup temp base dir
    Remove-Item -LiteralPath $testBaseDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n=================================================================" -ForegroundColor Cyan
$p2Passed = ($results | Where-Object { $_.Passed }).Count
$p2Total = $results.Count
Write-Host "  PHASE 2 SUMMARY: $p2Passed / $p2Total PASSED" -ForegroundColor $(if ($p2Passed -eq $p2Total) { "Green" } else { "Red" })
Write-Host "=================================================================" -ForegroundColor Cyan

if ($p2Passed -ne $p2Total) {
    throw "Phase 2 Qualification FAILED: $($p2Total - $p2Passed) checks failed."
}
