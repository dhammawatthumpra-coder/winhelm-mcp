[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $ServiceName = 'WinHelmGoTlsIngressHardeningR1',
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
$expectedServiceName = 'WinHelmGoTlsIngressHardeningR1'
if ($ServiceName -ne $expectedServiceName) {
    throw "service name must remain $expectedServiceName"
}

# Mechanism note: sc.exe failure accepts only run|restart|reboot action tokens and cannot
# materialize the required explicit terminal SC_ACTION_NONE; the SCM repeats the last
# configured action when failures exceed the configured array, so a two-element restart
# array would restart without bound. The exact bounded array
# [(RESTART,30000),(RESTART,300000),(NONE,0)] plus the non-crash failure flag is therefore
# materialized through ChangeServiceConfig2 (SERVICE_CONFIG_FAILURE_ACTIONS and
# SERVICE_CONFIG_FAILURE_ACTIONS_FLAG) and verified read-only afterwards. The service is
# never started by this script.
$recoveryNativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class WinHelmR6Recovery
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SC_ACTION { public uint Type; public uint Delay; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SERVICE_FAILURE_ACTIONS
    {
        public uint dwResetPeriod;
        public string lpRebootMsg;
        public string lpCommand;
        public uint cActions;
        public IntPtr lpsaActions;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SERVICE_FAILURE_ACTIONS_FLAG { public int fFailureActionsOnNonCrashFailures; }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenSCManager(string machineName, string databaseName, uint access);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenService(IntPtr manager, string serviceName, uint access);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ChangeServiceConfig2(IntPtr service, uint infoLevel, IntPtr info);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CloseServiceHandle(IntPtr handle);

    private const uint SC_MANAGER_CONNECT = 0x0001;
    private const uint SERVICE_QUERY_CONFIG = 0x0001;
    private const uint SERVICE_CHANGE_CONFIG = 0x0002;
    private const uint SERVICE_START = 0x0010;
    private const uint SERVICE_CONFIG_FAILURE_ACTIONS = 2;
    private const uint SERVICE_CONFIG_FAILURE_ACTIONS_FLAG = 4;
    private const uint SC_ACTION_NONE = 0;
    private const uint SC_ACTION_RESTART = 1;

    public static int ConfigureFailureActions(string serviceName, uint resetSeconds, uint firstDelayMs, uint secondDelayMs)
    {
        IntPtr manager = IntPtr.Zero;
        IntPtr service = IntPtr.Zero;
        IntPtr payload = IntPtr.Zero;
        GCHandle actionsPin = default(GCHandle);
        try
        {
            manager = OpenSCManager(null, null, SC_MANAGER_CONNECT);
            if (manager == IntPtr.Zero) { return Marshal.GetLastWin32Error(); }
            service = OpenService(manager, serviceName, SERVICE_CHANGE_CONFIG | SERVICE_QUERY_CONFIG | SERVICE_START);
            if (service == IntPtr.Zero) { return Marshal.GetLastWin32Error(); }

            SC_ACTION[] actions = new SC_ACTION[3];
            actions[0].Type = SC_ACTION_RESTART;
            actions[0].Delay = firstDelayMs;
            actions[1].Type = SC_ACTION_RESTART;
            actions[1].Delay = secondDelayMs;
            actions[2].Type = SC_ACTION_NONE;
            actions[2].Delay = 0;

            SERVICE_FAILURE_ACTIONS failureActions = new SERVICE_FAILURE_ACTIONS();
            failureActions.dwResetPeriod = resetSeconds;
            failureActions.lpRebootMsg = "";
            failureActions.lpCommand = "";
            failureActions.cActions = (uint) actions.Length;
            actionsPin = GCHandle.Alloc(actions, GCHandleType.Pinned);
            failureActions.lpsaActions = actionsPin.AddrOfPinnedObject();
            payload = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SERVICE_FAILURE_ACTIONS)));
            Marshal.StructureToPtr(failureActions, payload, false);

            if (!ChangeServiceConfig2(service, SERVICE_CONFIG_FAILURE_ACTIONS, payload))
            {
                return Marshal.GetLastWin32Error();
            }
            return 0;
        }
        finally
        {
            if (payload != IntPtr.Zero)
            {
                try { Marshal.DestroyStructure(payload, typeof(SERVICE_FAILURE_ACTIONS)); } catch { }
                Marshal.FreeHGlobal(payload);
            }
            if (actionsPin.IsAllocated) { actionsPin.Free(); }
            if (service != IntPtr.Zero) { CloseServiceHandle(service); }
            if (manager != IntPtr.Zero) { CloseServiceHandle(manager); }
        }
    }

    public static int ConfigureFailureActionsFlag(string serviceName)
    {
        IntPtr manager = IntPtr.Zero;
        IntPtr service = IntPtr.Zero;
        IntPtr payload = IntPtr.Zero;
        try
        {
            manager = OpenSCManager(null, null, SC_MANAGER_CONNECT);
            if (manager == IntPtr.Zero) { return Marshal.GetLastWin32Error(); }
            service = OpenService(manager, serviceName, SERVICE_CHANGE_CONFIG | SERVICE_QUERY_CONFIG);
            if (service == IntPtr.Zero) { return Marshal.GetLastWin32Error(); }

            SERVICE_FAILURE_ACTIONS_FLAG flag = new SERVICE_FAILURE_ACTIONS_FLAG();
            flag.fFailureActionsOnNonCrashFailures = 1;
            payload = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SERVICE_FAILURE_ACTIONS_FLAG)));
            Marshal.StructureToPtr(flag, payload, false);

            if (!ChangeServiceConfig2(service, SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, payload))
            {
                return Marshal.GetLastWin32Error();
            }
            return 0;
        }
        finally
        {
            if (payload != IntPtr.Zero) { Marshal.FreeHGlobal(payload); }
            if (service != IntPtr.Zero) { CloseServiceHandle(service); }
            if (manager != IntPtr.Zero) { CloseServiceHandle(manager); }
        }
    }
}
'@

if (-not $Apply) {
    Write-Output "DRY_RUN service=$ServiceName mechanism=ChangeServiceConfig2"
    Write-Output 'PLAN reset=86400'
    Write-Output 'PLAN actions=restart/30000,restart/300000,none/0'
    Write-Output 'PLAN failureflag=true'
    Write-Output 'PLAN bounded_automatic_restarts=2 terminal_action=none reboot_action=false recovery_command=false'
    Write-Output 'PLAN service_started=false mutation_performed=false'
    Write-Output 'PLAN note=sc.exe failure accepts only run|restart|reboot and cannot materialize the terminal none action; the SCM repeats the last configured action beyond the configured array, so the exact bounded array is materialized via ChangeServiceConfig2 in the -Apply admin lane only.'
    Write-Output 'The service remains STOPPED; this dry-run made no SCM mutation. Re-run with -Apply only after Owner/admin approval.'
    exit 0
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) {
    throw "service does not exist: $ServiceName"
}
if ($service.Status -ne 'Stopped') {
    throw "service must remain stopped before recovery configuration: status=$($service.Status)"
}

if (-not $PSCmdlet.ShouldProcess($ServiceName, 'configure bounded SCM recovery policy')) {
    Write-Output 'WHATIF recovery policy not configured; no SCM mutation performed.'
    exit 0
}

if (-not ('WinHelmR6Recovery' -as [type])) {
    Add-Type -TypeDefinition $recoveryNativeSource -Language CSharp -ErrorAction Stop
}

$actionsResult = [WinHelmR6Recovery]::ConfigureFailureActions($ServiceName, [uint32] 86400, [uint32] 30000, [uint32] 300000)
if ($actionsResult -ne 0) {
    throw "failure-action configuration failed: win32=$actionsResult"
}

$flagResult = [WinHelmR6Recovery]::ConfigureFailureActionsFlag($ServiceName)
if ($flagResult -ne 0) {
    throw "failure-flag configuration failed: win32=$flagResult"
}

$verifier = Join-Path $PSScriptRoot 'verify-recovery.ps1'
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifier -ServiceName $ServiceName
if ($LASTEXITCODE -ne 0) {
    throw "recovery policy verification failed after configuration: exit=$LASTEXITCODE"
}
Write-Output "RECOVERY_CONFIGURED service=$ServiceName reset=86400 actions=restart/30000,restart/300000,none/0 failureflag=true service_started=false"
exit 0
