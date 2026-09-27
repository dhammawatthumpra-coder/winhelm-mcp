export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface FileReadResult {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  filePath: string;
}

export interface FileWriteResult {
  success: boolean;
  filePath: string;
  bytesWritten: number;
}

export interface FileEditResult {
  success: boolean;
  filePath: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface DriveInfo {
  Name: string;
  FreeGB: number;
  UsedGB: number;
  TotalGB: number;
}

export interface SystemInfo {
  ComputerName?: string;
  OS?: string;
  TotalRamGB?: number;
  FreeRamGB?: number;
  UsedRamGB?: number;
  CpuLoadPercentage?: number;
  Drives?: DriveInfo[];
  raw?: string;
}

export interface PortCheckResult {
  port: number;
  inUse: boolean;
  pid?: number;
  processName?: string;
  state?: string;
}

export interface KillResult {
  success: boolean;
  details: string;
}

export type { ToolProfile } from "../config/profiles.js";

export interface ServerConfig {
  blockedCommands: string[];
  allowedDirectories: string[];
  allowSystemExecution?: boolean;
  fileReadLineLimit: number;
  defaultTimeoutMs: number;
  telemetryEnabled: boolean;
  authToken?: string | null;
  readOnly?: boolean;
  rateLimitPerMinute?: number;
  profile?: import("../config/profiles.js").ToolProfile;
  customTools?: string[];
}

// Group 1: File Safety & Archives
export interface FileDeleteResult {
  success: boolean;
  path: string;
  movedToRecycleBin: boolean;
}

export interface FileMoveResult {
  success: boolean;
  from: string;
  to: string;
}

export interface FileCopyResult {
  success: boolean;
  from: string;
  to: string;
}

export interface ArchiveResult {
  success: boolean;
  zipPath: string;
  targetPath: string;
  action: "create" | "extract";
}

// Group 2: GPU & Machine Learning
export interface GpuDetails {
  index: number;
  name: string;
  driverVersion?: string;
  memoryTotalMB?: number;
  memoryUsedMB?: number;
  memoryFreeMB?: number;
  temperatureC?: number;
  utilizationGpuPct?: number;
}

export interface GpuInfoResult {
  hasNvidia: boolean;
  gpus: GpuDetails[];
  raw?: string;
}

// Group 3: Web & Dev Server Verification
export interface HttpPingResult {
  ok: boolean;
  status: number;
  statusText: string;
  latencyMs: number;
  url: string;
}

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpRequestResult {
  status: number;
  statusText: string;
  durationMs: number;
  headers: Record<string, string>;
  body: string;
  isJson: boolean;
  json?: any;
}

// Group 4: Windows Services Manager
export interface ServiceSummary {
  name: string;
  displayName: string;
  status: string;
  startType: string;
}

export interface ServiceDetail extends ServiceSummary {
  canStop?: boolean;
  canPauseAndContinue?: boolean;
}

export interface ServiceControlResult {
  success: boolean;
  serviceName: string;
  action: string;
  currentStatus: string;
}

// Group 5: Advanced Search, PDF & Preview
export interface RipgrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface RipgrepSearchResult {
  query: string;
  engine: "ripgrep" | "fallback";
  totalMatches: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  matches: RipgrepMatch[];
}

export interface PdfGenerateOptions {
  sourcePath: string;
  pdfPath: string;
  landscape?: boolean;
  title?: string;
}

export interface PdfGenerateResult {
  success: boolean;
  pdfPath: string;
  sourcePath: string;
  sizeBytes: number;
  browserUsed: string;
}

export interface FilePreviewResult {
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  lineCount?: number;
  previewUrl: string;
  snippet?: string;
  isBinary: boolean;
}

// Group 6: Workstation & Inspection Tools (6 Golden Tools)
export interface ProcessItem {
  pid: number;
  name: string;
  workingSetMB: number;
  cpuSeconds: number;
  path?: string;
  description?: string;
}

export interface ProcessListOptions {
  limit?: number;
  sortBy?: "cpu" | "memory" | "name" | "pid";
  filter?: string;
}

export interface FileTailResult {
  filePath: string;
  totalLines: number;
  linesReturned: number;
  content: string;
}

export interface FileHashResult {
  filePath: string;
  algorithm: "sha256" | "md5" | "sha1";
  hash: string;
  sizeBytes: number;
  sizeFormatted: string;
}

export interface EventLogItem {
  timeCreated: string;
  id: number;
  level: string;
  providerName: string;
  message: string;
}

export interface EventLogQueryOptions {
  logName?: string;
  level?: "Critical" | "Error" | "Warning" | "Information" | "All";
  limit?: number;
  source?: string;
  hours?: number;
}

export interface NetworkAdapterInfo {
  name: string;
  ipv4?: string[];
  ipv6?: string[];
  mac?: string;
  isInternal: boolean;
}

export interface NetworkInfoResult {
  hostname: string;
  adapters: NetworkAdapterInfo[];
  defaultGateway?: string;
  dnsServers?: string[];
  tailscaleIp?: string;
  listeningPorts?: { port: number; processName?: string; pid?: number }[];
}

export interface NotificationResult {
  success: boolean;
  title: string;
  message: string;
  timestamp: string;
}



