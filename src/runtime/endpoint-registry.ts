import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteUtf8 } from "../config/atomic-write.js";
import { isLoopbackHost } from "../utils/network-gate.js";

const PROCESS_CREATION_TOLERANCE_MS = 2_000;
const execFileAsync = promisify(execFile);

export interface RuntimeEndpointRecord {
  schemaVersion: 1;
  role: string;
  generation: string;
  state: "ready";
  host: string;
  port: number;
  pid: number;
  processCreatedAt: string;
  executablePath: string;
  entrypointPath: string;
  publishedAt: string;
}

export interface RuntimeListenerObservation {
  localAddress: string;
  port: number;
  owningPid: number;
}

export interface RuntimeEndpointTarget {
  pid: number;
  host: string;
  port: number;
}

export interface RuntimeEndpointObservation {
  processExists: boolean;
  processCreatedAt?: string;
  executablePath?: string;
  commandLine?: string;
  listeners: RuntimeListenerObservation[];
}

export interface RuntimeEndpointHealthIdentity {
  status?: unknown;
  server?: unknown;
  runtime?: {
    role?: unknown;
    generation?: unknown;
    pid?: unknown;
  };
}

export interface VerifiedRuntimeEndpoint {
  role: string;
  generation: string;
  host: string;
  port: number;
  pid: number;
}

export interface VerifyRuntimeEndpointOptions {
  expectedRole: string;
  expectedExecutablePath: string;
  expectedEntrypointPath: string;
  expectedHealthServer?: string;
  observe: (target: RuntimeEndpointTarget) => Promise<RuntimeEndpointObservation>;
  probeHealth: (record: RuntimeEndpointRecord) => Promise<unknown>;
}

export function createRuntimeGeneration(): string {
  return randomUUID();
}

export function defaultRuntimeEndpointPath(role: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(role)) {
    throw new Error(`Invalid runtime endpoint role: ${role}`);
  }
  return path.join(os.homedir(), ".winhelm", "runtime", "endpoints", `${role}.json`);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isValidGeneration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isValidPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeHost(value: string): string {
  const h = value.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h;
}

function normalizeWindowsPath(value: string): string {
  return path.win32.normalize(value).replace(/\//g, "\\").toLowerCase();
}

function pathsEqual(a: string, b: string): boolean {
  return normalizeWindowsPath(a) === normalizeWindowsPath(b);
}

function creationTimesMatch(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= PROCESS_CREATION_TOLERANCE_MS;
}

function commandLineContainsEntrypoint(commandLine: string, entrypointPath: string): boolean {
  const normalizedCommandLine = commandLine.replace(/\//g, "\\").toLowerCase();
  const normalizedEntrypoint = normalizeWindowsPath(entrypointPath);
  if (normalizedCommandLine.includes(normalizedEntrypoint)) return true;

  const parts = normalizedEntrypoint.split("\\").filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.length < 3) return false;
  const relativeTail = parts.slice(-3).join("\\");
  return normalizedCommandLine.includes(relativeTail);
}

export function parseRuntimeEndpointRecord(value: unknown): RuntimeEndpointRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;

  if (
    input.schemaVersion !== 1 ||
    typeof input.role !== "string" ||
    !/^[a-z0-9][a-z0-9_-]*$/i.test(input.role) ||
    !isValidGeneration(input.generation) ||
    input.state !== "ready" ||
    typeof input.host !== "string" ||
    !isLoopbackHost(normalizeHost(input.host)) ||
    !isValidPort(input.port) ||
    !isValidPid(input.pid) ||
    !isValidTimestamp(input.processCreatedAt) ||
    typeof input.executablePath !== "string" ||
    input.executablePath.length === 0 ||
    typeof input.entrypointPath !== "string" ||
    input.entrypointPath.length === 0 ||
    !isValidTimestamp(input.publishedAt)
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    role: input.role,
    generation: input.generation,
    state: "ready",
    host: normalizeHost(input.host),
    port: input.port,
    pid: input.pid,
    processCreatedAt: input.processCreatedAt,
    executablePath: input.executablePath,
    entrypointPath: input.entrypointPath,
    publishedAt: input.publishedAt,
  };
}

export function readRuntimeEndpointHint(
  filePath: string = defaultRuntimeEndpointPath("core")
): RuntimeEndpointRecord | undefined {
  try {
    return parseRuntimeEndpointRecord(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

export async function publishRuntimeEndpointRecord(
  record: RuntimeEndpointRecord,
  filePath: string = defaultRuntimeEndpointPath(record.role)
): Promise<void> {
  const parsed = parseRuntimeEndpointRecord(record);
  if (!parsed) {
    throw new Error("Refusing to publish an invalid runtime endpoint record.");
  }
  await atomicWriteUtf8(filePath, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
}

export async function verifyRuntimeEndpointRecord(
  record: RuntimeEndpointRecord,
  options: VerifyRuntimeEndpointOptions
): Promise<VerifiedRuntimeEndpoint | undefined> {
  const parsed = parseRuntimeEndpointRecord(record);
  if (!parsed) return undefined;

  if (parsed.role !== options.expectedRole) return undefined;
  if (!pathsEqual(parsed.executablePath, options.expectedExecutablePath)) return undefined;
  if (!pathsEqual(parsed.entrypointPath, options.expectedEntrypointPath)) return undefined;

  let observed: RuntimeEndpointObservation;
  try {
    observed = await options.observe({ pid: parsed.pid, host: parsed.host, port: parsed.port });
  } catch {
    return undefined;
  }

  if (!observed.processExists) return undefined;
  if (!observed.processCreatedAt || !creationTimesMatch(observed.processCreatedAt, parsed.processCreatedAt)) {
    return undefined;
  }
  if (!observed.executablePath || !pathsEqual(observed.executablePath, parsed.executablePath)) {
    return undefined;
  }
  if (!observed.commandLine || !commandLineContainsEntrypoint(observed.commandLine, options.expectedEntrypointPath)) {
    return undefined;
  }

  const expectedHost = normalizeHost(parsed.host);
  const listenerOwned = observed.listeners.some(
    (listener) =>
      normalizeHost(listener.localAddress) === expectedHost &&
      listener.port === parsed.port &&
      listener.owningPid === parsed.pid
  );
  if (!listenerOwned) return undefined;

  let health: RuntimeEndpointHealthIdentity;
  try {
    const raw = await options.probeHealth(parsed);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    health = raw as RuntimeEndpointHealthIdentity;
  } catch {
    return undefined;
  }

  if (
    health.status !== "ok" ||
    health.server !== (options.expectedHealthServer ?? "winhelm-mcp") ||
    !health.runtime ||
    health.runtime.role !== parsed.role ||
    health.runtime.generation !== parsed.generation ||
    health.runtime.pid !== parsed.pid
  ) {
    return undefined;
  }

  return {
    role: parsed.role,
    generation: parsed.generation,
    host: parsed.host,
    port: parsed.port,
    pid: parsed.pid,
  };
}

function formatHealthHost(host: string): string {
  const normalized = normalizeHost(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

export async function observeWindowsRuntimeEndpoint(
  target: RuntimeEndpointTarget
): Promise<RuntimeEndpointObservation> {
  if (!isValidPid(target.pid) || !isValidPort(target.port) || !isLoopbackHost(normalizeHost(target.host))) {
    throw new Error("Invalid runtime endpoint observation target.");
  }

  const script = [
    "$ErrorActionPreference='Stop'",
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${target.pid}' -ErrorAction Stop | Select-Object -First 1`,
    `$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ${target.port} -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ localAddress = [string]$_.LocalAddress; port = [int]$_.LocalPort; owningPid = [int]$_.OwningProcess } })`,
    "[PSCustomObject]@{ processExists = [bool]$p; processCreatedAt = if ($p) { $p.CreationDate.ToString('o') } else { $null }; executablePath = if ($p) { [string]$p.ExecutablePath } else { $null }; commandLine = if ($p) { [string]$p.CommandLine } else { $null }; listeners = @($listeners) } | ConvertTo-Json -Depth 5 -Compress",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
    }
  );

  const raw = JSON.parse(String(stdout).trim()) as Record<string, unknown>;
  const rawListeners = raw.listeners === undefined
    ? []
    : Array.isArray(raw.listeners)
      ? raw.listeners
      : [raw.listeners];
  const listeners: RuntimeListenerObservation[] = rawListeners
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      localAddress: String(item.localAddress ?? ""),
      port: Number(item.port),
      owningPid: Number(item.owningPid),
    }))
    .filter(
      (item) =>
        item.localAddress.length > 0 &&
        isValidPort(item.port) &&
        isValidPid(item.owningPid)
    );

  return {
    processExists: raw.processExists === true,
    processCreatedAt:
      typeof raw.processCreatedAt === "string" && raw.processCreatedAt
        ? raw.processCreatedAt
        : undefined,
    executablePath:
      typeof raw.executablePath === "string" && raw.executablePath
        ? raw.executablePath
        : undefined,
    commandLine:
      typeof raw.commandLine === "string" && raw.commandLine
        ? raw.commandLine
        : undefined,
    listeners,
  };
}

export async function probeRuntimeEndpointHealth(
  record: RuntimeEndpointRecord
): Promise<RuntimeEndpointHealthIdentity> {
  const parsed = parseRuntimeEndpointRecord(record);
  if (!parsed) throw new Error("Invalid runtime endpoint health target.");

  const response = await fetch(
    `http://${formatHealthHost(parsed.host)}:${parsed.port}/health`,
    {
      method: "GET",
      headers: {
        "x-winhelm-runtime-generation": parsed.generation,
      },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    }
  );
  if (!response.ok) {
    throw new Error(`Runtime endpoint health probe failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as RuntimeEndpointHealthIdentity;
}

export interface PublishCurrentRuntimeEndpointOptions {
  role: string;
  generation: string;
  host: string;
  port: number;
  expectedExecutablePath: string;
  expectedEntrypointPath: string;
  expectedHealthServer?: string;
  filePath?: string;
  observe?: (target: RuntimeEndpointTarget) => Promise<RuntimeEndpointObservation>;
  probeHealth?: (record: RuntimeEndpointRecord) => Promise<unknown>;
}

const PUBLICATION_PROOF_ATTEMPTS = 4;
const PUBLICATION_PROOF_RETRY_MS = 100;

type ProvenRuntimeEndpointObservation = RuntimeEndpointObservation &
  Required<
    Pick<
      RuntimeEndpointObservation,
      "processCreatedAt" | "executablePath" | "commandLine"
    >
  >;

function observationProvesCurrentEndpoint(
  observation: RuntimeEndpointObservation,
  target: RuntimeEndpointTarget,
  expectedExecutablePath: string,
  expectedEntrypointPath: string
): observation is ProvenRuntimeEndpointObservation {
  return (
    observation.processExists &&
    !!observation.processCreatedAt &&
    isValidTimestamp(observation.processCreatedAt) &&
    !!observation.executablePath &&
    pathsEqual(observation.executablePath, expectedExecutablePath) &&
    !!observation.commandLine &&
    commandLineContainsEntrypoint(observation.commandLine, expectedEntrypointPath) &&
    observation.listeners.some(
      (listener) =>
        normalizeHost(listener.localAddress) === target.host &&
        listener.port === target.port &&
        listener.owningPid === target.pid
    )
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function observeCurrentEndpointWithRetry(
  observe: (target: RuntimeEndpointTarget) => Promise<RuntimeEndpointObservation>,
  target: RuntimeEndpointTarget,
  expectedExecutablePath: string,
  expectedEntrypointPath: string
): Promise<ProvenRuntimeEndpointObservation> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PUBLICATION_PROOF_ATTEMPTS; attempt += 1) {
    try {
      const observation = await observe(target);
      if (
        observationProvesCurrentEndpoint(
          observation,
          target,
          expectedExecutablePath,
          expectedEntrypointPath
        )
      ) {
        return observation;
      }
      lastError = new Error("observed process/listener identity was incomplete");
    } catch (err) {
      lastError = err;
    }

    if (attempt < PUBLICATION_PROOF_ATTEMPTS) {
      await sleep(PUBLICATION_PROOF_RETRY_MS);
    }
  }

  const detail =
    lastError instanceof Error && lastError.message
      ? `: ${lastError.message}`
      : "";
  throw new Error(`Current runtime endpoint identity could not be proven${detail}.`);
}

export interface ResolveVerifiedRuntimeEndpointOptions {
  role: string;
  expectedExecutablePath: string;
  expectedEntrypointPath: string;
  expectedHealthServer?: string;
  filePath?: string;
  observe?: (target: RuntimeEndpointTarget) => Promise<RuntimeEndpointObservation>;
  probeHealth?: (record: RuntimeEndpointRecord) => Promise<unknown>;
}

export async function resolveVerifiedRuntimeEndpoint(
  options: ResolveVerifiedRuntimeEndpointOptions
): Promise<VerifiedRuntimeEndpoint | undefined> {
  const hint = readRuntimeEndpointHint(
    options.filePath ?? defaultRuntimeEndpointPath(options.role)
  );
  if (!hint) return undefined;

  return verifyRuntimeEndpointRecord(hint, {
    expectedRole: options.role,
    expectedExecutablePath: options.expectedExecutablePath,
    expectedEntrypointPath: options.expectedEntrypointPath,
    expectedHealthServer: options.expectedHealthServer,
    observe: options.observe ?? observeWindowsRuntimeEndpoint,
    probeHealth: options.probeHealth ?? probeRuntimeEndpointHealth,
  });
}

export async function publishCurrentRuntimeEndpoint(
  options: PublishCurrentRuntimeEndpointOptions
): Promise<RuntimeEndpointRecord> {
  if (
    !/^[a-z0-9][a-z0-9_-]*$/i.test(options.role) ||
    !isValidGeneration(options.generation) ||
    !isLoopbackHost(normalizeHost(options.host)) ||
    !isValidPort(options.port) ||
    !options.expectedExecutablePath ||
    !options.expectedEntrypointPath
  ) {
    throw new Error("Invalid current runtime endpoint publication input.");
  }

  const target: RuntimeEndpointTarget = {
    pid: process.pid,
    host: normalizeHost(options.host),
    port: options.port,
  };
  const observe = options.observe ?? observeWindowsRuntimeEndpoint;
  const probeHealth = options.probeHealth ?? probeRuntimeEndpointHealth;

  const firstObservation = await observeCurrentEndpointWithRetry(
    observe,
    target,
    options.expectedExecutablePath,
    options.expectedEntrypointPath
  );

  const record: RuntimeEndpointRecord = {
    schemaVersion: 1,
    role: options.role,
    generation: options.generation,
    state: "ready",
    host: target.host,
    port: target.port,
    pid: target.pid,
    processCreatedAt: firstObservation.processCreatedAt,
    executablePath: firstObservation.executablePath,
    entrypointPath: options.expectedEntrypointPath,
    publishedAt: new Date().toISOString(),
  };

  let verified: VerifiedRuntimeEndpoint | undefined;
  for (let attempt = 1; attempt <= PUBLICATION_PROOF_ATTEMPTS; attempt += 1) {
    verified = await verifyRuntimeEndpointRecord(record, {
      expectedRole: options.role,
      expectedExecutablePath: options.expectedExecutablePath,
      expectedEntrypointPath: options.expectedEntrypointPath,
      expectedHealthServer: options.expectedHealthServer,
      observe,
      probeHealth,
    });
    if (verified) break;
    if (attempt < PUBLICATION_PROOF_ATTEMPTS) {
      await sleep(PUBLICATION_PROOF_RETRY_MS);
    }
  }
  if (!verified) {
    throw new Error("Current runtime endpoint failed post-readiness verification.");
  }

  await publishRuntimeEndpointRecord(
    record,
    options.filePath ?? defaultRuntimeEndpointPath(options.role)
  );
  return record;
}
