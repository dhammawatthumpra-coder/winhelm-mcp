# WinHelm - Windows Service & Background Daemon Manager
param (
    [Parameter(Mandatory=$true)]
    [ValidateSet("install", "uninstall", "start", "stop", "status", "restart")]
    [string]$Action,
    [int]$Port = 8788,
    [string]$Auth = "",
    [string]$AllowedDirs = ""
)

$TaskName = "WinHelm-MCP-Service"
$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$DistIndex = Join-Path $ProjectDir "dist\index.js"

if (-not $NodeExe) {
    Write-Error "Node.js executable was not found on PATH."
    exit 1
}

function Check-Admin {
    $currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

switch ($Action) {
    "install" {
        Write-Host "Installing WinHelm as an Always-On Windows Background Service..." -ForegroundColor Cyan

        # Make sure build exists
        if (-not (Test-Path $DistIndex)) {
            Write-Host "Building project first..." -ForegroundColor Yellow
            Push-Location $ProjectDir
            npm run build
            Pop-Location
        }

        $argList = "`"$DistIndex`" --port $Port"
        if ($Auth) { $argList += " --auth `"$Auth`"" }
        if ($AllowedDirs) { $argList += " --allowed-dirs `"$AllowedDirs`"" }

        # Create Task Action
        $TaskAction = New-ScheduledTaskAction -Execute $NodeExe -Argument $argList -WorkingDirectory $ProjectDir

        # Create Trigger: At Windows Startup
        $TaskTrigger = New-ScheduledTaskTrigger -AtStartup

        # Settings: Restart on failure, no execution time limit
        $TaskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0

        # Unregister existing if present
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

        # Register Scheduled Task with SYSTEM or Current User
        if (Check-Admin) {
            $TaskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
            Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $TaskTrigger -Settings $TaskSettings -Principal $TaskPrincipal | Out-Null
            Write-Host "[OK] Successfully installed as SYSTEM Background Service!" -ForegroundColor Green
        } else {
            $TaskPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
            Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $TaskTrigger -Settings $TaskSettings -Principal $TaskPrincipal | Out-Null
            Write-Host "[OK] Successfully installed for user '$env:USERNAME' (Run as Admin for SYSTEM-wide daemon)!" -ForegroundColor Green
        }

        # Start task immediately
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "[OK] Service started! Access Web Monitor at http://localhost:$Port/" -ForegroundColor Green
    }

    "uninstall" {
        Write-Host "Stopping and uninstalling WinHelm Service..." -ForegroundColor Yellow
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "[OK] WinHelm Service successfully uninstalled." -ForegroundColor Green
    }

    "start" {
        Write-Host "Starting WinHelm Service..." -ForegroundColor Cyan
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "[OK] Service started." -ForegroundColor Green
    }

    "stop" {
        Write-Host "Stopping WinHelm Service..." -ForegroundColor Yellow
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Host "[OK] Service stopped." -ForegroundColor Green
    }

    "restart" {
        Write-Host "Restarting WinHelm Service..." -ForegroundColor Cyan
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "[OK] Service restarted." -ForegroundColor Green
    }

    "status" {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName
            Write-Host "=== WinHelm Windows Service Status ===" -ForegroundColor Cyan
            Write-Host "Name:         $($task.TaskName)"
            Write-Host "State:        $($task.State)" -ForegroundColor $(if ($task.State -eq 'Running') { 'Green' } else { 'Yellow' })
            Write-Host "Last Run:     $($info.LastRunTime)"
            Write-Host "Last Result:  $($info.LastTaskResult)"
            Write-Host "Next Run:     $($info.NextRunTime)"
        } else {
            Write-Host "WinHelm Service is NOT installed." -ForegroundColor Red
            Write-Host "Run: .\scripts\manage-service.ps1 -Action install" -ForegroundColor Gray
        }
    }
}
