import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";

/**
 * M3A-P2 ChatGPT/OpenAI Tunnel lifecycle service.
 *
 * This module is the single authority for tunnel lifecycle policy used by the
 * CLI, the Admin plane, and the Product Shell. It owns non-secret local
 * lifecycle configuration, dependency/profile qualification, active-backend
 * readiness, managed process identity, bounded health/readiness probes, and
 * the managed vs external/unmanaged distinction.
 *
 * Security invariants:
 * - never persists or returns secret values (API keys, tokens, .env contents);
 * - never stops or restarts a tunnel process it did not start itself;
 * - managed stop/restart requires persisted identity proof sufficient to
 *   reject PID reuse and stale state (PID + executable path + creation time);
 * - fails closed on stale/missing active-backend marker, config, dist, or
 *   HEAD mismatch before managed start/restart;
 * - never mutates the active-backend marker.
 */

export const QUALIFIED_TUNNEL_CLIENT_VERSION =
  "0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0";

const LIFECYCLE_CONFIG_FILE = "lifecycle-config.json";
const MANAGED_STATE_FILE = "managed-state.json";
const HEALTH_URL_FILE = "current-health-url.txt";

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const GIT_TIMEOUT_MS = 10_000;
const IDENTITY_PROBE_TIMEOUT_MS = 8_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const START_READINESS_TIMEOUT_MS = 20_000;
const START_POLL_INTERVAL_MS = 250;
const STOP_GRACEFUL_TIMEOUT_MS = 3_000;
const STOP_FORCE_TIMEOUT_MS = 3_000;
const PROCESS_CREATION_TOLERANCE_MS = 2_000;

const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|apikey|api[-_]?key|authorization|credential)/i;

export interface TunnelLifecycleConfig {
  schemaVersion: 1;
  executablePath?: string;
  executableArgs?: string[];
  profilePath?: string;
  markerPath?: string;
  healthUrl?: string;
}

export interface ManagedTunnelState {
  schemaVersion: 1;
  stateId: string;
  pid: number;
  processCreatedAt: string;
  executablePath: string;
  executableArgs?: string[];
  profilePath: string;
  startedAt: string;
  healthUrl: string;
  status: "starting" | "ready";
}

export type TunnelDependencyState =
  | { state: "missing"; detail: string }
  | { state: "unqualified"; detail: string; observedVersion?: string }
  | { state: "qualified"; detail: string; version: string };

export interface BackendReadinessResult {
  ready: boolean;
  markerPath: string;
  reason?: string;
  detail?: string;
}

export interface TunnelStatus {
  configPresent: boolean;
  configCorrupt: boolean;
  managedStatePresent: boolean;
  managedStateCorrupt: boolean;
  qualifiedVersion: string;
  dependency: TunnelDependencyState;
  profile: { state: "missing" | "ready"; path: string | null };
  backend: {
    state: "ready" | "stale" | "attention";
    reason: string | null;
    markerPath: string;
  };
  daemon: {
    state:
      | "stopped"
      | "external_running"
      | "managed_starting"
      | "managed_ready"
      | "managed_degraded";
    ownership: "none" | "managed" | "external";
    pid: number | null;
    healthUrl: string | null;
    stopRestartAvailable: boolean;
  };
}

export interface TunnelDoctorCheck {
  name: string;
  ok: boolean;
  code?: string;
  detail: string;
}

export class TunnelLifecycleError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TunnelLifecycleError";
    this.code = code;
    this.details = details;
  }
}

function repositoryRoot(): string {
  // src/integrations/ and dist/integrations/ are both one level below the
  // repository root, so "../../" resolves correctly for source and build.
  return fileURLToPath(new URL("../../", import.meta.url));
}

export function resolveTunnelStateDir(): string {
  const override = process.env.WINHELM_TUNNEL_STATE_DIR;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".winhelm", "tunnel");
}

function stateFilePath(fileName: string): string {
  return path.join(resolveTunnelStateDir(), fileName);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.winhelm-${process.pid}-${randomUUID()}.tmp`
  );
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function atomicWriteText(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.winhelm-${process.pid}-${randomUUID()}.tmp`
  );
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, filePath);
}

async function removeQuiet(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // best effort cleanup
  }
}

/**
 * Redacts secret-shaped values recursively. Applied to every projection that
 * leaves this service (status, doctor, CLI, Admin responses).
 */
export function redactTunnelSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactTunnelSecrets(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactTunnelSecrets(val);
      }
    }
    return out as unknown as T;
  }
  return value;
}

export function loadTunnelLifecycleConfig(): {
  config: TunnelLifecycleConfig;
  present: boolean;
  corrupt: boolean;
} {
  const filePath = stateFilePath(LIFECYCLE_CONFIG_FILE);
  let present = false;
  try {
    present = fsSync.existsSync(filePath);
  } catch {
    present = false;
  }
  if (!present) {
    return { config: { schemaVersion: 1 }, present: false, corrupt: false };
  }
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: { schemaVersion: 1 }, present: true, corrupt: true };
    }
    const config: TunnelLifecycleConfig = { schemaVersion: 1 };
    if (typeof parsed.executablePath === "string" && parsed.executablePath.trim()) {
      config.executablePath = parsed.executablePath.trim();
    }
    if (
      Array.isArray(parsed.executableArgs) &&
      parsed.executableArgs.every((a) => typeof a === "string")
    ) {
      config.executableArgs = (parsed.executableArgs as string[]).slice();
    }
    if (typeof parsed.profilePath === "string" && parsed.profilePath.trim()) {
      config.profilePath = parsed.profilePath.trim();
    }
    if (typeof parsed.markerPath === "string" && parsed.markerPath.trim()) {
      config.markerPath = parsed.markerPath.trim();
    }
    if (typeof parsed.healthUrl === "string" && parsed.healthUrl.trim()) {
      config.healthUrl = parsed.healthUrl.trim();
    }
    return { config, present: true, corrupt: false };
  } catch {
    return { config: { schemaVersion: 1 }, present: true, corrupt: true };
  }
}

export async function saveTunnelLifecycleConfig(
  patch: Partial<Omit<TunnelLifecycleConfig, "schemaVersion">>
): Promise<TunnelLifecycleConfig> {
  const current = loadTunnelLifecycleConfig();
  const next: TunnelLifecycleConfig = { ...current.config };
  if (patch.executablePath !== undefined) {
    next.executablePath = patch.executablePath.trim() || undefined;
  }
  if (patch.executableArgs !== undefined) {
    next.executableArgs = patch.executableArgs.map((a) => a).filter((a) => a.length > 0);
    if (next.executableArgs.length === 0) delete next.executableArgs;
  }
  if (patch.profilePath !== undefined) {
    next.profilePath = patch.profilePath.trim() || undefined;
  }
  if (patch.markerPath !== undefined) {
    next.markerPath = patch.markerPath.trim() || undefined;
  }
  if (patch.healthUrl !== undefined) {
    next.healthUrl = patch.healthUrl.trim() || undefined;
  }
  await atomicWriteJson(stateFilePath(LIFECYCLE_CONFIG_FILE), next);
  return next;
}

export function loadManagedTunnelState(): {
  state: ManagedTunnelState | null;
  corrupt: boolean;
} {
  const filePath = stateFilePath(MANAGED_STATE_FILE);
  let present = false;
  try {
    present = fsSync.existsSync(filePath);
  } catch {
    present = false;
  }
  if (!present) return { state: null, corrupt: false };
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ManagedTunnelState>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.stateId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.processCreatedAt !== "string" ||
      typeof parsed.executablePath !== "string" ||
      typeof parsed.profilePath !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.healthUrl !== "string" ||
      (parsed.status !== "starting" && parsed.status !== "ready")
    ) {
      return { state: null, corrupt: true };
    }
    return { state: parsed as ManagedTunnelState, corrupt: false };
  } catch {
    return { state: null, corrupt: true };
  }
}

interface BoundedResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runBounded(
  command: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string }
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve({ code: null, stdout, stderr, timedOut: true });
      }
    }, options.timeoutMs);
    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, timedOut: false });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut: false });
      }
    });
  });
}

async function runBoundedText(
  command: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string }
): Promise<string | null> {
  const res = await runBounded(command, args, options);
  if (res.code !== 0 || res.timedOut) return null;
  return res.stdout;
}

interface HttpProbeResult {
  ok: boolean;
  status: number;
  body: string;
}

async function httpProbe(url: string): Promise<HttpProbeResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: "" };
  }
}

async function probeDaemonHealth(healthUrl: string): Promise<{
  live: boolean;
  ready: boolean;
  version?: string;
}> {
  const healthz = await httpProbe(new URL("/healthz", healthUrl).toString());
  const readyz = await httpProbe(new URL("/readyz", healthUrl).toString());
  let version: string | undefined;
  if (healthz.ok) {
    const health = await httpProbe(new URL("/health", healthUrl).toString());
    if (health.ok && health.body) {
      try {
        const parsed = JSON.parse(health.body) as { version?: unknown };
        if (typeof parsed.version === "string") version = parsed.version;
      } catch {
        // version metadata is optional
      }
    }
  }
  return { live: healthz.ok, ready: readyz.ok, version };
}

interface ProcessIdentity {
  exists: boolean;
  executablePath?: string;
  createdAtIso?: string;
}

async function queryProcessIdentity(pid: number): Promise<ProcessIdentity> {
  const script =
    "$ErrorActionPreference='Stop';" +
    `try { $p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop | Select-Object -First 1;` +
    "if ($p) { Write-Output ('FOUND|' + $p.CreationDate.ToString('o') + '|' + $p.ExecutablePath) }" +
    "else { Write-Output 'NOTFOUND' } } catch { Write-Output 'NOTFOUND' }";
  const out = await runBoundedText(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: IDENTITY_PROBE_TIMEOUT_MS }
  );
  if (out === null) return { exists: false };
  const line = out.trim().split(/\r?\n/).find((l) => l.startsWith("FOUND|"));
  if (!line) return { exists: false };
  const parts = line.split("|");
  if (parts.length < 3) return { exists: false };
  return {
    exists: true,
    createdAtIso: parts[1] || undefined,
    executablePath: parts.slice(2).join("|") || undefined,
  };
}

function creationTimeMatches(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= PROCESS_CREATION_TOLERANCE_MS;
}

export interface ManagedIdentityProofInput {
  observedExists: boolean;
  observedExecutablePath?: string;
  observedCreatedAtIso?: string;
  persistedPid: number;
  persistedExecutablePath?: string;
  persistedProcessCreatedAt?: string;
}

/**
 * Conjunctive managed-identity proof, fail closed. Identity is proven only
 * when the PID is valid, the process row is observed, BOTH executable paths
 * are present and match case-insensitively, and BOTH creation times are
 * present, parseable, and equal within the accepted tolerance. A missing or
 * malformed field on either side leaves identity UNPROVEN — "field
 * unavailable" is never treated as "field matched".
 */
export function isManagedIdentityProven(input: ManagedIdentityProofInput): boolean {
  if (
    typeof input.persistedPid !== "number" ||
    !Number.isInteger(input.persistedPid) ||
    input.persistedPid <= 0
  ) {
    return false;
  }
  if (!input.observedExists) return false;
  if (typeof input.persistedExecutablePath !== "string" || !input.persistedExecutablePath) {
    return false;
  }
  if (typeof input.observedExecutablePath !== "string" || !input.observedExecutablePath) {
    return false;
  }
  if (input.observedExecutablePath.toLowerCase() !== input.persistedExecutablePath.toLowerCase()) {
    return false;
  }
  if (typeof input.persistedProcessCreatedAt !== "string" || !input.persistedProcessCreatedAt) {
    return false;
  }
  if (typeof input.observedCreatedAtIso !== "string" || !input.observedCreatedAtIso) {
    return false;
  }
  return creationTimeMatches(input.observedCreatedAtIso, input.persistedProcessCreatedAt);
}

/**
 * Proves that the process recorded in managed state is still the exact
 * process WinHelm started: same PID, same executable path, and matching
 * creation time. Any doubt returns false (fail closed, never kill).
 */
async function verifyManagedIdentity(state: ManagedTunnelState): Promise<boolean> {
  if (typeof state.pid !== "number" || !Number.isInteger(state.pid) || state.pid <= 0) {
    return false;
  }
  try {
    process.kill(state.pid, 0);
  } catch {
    return false;
  }
  const identity = await queryProcessIdentity(state.pid);
  return isManagedIdentityProven({
    observedExists: identity.exists,
    observedExecutablePath: identity.executablePath,
    observedCreatedAtIso: identity.createdAtIso,
    persistedPid: state.pid,
    persistedExecutablePath: state.executablePath,
    persistedProcessCreatedAt: state.processCreatedAt,
  });
}

async function taskkill(pid: number, force: boolean, tree: boolean): Promise<void> {
  const args = ["/PID", String(pid)];
  if (tree) args.push("/T");
  if (force) args.push("/F");
  await runBounded("taskkill.exe", args, { timeoutMs: 5_000 });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  return false;
}

function parseVersionToken(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+\+[0-9a-fA-F]{7,40}/);
  return match ? match[0] : null;
}

export function resolveMarkerPath(config?: TunnelLifecycleConfig): string {
  const effective = config ?? loadTunnelLifecycleConfig().config;
  if (effective.markerPath) return effective.markerPath;
  const envMarker = process.env.WINHELM_ACTIVE_BACKEND_MARKER;
  if (envMarker && envMarker.trim()) return envMarker.trim();
  return path.join(repositoryRoot(), "temp", "winhelm.active-backend.json");
}

export async function qualifyTunnelDependency(
  configOverride?: TunnelLifecycleConfig
): Promise<TunnelDependencyState> {
  const config = configOverride ?? loadTunnelLifecycleConfig().config;
  if (!config.executablePath) {
    return {
      state: "missing",
      detail: "Tunnel-client executable is not configured.",
    };
  }
  let stat: fsSync.Stats | null = null;
  try {
    stat = await fs.stat(config.executablePath);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    return {
      state: "missing",
      detail: "Configured tunnel-client executable does not exist.",
    };
  }
  const args = [...(config.executableArgs ?? []), "--version"];
  const probe = await runBounded(config.executablePath, args, {
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    cwd: path.dirname(config.executablePath),
  });
  if (probe.timedOut || probe.code !== 0) {
    return {
      state: "unqualified",
      detail: "Tunnel-client --version probe failed or timed out.",
    };
  }
  const observed = parseVersionToken(probe.stdout);
  if (!observed) {
    return {
      state: "unqualified",
      detail: "Tunnel-client did not report a recognizable version.",
    };
  }
  if (observed !== QUALIFIED_TUNNEL_CLIENT_VERSION) {
    return {
      state: "unqualified",
      detail: `Tunnel-client version ${observed} is not the qualified reference ${QUALIFIED_TUNNEL_CLIENT_VERSION}.`,
      observedVersion: observed,
    };
  }
  return {
    state: "qualified",
    detail: `Tunnel-client version ${observed} matches the qualified reference.`,
    version: observed,
  };
}

export async function evaluateBackendReadiness(
  configOverride?: TunnelLifecycleConfig
): Promise<BackendReadinessResult> {
  const markerPath = resolveMarkerPath(configOverride);
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, "utf8");
  } catch {
    return { ready: false, markerPath, reason: "MARKER_MISSING" };
  }
  let marker: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    marker = parsed as Record<string, unknown>;
  } catch {
    return { ready: false, markerPath, reason: "MARKER_MALFORMED" };
  }
  if (marker.schemaVersion !== 1) {
    return { ready: false, markerPath, reason: "MARKER_SCHEMA_UNSUPPORTED" };
  }
  const backendRoot = typeof marker.backendRoot === "string" ? marker.backendRoot.trim() : "";
  const configPath = typeof marker.configPath === "string" ? marker.configPath.trim() : "";
  if (!backendRoot || !configPath) {
    return { ready: false, markerPath, reason: "MARKER_FIELD_MISSING" };
  }
  let rootStat: fsSync.Stats | null = null;
  try {
    rootStat = await fs.stat(backendRoot);
  } catch {
    rootStat = null;
  }
  if (!rootStat || !rootStat.isDirectory()) {
    return { ready: false, markerPath, reason: "BACKEND_ROOT_MISSING" };
  }
  let configStat: fsSync.Stats | null = null;
  try {
    configStat = await fs.stat(configPath);
  } catch {
    configStat = null;
  }
  if (!configStat || !configStat.isFile()) {
    return { ready: false, markerPath, reason: "BACKEND_CONFIG_MISSING" };
  }
  const distEntry = path.join(backendRoot, "dist", "index.js");
  let distStat: fsSync.Stats | null = null;
  try {
    distStat = await fs.stat(distEntry);
  } catch {
    distStat = null;
  }
  if (!distStat || !distStat.isFile()) {
    return { ready: false, markerPath, reason: "BACKEND_DIST_MISSING" };
  }
  const expectedHead =
    typeof marker.expectedHead === "string" ? marker.expectedHead.trim() : "";
  if (expectedHead) {
    const actual = await runBoundedText(
      "git",
      ["-C", backendRoot, "rev-parse", "HEAD"],
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    if (actual === null) {
      return { ready: false, markerPath, reason: "GIT_VERIFICATION_UNAVAILABLE" };
    }
    const actualHead = actual.trim().split(/\r?\n/)[0].toLowerCase();
    if (actualHead !== expectedHead.toLowerCase()) {
      return {
        ready: false,
        markerPath,
        reason: "HEAD_MISMATCH",
        detail: "Marker expectedHead does not match the backend Git HEAD.",
      };
    }
  }
  const launcherPath = path.join(backendRoot, "start-active-stdio.ps1");
  let launcherStat: fsSync.Stats | null = null;
  try {
    launcherStat = await fs.stat(launcherPath);
  } catch {
    launcherStat = null;
  }
  if (!launcherStat || !launcherStat.isFile()) {
    return { ready: false, markerPath, reason: "LAUNCHER_MISSING" };
  }
  const tracked = await runBounded(
    "git",
    ["-C", backendRoot, "ls-files", "--error-unmatch", "start-active-stdio.ps1"],
    { timeoutMs: GIT_TIMEOUT_MS }
  );
  if (tracked.code !== 0 || tracked.timedOut) {
    return {
      ready: false,
      markerPath,
      reason: "LAUNCHER_UNTRACKED",
      detail: "The active-stdio launcher is not tracked in the backend repository.",
    };
  }
  return { ready: true, markerPath };
}

async function projectDaemon(
  status: TunnelStatus,
  config: TunnelLifecycleConfig
): Promise<TunnelStatus> {
  const managed = loadManagedTunnelState();
  status.managedStatePresent = managed.state !== null || managed.corrupt;
  status.managedStateCorrupt = managed.corrupt;

  if (managed.state && !managed.corrupt) {
    const identityProven = await verifyManagedIdentity(managed.state);
    if (identityProven) {
      const health = await probeDaemonHealth(managed.state.healthUrl);
      status.daemon.ownership = "managed";
      status.daemon.pid = managed.state.pid;
      status.daemon.healthUrl = managed.state.healthUrl;
      if (health.live && health.ready && managed.state.status === "ready") {
        status.daemon.state = "managed_ready";
        status.daemon.stopRestartAvailable = true;
      } else if (health.live && managed.state.status === "starting") {
        status.daemon.state = "managed_starting";
        status.daemon.stopRestartAvailable = true;
      } else {
        status.daemon.state = "managed_degraded";
        status.daemon.stopRestartAvailable = true;
      }
      return status;
    }
    // Stale or unprovable managed state: degrade to read-only observation.
    // Never kill; stop/restart will adjudicate and clear the state.
    status.daemon.state = "stopped";
    status.daemon.ownership = "none";
    status.daemon.pid = managed.state.pid;
    status.daemon.stopRestartAvailable = false;
    return status;
  }

  if (config.healthUrl) {
    const health = await probeDaemonHealth(config.healthUrl);
    if (health.live) {
      status.daemon.ownership = "external";
      status.daemon.state = "external_running";
      status.daemon.healthUrl = config.healthUrl;
      status.daemon.stopRestartAvailable = false;
      return status;
    }
  }

  status.daemon.state = "stopped";
  status.daemon.ownership = "none";
  status.daemon.stopRestartAvailable = false;
  return status;
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
  const loaded = loadTunnelLifecycleConfig();
  const config = loaded.config;

  const status: TunnelStatus = {
    configPresent: loaded.present,
    configCorrupt: loaded.corrupt,
    managedStatePresent: false,
    managedStateCorrupt: false,
    qualifiedVersion: QUALIFIED_TUNNEL_CLIENT_VERSION,
    dependency: { state: "missing", detail: "Tunnel lifecycle is not configured." },
    profile: { state: "missing", path: config.profilePath ?? null },
    backend: { state: "attention", reason: "MARKER_MISSING", markerPath: resolveMarkerPath(config) },
    daemon: {
      state: "stopped",
      ownership: "none",
      pid: null,
      healthUrl: null,
      stopRestartAvailable: false,
    },
  };

  status.dependency = await qualifyTunnelDependency(config);

  if (config.profilePath) {
    try {
      const stat = await fs.stat(config.profilePath);
      status.profile = {
        state: stat.isFile() ? "ready" : "missing",
        path: config.profilePath,
      };
    } catch {
      status.profile = { state: "missing", path: config.profilePath };
    }
  }

  const readiness = await evaluateBackendReadiness(config);
  status.backend = {
    state: readiness.ready
      ? "ready"
      : readiness.reason === "MARKER_MISSING" ||
          readiness.reason === "MARKER_MALFORMED" ||
          readiness.reason === "MARKER_SCHEMA_UNSUPPORTED" ||
          readiness.reason === "MARKER_FIELD_MISSING"
        ? "stale"
        : "attention",
    reason: readiness.ready ? null : (readiness.reason ?? "UNKNOWN"),
    markerPath: readiness.markerPath,
  };

  return projectDaemon(status, config);
}

export async function getTunnelDoctor(): Promise<{ checks: TunnelDoctorCheck[] }> {
  const loaded = loadTunnelLifecycleConfig();
  const config = loaded.config;
  const checks: TunnelDoctorCheck[] = [];

  checks.push({
    name: "lifecycleConfig",
    ok: loaded.present && !loaded.corrupt,
    code: loaded.corrupt ? "TUNNEL_CONFIG_CORRUPT" : loaded.present ? undefined : "TUNNEL_CONFIG_ABSENT",
    detail: loaded.corrupt
      ? "Lifecycle configuration is corrupt; read-only defaults apply."
      : loaded.present
        ? `Lifecycle configuration present at ${stateFilePath(LIFECYCLE_CONFIG_FILE)}.`
        : "Lifecycle configuration is absent; run `winhelm tunnel configure`.",
  });

  const dependency = await qualifyTunnelDependency(config);
  checks.push({
    name: "dependency",
    ok: dependency.state === "qualified",
    code: dependency.state === "qualified" ? undefined : "TUNNEL_DEPENDENCY_UNQUALIFIED",
    detail: dependency.detail,
  });

  if (config.profilePath) {
    try {
      const stat = await fs.stat(config.profilePath);
      checks.push({
        name: "profile",
        ok: stat.isFile(),
        code: stat.isFile() ? undefined : "TUNNEL_PROFILE_MISSING",
        detail: stat.isFile()
          ? `Profile file exists (${config.profilePath}); contents are never read or displayed.`
          : "Configured profile path is not a file.",
      });
    } catch {
      checks.push({
        name: "profile",
        ok: false,
        code: "TUNNEL_PROFILE_MISSING",
        detail: "Configured profile path does not exist.",
      });
    }
  } else {
    checks.push({
      name: "profile",
      ok: false,
      code: "TUNNEL_PROFILE_MISSING",
      detail: "No tunnel-client profile path is configured.",
    });
  }

  const readiness = await evaluateBackendReadiness(config);
  checks.push({
    name: "backendReadiness",
    ok: readiness.ready,
    code: readiness.ready ? undefined : (readiness.reason ?? "BACKEND_NOT_READY"),
    detail: readiness.ready
      ? `Active-backend marker satisfies the readiness contract (${readiness.markerPath}).`
      : `Active-backend readiness blocked: ${readiness.reason ?? "unknown"} (${readiness.markerPath}).`,
  });

  const managed = loadManagedTunnelState();
  checks.push({
    name: "managedState",
    ok: !managed.corrupt,
    code: managed.corrupt ? "MANAGED_STATE_CORRUPT" : undefined,
    detail: managed.corrupt
      ? "Managed state is corrupt; WinHelm will not stop or restart until state is proven."
      : managed.state
        ? `Managed state present (pid ${managed.state.pid}, status ${managed.state.status}).`
        : "No managed tunnel state present.",
  });

  const status = await getTunnelStatus();
  checks.push({
    name: "daemon",
    ok: true,
    detail: `Daemon observed as ${status.daemon.state} (ownership: ${status.daemon.ownership}).`,
  });

  return { checks };
}

async function assertStartPreconditions(config: TunnelLifecycleConfig): Promise<void> {
  const existing = loadManagedTunnelState();
  if (existing.state && !existing.corrupt) {
    const proven = await verifyManagedIdentity(existing.state);
    if (proven) {
      throw new TunnelLifecycleError(
        "MANAGED_ALREADY_RUNNING",
        "A managed tunnel daemon is already running; stop it before starting a new one.",
        { pid: existing.state.pid }
      );
    }
    // Stale managed state: clear it so a new identity can be minted.
    await removeQuiet(stateFilePath(MANAGED_STATE_FILE));
  }

  const dependency = await qualifyTunnelDependency(config);
  if (dependency.state !== "qualified") {
    throw new TunnelLifecycleError(
      "TUNNEL_DEPENDENCY_UNQUALIFIED",
      dependency.detail,
      { dependencyState: dependency.state }
    );
  }
  if (!config.profilePath) {
    throw new TunnelLifecycleError(
      "TUNNEL_PROFILE_MISSING",
      "No tunnel-client profile path is configured; run configure first."
    );
  }
  let profileStat: fsSync.Stats | null = null;
  try {
    profileStat = await fs.stat(config.profilePath);
  } catch {
    profileStat = null;
  }
  if (!profileStat || !profileStat.isFile()) {
    throw new TunnelLifecycleError(
      "TUNNEL_PROFILE_MISSING",
      "Configured tunnel-client profile does not exist."
    );
  }
  const readiness = await evaluateBackendReadiness(config);
  if (!readiness.ready) {
    throw new TunnelLifecycleError(
      "BACKEND_NOT_READY",
      `Active-backend readiness gate blocked managed start: ${readiness.reason ?? "unknown"}.`,
      { reason: readiness.reason }
    );
  }
}

async function killManagedChild(pid: number): Promise<void> {
  // Only ever called for a PID produced by THIS start attempt.
  await taskkill(pid, false, true);
  const graceful = await waitForExit(pid, STOP_GRACEFUL_TIMEOUT_MS);
  if (!graceful) {
    await taskkill(pid, true, true);
    await waitForExit(pid, STOP_FORCE_TIMEOUT_MS);
  }
}

export async function startManagedTunnel(): Promise<TunnelStatus> {
  const loaded = loadTunnelLifecycleConfig();
  if (loaded.corrupt) {
    throw new TunnelLifecycleError(
      "TUNNEL_CONFIG_INVALID",
      "Lifecycle configuration is corrupt; refusing to start."
    );
  }
  const config = loaded.config;
  await assertStartPreconditions(config);
  if (!config.executablePath) {
    throw new TunnelLifecycleError(
      "TUNNEL_DEPENDENCY_UNQUALIFIED",
      "Tunnel-client executable is not configured."
    );
  }

  const stateDir = resolveTunnelStateDir();
  const urlFile = path.join(stateDir, HEALTH_URL_FILE);
  await removeQuiet(urlFile);

  const args = [
    ...(config.executableArgs ?? []),
    "run",
    "--config",
    config.profilePath as string,
    "--health.listen-addr",
    "127.0.0.1:0",
    "--health.url-file",
    urlFile,
  ];

  const child = spawn(config.executablePath, args, {
    cwd: path.dirname(config.executablePath),
    stdio: "ignore",
    windowsHide: true,
  });
  // The managed daemon outlives this process by design (CLI start must be
  // able to exit; stop/restart re-attaches through persisted identity).
  child.unref();
  child.on("error", () => {
    // Spawn failures are observed through the bounded readiness loop below.
  });

  const pid = child.pid as number;
  let processCreatedAt = new Date().toISOString();
  const identity = await queryProcessIdentity(pid);
  if (identity.exists && identity.createdAtIso) {
    processCreatedAt = identity.createdAtIso;
  }

  const state: ManagedTunnelState = {
    schemaVersion: 1,
    stateId: randomUUID(),
    pid,
    processCreatedAt,
    executablePath: config.executablePath,
    executableArgs: config.executableArgs,
    profilePath: config.profilePath as string,
    startedAt: new Date().toISOString(),
    healthUrl: "",
    status: "starting",
  };
  await atomicWriteJson(stateFilePath(MANAGED_STATE_FILE), state);

  const deadline = Date.now() + START_READINESS_TIMEOUT_MS;
  let failureReason: string | null = null;
  let healthUrl: string | null = null;

  while (Date.now() < deadline) {
    if (!fsSync.existsSync(urlFile)) {
      await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
      continue;
    }
    try {
      healthUrl = (await fs.readFile(urlFile, "utf8")).trim();
    } catch {
      await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
      continue;
    }
    if (!healthUrl) {
      await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
      continue;
    }
    const health = await probeDaemonHealth(healthUrl);
    if (health.live && health.ready) {
      if (health.version && health.version !== QUALIFIED_TUNNEL_CLIENT_VERSION) {
        failureReason = `Started daemon reported unqualified runtime version ${health.version}.`;
        break;
      }
      const readyState: ManagedTunnelState = {
        ...state,
        healthUrl,
        status: "ready",
      };
      await atomicWriteJson(stateFilePath(MANAGED_STATE_FILE), readyState);
      return getTunnelStatus();
    }
    try {
      process.kill(pid, 0);
    } catch {
      failureReason = "Started tunnel-client process exited before becoming ready.";
      break;
    }
    await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
  }

  if (!failureReason) {
    failureReason = "Managed tunnel start timed out before /healthz and /readyz passed.";
  }

  // Clean up ONLY the process created by this start attempt.
  await killManagedChild(pid);
  await removeQuiet(stateFilePath(MANAGED_STATE_FILE));
  await removeQuiet(urlFile);
  throw new TunnelLifecycleError("TUNNEL_START_FAILED", failureReason, { pid });
}

async function clearManagedState(): Promise<void> {
  await removeQuiet(stateFilePath(MANAGED_STATE_FILE));
  await removeQuiet(path.join(resolveTunnelStateDir(), HEALTH_URL_FILE));
}

export async function stopManagedTunnel(): Promise<TunnelStatus> {
  const managed = loadManagedTunnelState();
  if (managed.corrupt) {
    throw new TunnelLifecycleError(
      "MANAGED_IDENTITY_UNPROVEN",
      "Managed tunnel state is corrupt; identity cannot be proven, so nothing will be stopped.",
      { staleStateCleared: false }
    );
  }
  if (!managed.state) {
    throw new TunnelLifecycleError(
      "TUNNEL_NOT_MANAGED",
      "No WinHelm-managed tunnel state exists; WinHelm never stops externally managed tunnel daemons."
    );
  }
  const proven = await verifyManagedIdentity(managed.state);
  if (!proven) {
    // Stale managed state: clear it without killing any process.
    await clearManagedState();
    throw new TunnelLifecycleError(
      "MANAGED_IDENTITY_UNPROVEN",
      "Managed identity could not be proven; stale state was cleared and no process was stopped.",
      { staleStateCleared: true }
    );
  }

  const pid = managed.state.pid;
  await taskkill(pid, false, false);
  let exited = await waitForExit(pid, STOP_GRACEFUL_TIMEOUT_MS);
  if (!exited) {
    await taskkill(pid, true, false);
    exited = await waitForExit(pid, STOP_FORCE_TIMEOUT_MS);
  }
  if (!exited) {
    throw new TunnelLifecycleError(
      "TUNNEL_STOP_FAILED",
      `Managed tunnel process ${pid} did not exit within the bounded stop window.`,
      { pid }
    );
  }
  await clearManagedState();
  return getTunnelStatus();
}

export async function restartManagedTunnel(): Promise<TunnelStatus> {
  try {
    await stopManagedTunnel();
  } catch (err) {
    if (
      err instanceof TunnelLifecycleError &&
      (err.code === "TUNNEL_NOT_MANAGED" || err.code === "MANAGED_IDENTITY_UNPROVEN")
    ) {
      // Nothing safely stoppable; proceed to a fresh managed start.
    } else {
      throw err;
    }
  }
  return startManagedTunnel();
}
