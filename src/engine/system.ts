import { runPowerShell } from "./powershell-runner.js";
import type {
  EventLogItem,
  EventLogQueryOptions,
  GpuDetails,
  GpuInfoResult,
  KillResult,
  NetworkAdapterInfo,
  NetworkInfoResult,
  NotificationResult,
  PortCheckResult,
  ProcessItem,
  ProcessListOptions,
  ServiceControlResult,
  ServiceDetail,
  ServiceSummary,
  SystemInfo,
} from "../types/index.js";
import { ConfigManager } from "../config/config-manager.js";

/**
 * Read text from Windows Clipboard
 */
export async function getClipboard(): Promise<string> {
  const result = await runPowerShell("Get-Clipboard", { timeoutMs: 5000 });
  return result.stdout;
}

/**
 * Set text to Windows Clipboard safely using Base64 decoding
 */
export async function setClipboard(text: string): Promise<{ success: boolean }> {
  const base64 = Buffer.from(text, "utf-8").toString("base64");
  const psCmd = `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64}')) | Set-Clipboard`;
  await runPowerShell(psCmd, { timeoutMs: 5000 });
  return { success: true };
}

/**
 * Take desktop screenshot using .NET System.Drawing and return as base64 PNG string
 */
export async function captureScreen(): Promise<string> {
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bitmap.Size);
$ms = New-Object System.IO.MemoryStream;
$bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
$bytes = $ms.ToArray();
[Convert]::ToBase64String($bytes);
$graphics.Dispose();
$bitmap.Dispose();
$ms.Dispose();
`;
  const result = await runPowerShell(psScript, { timeoutMs: 15000 });
  if (result.stderr && !result.stdout) {
    throw new Error(`Screenshot failed: ${result.stderr}`);
  }
  return result.stdout.replace(/\s+/g, "");
}

/**
 * Open URL, file, or folder in Windows default application
 */
export async function openTarget(target: string): Promise<{ success: boolean; target: string }> {
  if (!target.startsWith("http://") && !target.startsWith("https://")) {
    const configManager = ConfigManager.getInstance();
    const pathCheck = configManager.isPathAllowed(target);
    if (!pathCheck.allowed) {
      throw new Error(pathCheck.reason);
    }
  }
  const result = await runPowerShell("Start-Process -FilePath $env:WH_ARG_TARGET", {
    timeoutMs: 5000,
    env: { WH_ARG_TARGET: target },
  });
  if (result.exitCode !== 0 && result.stderr) {
    throw new Error(`Failed to open target: ${result.stderr}`);
  }
  return { success: true, target };
}

/**
 * Get Windows system status (RAM, CPU, Drives)
 */
export async function getSystemInfo(): Promise<SystemInfo> {
  const psScript = `
$os = Get-CimInstance Win32_OperatingSystem;
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;
$drives = Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='FreeGB';E={[math]::Round($_.Free/1GB, 2)}}, @{N='UsedGB';E={[math]::Round($_.Used/1GB, 2)}}, @{N='TotalGB';E={[math]::Round(($_.Used + $_.Free)/1GB, 2)}};
@{
  ComputerName = $env:COMPUTERNAME;
  OS = $os.Caption;
  TotalRamGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2);
  FreeRamGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2);
  UsedRamGB = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2);
  CpuLoadPercentage = $cpu;
  Drives = $drives;
} | ConvertTo-Json -Depth 3;
`;
  const result = await runPowerShell(psScript, { timeoutMs: 10000 });
  try {
    const parsed = JSON.parse(result.stdout) as SystemInfo;
    const configManager = ConfigManager.getInstance();
    const config = configManager.getConfig();

    if (config.allowedDirectories && config.allowedDirectories.length > 0) {
      if (Array.isArray(parsed.Drives)) {
        parsed.Drives = parsed.Drives.filter((d: { Name?: string }) => {
          if (!d.Name) return false;
          return configManager.isPathAllowed(d.Name + ":\\").allowed;
        });
      }
      (parsed as any).AllowedDirectories = config.allowedDirectories;
      (parsed as any).SecurityPolicy =
        config.allowSystemExecution === false
          ? `Access strictly restricted to: ${config.allowedDirectories.join(", ")}`
          : `Workspace file mutations strictly isolated to: ${config.allowedDirectories.join(", ")} (PowerShell runtime execution permitted for Python/Node/Git/UV dev toolchains on C:)`;
    }
    return parsed;
  } catch {
    return { raw: result.stdout };
  }
}

/**
 * Check if a TCP port is in use and find owning PID
 */
export async function checkPort(port: number): Promise<PortCheckResult> {
  const psScript = `
$conn = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1;
if ($conn) {
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue;
  @{
    port = ${port};
    inUse = $true;
    pid = $conn.OwningProcess;
    processName = if ($proc) { $proc.ProcessName } else { "Unknown" };
    state = $conn.State.ToString();
  } | ConvertTo-Json;
} else {
  @{
    port = ${port};
    inUse = $false;
  } | ConvertTo-Json;
}
`;
  const result = await runPowerShell(psScript, { timeoutMs: 5000 });
  try {
    return JSON.parse(result.stdout) as PortCheckResult;
  } catch {
    return { port, inUse: false };
  }
}

/**
 * Kill process by PID or Name
 */
export async function killProcess(pid?: number, name?: string): Promise<KillResult> {
  const { ConfigManager } = await import("../config/config-manager.js");
  if (ConfigManager.getInstance().isReadOnly()) {
    throw new Error("Process termination is blocked: Server is operating in read-only mode.");
  }

  let cmd = "";
  let env: Record<string, string> | undefined;
  if (pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("Invalid pid");
    }
    cmd = `Stop-Process -Id ${pid} -Force -PassThru | Select-Object Id, ProcessName | ConvertTo-Json`;
  } else if (name) {
    cmd = "Stop-Process -Name $env:WH_ARG_NAME -Force -PassThru | Select-Object Id, ProcessName | ConvertTo-Json";
    env = { WH_ARG_NAME: name };
  } else {
    throw new Error("Must provide either pid or name");
  }

  const result = await runPowerShell(cmd, { timeoutMs: 5000, env });
  if (result.exitCode !== 0 && result.stderr) {
    throw new Error(`Failed to kill process: ${result.stderr}`);
  }
  return { success: true, details: result.stdout || "Process stopped" };
}

/**
 * Get GPU and CUDA statistics (NVIDIA nvidia-smi with WMI fallback)
 */
export async function getGpuInfo(): Promise<GpuInfoResult> {
  // 1. Try nvidia-smi first (standard for NVIDIA GPUs / CUDA)
  try {
    const nvidiaCmd = `nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu --format=csv,noheader,nounits`;
    const res = await runPowerShell(nvidiaCmd, { timeoutMs: 5000 });
    if (res.exitCode === 0 && res.stdout && res.stdout.trim()) {
      const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
      const gpus: GpuDetails[] = lines.map((line) => {
        const parts = line.split(",").map((p) => p.trim());
        return {
          index: parseInt(parts[0], 10) || 0,
          name: parts[1] || "NVIDIA GPU",
          driverVersion: parts[2] || undefined,
          memoryTotalMB: parseFloat(parts[3]) || undefined,
          memoryUsedMB: parseFloat(parts[4]) || undefined,
          memoryFreeMB: parseFloat(parts[5]) || undefined,
          temperatureC: parseFloat(parts[6]) || undefined,
          utilizationGpuPct: parseFloat(parts[7]) || undefined,
        };
      });
      return { hasNvidia: true, gpus };
    }
  } catch {
    // nvidia-smi not available or non-Nvidia
  }

  // 2. Fallback to Windows WMI (Win32_VideoController) for Intel / AMD / Integrated
  try {
    const wmiCmd = `Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, @{N='AdapterRAM_MB';E={[math]::Round($_.AdapterRAM/1MB, 2)}} | ConvertTo-Json -Depth 2`;
    const res = await runPowerShell(wmiCmd, { timeoutMs: 5000 });
    if (res.exitCode === 0 && res.stdout && res.stdout.trim()) {
      let parsed = JSON.parse(res.stdout);
      if (!Array.isArray(parsed)) parsed = [parsed];
      const gpus: GpuDetails[] = parsed.map((item: any, idx: number) => ({
        index: idx,
        name: item.Name || "Generic Video Controller",
        driverVersion: item.DriverVersion,
        memoryTotalMB: item.AdapterRAM_MB,
      }));
      return { hasNvidia: false, gpus };
    }
  } catch {
    // fallback error
  }

  return { hasNvidia: false, gpus: [] };
}

function mapServiceStatus(statusNumOrStr: any): string {
  if (typeof statusNumOrStr === "string") return statusNumOrStr;
  switch (statusNumOrStr) {
    case 1:
      return "Stopped";
    case 2:
      return "StartPending";
    case 3:
      return "StopPending";
    case 4:
      return "Running";
    case 5:
      return "ContinuePending";
    case 6:
      return "PausePending";
    case 7:
      return "Paused";
    default:
      return String(statusNumOrStr);
  }
}

function mapStartType(startTypeNumOrStr: any): string {
  if (typeof startTypeNumOrStr === "string") return startTypeNumOrStr;
  switch (startTypeNumOrStr) {
    case 0:
      return "Boot";
    case 1:
      return "System";
    case 2:
      return "Automatic";
    case 3:
      return "Manual";
    case 4:
      return "Disabled";
    default:
      return String(startTypeNumOrStr);
  }
}

/**
 * List Windows Services with optional substring filter
 */
export async function listServices(filter?: string): Promise<ServiceSummary[]> {
  let nameArg = "";
  let env: Record<string, string> | undefined;
  if (filter) {
    const trimmed = filter.trim();
    if (trimmed) {
      if (!/^[\w .\-*]+$/.test(trimmed)) {
        throw new Error(`Invalid service filter: '${filter}'. Service filter may only contain alphanumeric characters, spaces, dots, hyphens, and wildcards.`);
      }
      nameArg = "-Name $env:WH_ARG_FILTER";
      env = { WH_ARG_FILTER: `*${trimmed.replace(/\*/g, "")}*` };
    }
  }
  const psCmd = `Get-Service ${nameArg} | Select-Object -First 100 Name, DisplayName, Status, StartType | ConvertTo-Json -Depth 2`;
  const res = await runPowerShell(psCmd, { timeoutMs: 10000, env });
  if (!res.stdout || !res.stdout.trim()) {
    return [];
  }
  try {
    let parsed = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed.map((s: any) => ({
      name: s.Name || "",
      displayName: s.DisplayName || "",
      status: mapServiceStatus(s.Status),
      startType: mapStartType(s.StartType),
    }));
  } catch {
    return [];
  }
}

/**
 * Get detailed status of a specific Windows Service
 */
export async function getServiceStatus(serviceName: string): Promise<ServiceDetail> {
  const trimmed = serviceName.trim();
  if (!/^[\w .\-]+$/.test(trimmed)) {
    throw new Error(`Invalid service name: '${serviceName}'. Service names may only contain alphanumeric characters, spaces, dots, and hyphens.`);
  }
  const psCmd = "Get-Service -Name $env:WH_ARG_NAME | Select-Object Name, DisplayName, Status, StartType, CanStop, CanPauseAndContinue | ConvertTo-Json -Depth 2";
  const res = await runPowerShell(psCmd, { timeoutMs: 5000, env: { WH_ARG_NAME: trimmed } });
  if (!res.stdout || !res.stdout.trim()) {
    throw new Error(`Service '${serviceName}' not found`);
  }
  const s = JSON.parse(res.stdout);
  return {
    name: s.Name || trimmed,
    displayName: s.DisplayName || "",
    status: mapServiceStatus(s.Status),
    startType: mapStartType(s.StartType),
    canStop: !!s.CanStop,
    canPauseAndContinue: !!s.CanPauseAndContinue,
  };
}

/**
 * Control a Windows Service (start, stop, restart)
 */
export async function controlService(
  serviceName: string,
  action: "start" | "stop" | "restart"
): Promise<ServiceControlResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("Service modification is blocked: Server is running in read-only mode.");
  }

  const trimmed = serviceName.trim();
  if (!/^[\w .\-]+$/.test(trimmed)) {
    throw new Error(`Invalid service name: '${serviceName}'. Service names may only contain alphanumeric characters, spaces, dots, and hyphens.`);
  }
  let verb = "Start-Service";
  if (action === "stop") verb = "Stop-Service";
  if (action === "restart") verb = "Restart-Service";

  const psCmd = `${verb} -Name $env:WH_ARG_NAME -PassThru | Select-Object Name, Status | ConvertTo-Json`;
  const res = await runPowerShell(psCmd, { timeoutMs: 15000, env: { WH_ARG_NAME: trimmed } });
  if (res.exitCode !== 0 && res.stderr) {
    throw new Error(`Failed to ${action} service '${serviceName}': ${res.stderr}`);
  }

  let currentStatus = "Unknown";
  try {
    const parsed = JSON.parse(res.stdout);
    currentStatus = mapServiceStatus(parsed.Status);
  } catch {
    const statusQuery = await getServiceStatus(serviceName);
    currentStatus = statusQuery.status;
  }

  return {
    success: true,
    serviceName: trimmed,
    action,
    currentStatus,
  };
}

/**
 * List running Windows processes with sorting and optional filtering
 */
export async function listProcesses(options?: ProcessListOptions): Promise<ProcessItem[]> {
  const limit = Math.min(Math.max(1, options?.limit || 20), 100);
  const sortBy = options?.sortBy || "memory";
  const filter = options?.filter ? options.filter.replace(/['"]/g, "").trim() : "";

  let psCmd = `$procs = Get-Process;`;
  if (filter) {
    psCmd += `$procs = $procs | Where-Object { $_.ProcessName -like "*${filter}*" -or $_.Path -like "*${filter}*" };`;
  }
  if (sortBy === "cpu") {
    psCmd += `$procs = $procs | Sort-Object CPU -Descending;`;
  } else if (sortBy === "memory") {
    psCmd += `$procs = $procs | Sort-Object WorkingSet64 -Descending;`;
  } else if (sortBy === "name") {
    psCmd += `$procs = $procs | Sort-Object ProcessName;`;
  } else if (sortBy === "pid") {
    psCmd += `$procs = $procs | Sort-Object Id;`;
  }
  psCmd += `$procs = $procs | Select-Object -First ${limit};`;
  psCmd += `$procs | Select-Object Id, ProcessName, @{N='WorkingSetMB';E={[math]::Round($_.WorkingSet64/1MB, 2)}}, @{N='CPUSeconds';E={if($_.CPU){[math]::Round($_.CPU, 2)}else{0}}}, Path, Description | ConvertTo-Json -Depth 2;`;

  const res = await runPowerShell(psCmd, { timeoutMs: 10000 });
  if (!res.stdout || !res.stdout.trim()) {
    return [];
  }

  try {
    let parsed = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed.map((p: any) => ({
      pid: Number(p.Id || 0),
      name: String(p.ProcessName || ""),
      workingSetMB: Number(p.WorkingSetMB || 0),
      cpuSeconds: Number(p.CPUSeconds || 0),
      path: p.Path || undefined,
      description: p.Description || undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Query Windows Event Log for errors, warnings, or crashes
 */
export async function queryEventLog(options?: EventLogQueryOptions): Promise<EventLogItem[]> {
  const logName = (options?.logName || "Application").replace(/['"]/g, "").trim();
  const limit = Math.min(Math.max(1, options?.limit || 20), 100);
  const hours = Math.min(Math.max(1, options?.hours || 24), 720);
  const level = options?.level || "Error";
  const source = options?.source ? options.source.replace(/['"]/g, "").trim() : "";

  const psCmd = `
try {
  $filter = @{
    LogName = '${logName}';
    StartTime = (Get-Date).AddHours(-${hours});
  };
  ${level === "Critical" ? "$filter['Level'] = 1;" : ""}
  ${level === "Error" ? "$filter['Level'] = 2;" : ""}
  ${level === "Warning" ? "$filter['Level'] = 3;" : ""}
  ${level === "Information" ? "$filter['Level'] = 4;" : ""}
  ${source ? `$filter['ProviderName'] = '${source}';` : ""}
  $events = Get-WinEvent -FilterHashtable $filter -MaxEvents ${limit} -ErrorAction Stop |
    Select-Object @{N='TimeCreated';E={$_.TimeCreated.ToString('o')}}, Id, LevelDisplayName, ProviderName, @{N='Message';E={($_.Message -replace '\\r|\\n', ' ') -replace '\\s+', ' '}};
  $events | ConvertTo-Json -Depth 2
} catch {
  Write-Output "[]"
}
`;

  const res = await runPowerShell(psCmd, { timeoutMs: 15000 });
  if (!res.stdout || !res.stdout.trim() || res.stdout.trim() === "[]") {
    return [];
  }

  try {
    let parsed = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed.map((e: any) => ({
      timeCreated: String(e.TimeCreated || ""),
      id: Number(e.Id || 0),
      level: String(e.LevelDisplayName || level),
      providerName: String(e.ProviderName || ""),
      message: String(e.Message || "").slice(0, 1000),
    }));
  } catch {
    return [];
  }
}

/**
 * Inspect network adapters, local IP, gateway, DNS, and Tailscale connection
 */
export async function getNetworkInfo(includeListeningPorts = false): Promise<NetworkInfoResult> {
  const os = await import("node:os");
  const hostname = os.hostname();
  const rawInterfaces = os.networkInterfaces();

  const adapters: NetworkAdapterInfo[] = [];
  let tailscaleIp: string | undefined;

  for (const [name, addrs] of Object.entries(rawInterfaces)) {
    if (!addrs || addrs.length === 0) continue;
    const ipv4List: string[] = [];
    const ipv6List: string[] = [];
    let mac = "";
    let isInternal = false;

    for (const addr of addrs) {
      if (addr.family === "IPv4") {
        ipv4List.push(addr.address);
        if (addr.address.startsWith("100.") || name.toLowerCase().includes("tailscale")) {
          tailscaleIp = addr.address;
        }
      } else if (addr.family === "IPv6") {
        ipv6List.push(addr.address);
      }
      if (addr.mac && addr.mac !== "00:00:00:00:00:00") {
        mac = addr.mac;
      }
      if (addr.internal) {
        isInternal = true;
      }
    }

    adapters.push({
      name,
      ipv4: ipv4List.length > 0 ? ipv4List : undefined,
      ipv6: ipv6List.length > 0 ? ipv6List : undefined,
      mac: mac || undefined,
      isInternal,
    });
  }

  let defaultGateway: string | undefined;
  let dnsServers: string[] | undefined;

  try {
    const psCmd = `Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1 @{N='Gateway';E={$_.IPv4DefaultGateway.NextHop}}, @{N='DNS';E={$_.DNSServer.ServerAddresses}} | ConvertTo-Json`;
    const res = await runPowerShell(psCmd, { timeoutMs: 5000 });
    if (res.stdout && res.stdout.trim()) {
      const parsed = JSON.parse(res.stdout);
      if (parsed.Gateway) defaultGateway = String(parsed.Gateway);
      if (parsed.DNS) {
        dnsServers = Array.isArray(parsed.DNS) ? parsed.DNS.map(String) : [String(parsed.DNS)];
      }
    }
  } catch {
    // Non-fatal
  }

  if (!tailscaleIp) {
    try {
      const tailscaleRes = await runPowerShell("tailscale ip -4", { timeoutMs: 3000 });
      if (tailscaleRes.stdout && tailscaleRes.stdout.trim().startsWith("100.")) {
        tailscaleIp = tailscaleRes.stdout.trim();
      }
    } catch {
      // Tailscale not installed, ignore
    }
  }

  let listeningPorts: { port: number; processName?: string; pid?: number }[] | undefined;
  if (includeListeningPorts) {
    try {
      const psPorts = `Get-NetTCPConnection -State Listen | Select-Object LocalPort, OwningProcess -Unique | Select-Object -First 30 | ForEach-Object { $p = $_; $name = (Get-Process -Id $p.OwningProcess -ErrorAction SilentlyContinue).ProcessName; [PSCustomObject]@{ Port = $p.LocalPort; Pid = $p.OwningProcess; ProcessName = $name } } | ConvertTo-Json`;
      const portRes = await runPowerShell(psPorts, { timeoutMs: 6000 });
      if (portRes.stdout && portRes.stdout.trim()) {
        let parsed = JSON.parse(portRes.stdout);
        if (!Array.isArray(parsed)) parsed = [parsed];
        listeningPorts = parsed.map((item: any) => ({
          port: Number(item.Port),
          pid: Number(item.Pid || 0),
          processName: item.ProcessName || undefined,
        }));
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    hostname,
    adapters,
    defaultGateway,
    dnsServers,
    tailscaleIp,
    listeningPorts,
  };
}

/**
 * Send native Windows Toast Notification
 */
export async function sendNotification(
  title: string,
  message: string,
  sound = true
): Promise<NotificationResult> {
  const safeTitle = title.trim().slice(0, 100);
  const safeMsg = message.trim().slice(0, 500);
  const soundTag = sound
    ? "<audio src='ms-winsoundevent:Notification.Default' />"
    : "<audio silent='true' />";

  const psScript = `
$title = $env:WH_ARG_TITLE;
$msg = $env:WH_ARG_MSG;
$safeXmlTitle = [System.Security.SecurityElement]::Escape($title);
$safeXmlMsg = [System.Security.SecurityElement]::Escape($msg);
$toastXml = "<toast><visual><binding template='ToastGeneric'><text>$safeXmlTitle</text><text>$safeXmlMsg</text></binding></visual>${soundTag}</toast>";

try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xmlDoc.LoadXml($toastXml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xmlDoc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("WinHelm").Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  $balloon = New-Object System.Windows.Forms.NotifyIcon
  $balloon.Icon = [System.Drawing.SystemIcons]::Information
  $balloon.BalloonTipTitle = $title
  $balloon.BalloonTipText = $msg
  $balloon.Visible = $true
  $balloon.ShowBalloonTip(4000)
}
`;

  await runPowerShell(psScript, {
    timeoutMs: 6000,
    env: { WH_ARG_TITLE: safeTitle, WH_ARG_MSG: safeMsg },
  });

  return {
    success: true,
    title: safeTitle,
    message: safeMsg,
    timestamp: new Date().toISOString(),
  };
}

