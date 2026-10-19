import path from "node:path";
import https from "node:https";
import {
  resolveVerifiedRuntimeEndpoint,
  type ResolveVerifiedRuntimeEndpointOptions,
  type RuntimeEndpointRecord,
  type VerifiedRuntimeEndpoint,
} from "./endpoint-registry.js";

export type InternalPortMode = "automatic" | "fixed";
export type InstallationKind = "clean" | "existing";

export interface FixedInternalPorts {
  core: number;
  r7: number;
  r8: number;
}

export interface InternalPortModeRequest {
  installationKind: InstallationKind;
  requestedMode?: InternalPortMode;
  existingMode?: InternalPortMode;
  existingFixedPorts?: FixedInternalPorts;
  requestedFixedPorts?: FixedInternalPorts;
  explicitModeChange?: boolean;
}

export interface InternalPortRolePlan {
  role: "core" | "r7" | "r8";
  selector: "auto" | number;
  discovery: boolean;
}

export interface InternalPortLaunchPlan {
  schema: 1;
  mode: InternalPortMode;
  installationKind: InstallationKind;
  migration: "none" | "explicit_mode_change";
  requiresUserPortInput: boolean;
  core: InternalPortRolePlan;
  r7: InternalPortRolePlan;
  r8: InternalPortRolePlan;
  public: {
    scheme: "https";
    port: 443;
    exposureDefault: "inactive";
  };
}

function validPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1024 &&
    value <= 65535
  );
}

function validateFixedPorts(ports: FixedInternalPorts | undefined): FixedInternalPorts {
  if (!ports) {
    throw new Error("Fixed internal-port mode requires explicit preserved or requested ports.");
  }
  for (const [role, port] of Object.entries(ports)) {
    if (!validPort(port)) {
      throw new Error(`Invalid fixed ${role} port.`);
    }
  }
  const unique = new Set([ports.core, ports.r7, ports.r8]);
  if (unique.size !== 3) {
    throw new Error("Fixed Core/R7/R8 ports must be distinct on loopback.");
  }
  return ports;
}

export function recommendedInternalPortMode(
  installationKind: InstallationKind,
  existingMode?: InternalPortMode
): InternalPortMode {
  if (installationKind === "clean") return "automatic";
  if (!existingMode) {
    throw new Error("Existing installation mode is required; refusing to infer migration state.");
  }
  return existingMode;
}

export function resolveInternalPortLaunchPlan(
  input: InternalPortModeRequest
): InternalPortLaunchPlan {
  if (input.installationKind !== "clean" && input.installationKind !== "existing") {
    throw new Error("Unsupported installation kind.");
  }

  const baselineMode =
    input.installationKind === "clean"
      ? "automatic"
      : recommendedInternalPortMode("existing", input.existingMode);
  const mode = input.requestedMode ?? baselineMode;
  const changed = input.installationKind === "existing" && mode !== input.existingMode;

  if (changed && input.explicitModeChange !== true) {
    throw new Error(
      "EXPLICIT_MODE_CHANGE_REQUIRED: existing internal-port mode cannot be changed silently."
    );
  }

  if (mode === "automatic") {
    if (input.requestedFixedPorts) {
      throw new Error("Automatic mode does not accept user-selected internal ports.");
    }
    return {
      schema: 1,
      mode,
      installationKind: input.installationKind,
      migration: changed ? "explicit_mode_change" : "none",
      requiresUserPortInput: false,
      core: { role: "core", selector: "auto", discovery: true },
      r7: { role: "r7", selector: "auto", discovery: true },
      r8: { role: "r8", selector: "auto", discovery: true },
      public: { scheme: "https", port: 443, exposureDefault: "inactive" },
    };
  }

  const fixedPorts = validateFixedPorts(
    input.requestedFixedPorts ??
      (input.installationKind === "existing" ? input.existingFixedPorts : undefined)
  );
  return {
    schema: 1,
    mode,
    installationKind: input.installationKind,
    migration: changed ? "explicit_mode_change" : "none",
    requiresUserPortInput: input.installationKind === "clean",
    core: { role: "core", selector: fixedPorts.core, discovery: false },
    r7: { role: "r7", selector: fixedPorts.r7, discovery: false },
    r8: { role: "r8", selector: fixedPorts.r8, discovery: false },
    public: { scheme: "https", port: 443, exposureDefault: "inactive" },
  };
}

export interface TrustedRuntimeIdentity {
  executablePath: string;
  entrypointPath: string;
  registryPath?: string;
  expectedHealthServer?: string;
  probeHealth?: (record: RuntimeEndpointRecord) => Promise<unknown>;
}

export interface TrustedRuntimeTopologyIdentities {
  core: TrustedRuntimeIdentity;
  r7: TrustedRuntimeIdentity;
  r8: TrustedRuntimeIdentity;
}

export function verifiedEndpointBelongsToPid(
  endpoint: VerifiedRuntimeEndpoint | undefined,
  expectedPid: number
): endpoint is VerifiedRuntimeEndpoint {
  return (
    !!endpoint &&
    Number.isInteger(expectedPid) &&
    expectedPid > 0 &&
    endpoint.pid === expectedPid
  );
}

export interface SanitizedVerifiedEndpoint {
  state: "ready" | "unavailable";
  source: "verified_runtime";
  role: "core" | "r7" | "r8";
  host?: string;
  port?: number;
  generation?: string;
  pid?: number;
}

export interface VerifiedInternalTopology {
  schema: 1;
  public: {
    scheme: "https";
    port: 443;
  };
  internal: {
    core: SanitizedVerifiedEndpoint;
    r7: SanitizedVerifiedEndpoint;
    r8: SanitizedVerifiedEndpoint;
  };
}

export function createR8TlsHealthProbe(
  publicHost: string,
  timeoutMs = 3000
): (record: RuntimeEndpointRecord) => Promise<unknown> {
  const servername = publicHost.trim().toLowerCase();
  if (!servername || servername.includes("/") || servername.includes(":")) {
    throw new Error("Invalid R8 public hostname for TLS verification.");
  }

  return async (record: RuntimeEndpointRecord): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: record.host,
          port: record.port,
          method: "GET",
          path: "/health",
          servername,
          rejectUnauthorized: true,
          timeout: timeoutMs,
          headers: {
            "x-winhelm-runtime-generation": record.generation,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > 64 * 1024) {
              req.destroy(new Error("R8 runtime health response exceeded limit."));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error("R8 runtime health probe was not successful."));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new Error("R8 runtime health response was not valid JSON."));
            }
          });
        }
      );
      req.once("timeout", () => req.destroy(new Error("R8 runtime health probe timed out.")));
      req.once("error", reject);
      req.end();
    });
}

function asSanitizedEndpoint(
  role: "core" | "r7" | "r8",
  value: VerifiedRuntimeEndpoint | undefined
): SanitizedVerifiedEndpoint {
  if (!value) {
    return { state: "unavailable", source: "verified_runtime", role };
  }
  return {
    state: "ready",
    source: "verified_runtime",
    role,
    host: value.host,
    port: value.port,
    generation: value.generation,
    pid: value.pid,
  };
}

export async function resolveVerifiedInternalTopology(
  identities: TrustedRuntimeTopologyIdentities,
  resolver: (
    options: ResolveVerifiedRuntimeEndpointOptions
  ) => Promise<VerifiedRuntimeEndpoint | undefined> = resolveVerifiedRuntimeEndpoint
): Promise<VerifiedInternalTopology> {
  const [core, r7, r8] = await Promise.all([
    resolver({
      role: "core",
      expectedExecutablePath: identities.core.executablePath,
      expectedEntrypointPath: identities.core.entrypointPath,
      filePath: identities.core.registryPath,
      expectedHealthServer: identities.core.expectedHealthServer,
      probeHealth: identities.core.probeHealth,
    }),
    resolver({
      role: "r7",
      expectedExecutablePath: identities.r7.executablePath,
      expectedEntrypointPath: identities.r7.entrypointPath,
      filePath: identities.r7.registryPath,
      expectedHealthServer: identities.r7.expectedHealthServer ?? "winhelm-r7",
      probeHealth: identities.r7.probeHealth,
    }),
    resolver({
      role: "r8",
      expectedExecutablePath: identities.r8.executablePath,
      expectedEntrypointPath: identities.r8.entrypointPath,
      filePath: identities.r8.registryPath,
      expectedHealthServer: identities.r8.expectedHealthServer ?? "winhelm-r8",
      probeHealth: identities.r8.probeHealth,
    }),
  ]);

  return {
    schema: 1,
    public: { scheme: "https", port: 443 },
    internal: {
      core: asSanitizedEndpoint("core", core),
      r7: asSanitizedEndpoint("r7", r7),
      r8: asSanitizedEndpoint("r8", r8),
    },
  };
}

export interface ChainLauncherPaths {
  coreExecutable: string;
  coreEntrypoint: string;
  coreConfig?: string;
  r7Executable: string;
  r7Entrypoint: string;
  r7SourceRoot: string;
  r7Store: string;
  r7Receipt: string;
  r7Origin: string;
  r7ClientId: string;
  r7RedirectUri: string;
  r8SupervisorExecutable: string;
  r8SupervisorEntrypoint: string;
  r8Binary: string;
  r8ConfigTemplate: string;
  r8RuntimeConfig: string;
  coreRegistry: string;
  r7Registry: string;
  r8Registry: string;
  r7Preference?: string;
  r8Preference?: string;
}

export interface ProcessSpec {
  role: "core" | "r7" | "r8";
  executable: string;
  args: string[];
  cwd: string;
}

function absolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}

function selectorText(value: "auto" | number): string {
  return value === "auto" ? "auto" : String(value);
}

export function buildRuntimeChainProcessSpecs(
  plan: InternalPortLaunchPlan,
  paths: ChainLauncherPaths
): ProcessSpec[] {
  const coreExecutable = absolute(paths.coreExecutable, "Core executable");
  const coreEntrypoint = absolute(paths.coreEntrypoint, "Core entrypoint");
  const r7Executable = absolute(paths.r7Executable, "R7 executable");
  const r7Entrypoint = absolute(paths.r7Entrypoint, "R7 entrypoint");
  const r8SupervisorExecutable = absolute(
    paths.r8SupervisorExecutable,
    "R8 supervisor executable"
  );
  const r8SupervisorEntrypoint = absolute(
    paths.r8SupervisorEntrypoint,
    "R8 supervisor entrypoint"
  );
  const r8Binary = absolute(paths.r8Binary, "R8 binary");

  const coreArgs = [
    coreEntrypoint,
    "--port",
    selectorText(plan.core.selector),
    "--host",
    "127.0.0.1",
  ];
  if (paths.coreConfig) {
    coreArgs.push("--config", absolute(paths.coreConfig, "Core config"));
  }

  const r7Args = [
    r7Entrypoint,
    `--store=${absolute(paths.r7Store, "R7 store")}`,
    `--port=${selectorText(plan.r7.selector)}`,
    `--backend-port=${selectorText(plan.core.selector)}`,
    `--origin=${paths.r7Origin}`,
    `--receipt=${absolute(paths.r7Receipt, "R7 receipt")}`,
    `--client-id=${paths.r7ClientId}`,
    `--redirect-uri=${paths.r7RedirectUri}`,
    `--source-root=${absolute(paths.r7SourceRoot, "R7 source root")}`,
    `--r7-registry=${absolute(paths.r7Registry, "R7 registry")}`,
  ];
  if (paths.r7Preference) {
    r7Args.push(`--r7-preference=${absolute(paths.r7Preference, "R7 preference")}`);
  }
  if (plan.mode === "automatic") {
    r7Args.push(
      `--core-executable=${coreExecutable}`,
      `--core-entrypoint=${coreEntrypoint}`,
      `--core-registry=${absolute(paths.coreRegistry, "Core registry")}`
    );
  }

  const r8Args = [
    r8SupervisorEntrypoint,
    `--binary=${r8Binary}`,
    `--config-template=${absolute(paths.r8ConfigTemplate, "R8 config template")}`,
    `--runtime-config=${absolute(paths.r8RuntimeConfig, "R8 runtime config")}`,
    `--port=${selectorText(plan.r8.selector)}`,
    `--r7-port=${selectorText(plan.r7.selector)}`,
    `--r8-registry=${absolute(paths.r8Registry, "R8 registry")}`,
  ];
  if (paths.r8Preference) {
    r8Args.push(`--r8-preference=${absolute(paths.r8Preference, "R8 preference")}`);
  }
  if (plan.mode === "automatic") {
    r8Args.push(
      `--r7-executable=${r7Executable}`,
      `--r7-entrypoint=${r7Entrypoint}`,
      `--r7-registry=${absolute(paths.r7Registry, "R7 registry")}`
    );
  }

  return [
    {
      role: "core",
      executable: coreExecutable,
      args: coreArgs,
      cwd: path.dirname(coreEntrypoint),
    },
    {
      role: "r7",
      executable: r7Executable,
      args: r7Args,
      cwd: path.dirname(r7Entrypoint),
    },
    {
      role: "r8",
      executable: r8SupervisorExecutable,
      args: r8Args,
      cwd: path.dirname(r8SupervisorEntrypoint),
    },
  ];
}

export interface ManagedLaunchedProcess {
  role: "core" | "r7" | "r8";
  stop: () => Promise<void>;
}

export type RuntimeChainRole = "core" | "r7" | "r8";

export interface RuntimeChainExitEvent {
  role: RuntimeChainRole;
  reason?: string;
}

export interface SuperviseRuntimeChainOptions extends LaunchRuntimeChainOptions {
  waitForExit: (
    started: readonly ManagedLaunchedProcess[]
  ) => Promise<RuntimeChainExitEvent>;
  maxRestarts: number;
  onCycleReady?: (
    cycle: number,
    started: readonly ManagedLaunchedProcess[]
  ) => Promise<void> | void;
  onRestart?: (
    cycle: number,
    event: RuntimeChainExitEvent
  ) => Promise<void> | void;
  shouldRestart?: (
    event: RuntimeChainExitEvent,
    cyclesStarted: number
  ) => Promise<boolean> | boolean;
}

export interface RuntimeChainSupervisorResult {
  state: "stopped" | "restart_budget_exhausted";
  cyclesStarted: number;
  restartsPerformed: number;
  lastExit: RuntimeChainExitEvent;
}

export interface LaunchRuntimeChainOptions {
  specs: ProcessSpec[];
  spawn: (spec: ProcessSpec) => Promise<ManagedLaunchedProcess>;
  waitReady: (role: "core" | "r7" | "r8") => Promise<void>;
}

export async function launchRuntimeChain(
  options: LaunchRuntimeChainOptions
): Promise<ManagedLaunchedProcess[]> {
  const started: ManagedLaunchedProcess[] = [];
  try {
    for (const role of ["core", "r7", "r8"] as const) {
      const spec = options.specs.find((candidate) => candidate.role === role);
      if (!spec) throw new Error(`Missing ${role} process specification.`);
      const child = await options.spawn(spec);
      started.push(child);
      await options.waitReady(role);
    }
    return started;
  } catch (error) {
    for (const child of [...started].reverse()) {
      await child.stop().catch(() => {});
    }
    throw error;
  }
}

async function stopRuntimeChain(
  started: readonly ManagedLaunchedProcess[]
): Promise<void> {
  for (const child of [...started].reverse()) {
    await child.stop().catch(() => {});
  }
}

export async function superviseRuntimeChain(
  options: SuperviseRuntimeChainOptions
): Promise<RuntimeChainSupervisorResult> {
  if (!Number.isInteger(options.maxRestarts) || options.maxRestarts < 0) {
    throw new Error("maxRestarts must be a non-negative integer.");
  }

  let cyclesStarted = 0;
  let restartsPerformed = 0;

  for (;;) {
    const started = await launchRuntimeChain(options);
    cyclesStarted += 1;
    await options.onCycleReady?.(cyclesStarted, started);

    let event: RuntimeChainExitEvent;
    try {
      event = await options.waitForExit(started);
    } finally {
      await stopRuntimeChain(started);
    }

    if (
      options.shouldRestart &&
      !(await options.shouldRestart(event!, cyclesStarted))
    ) {
      return {
        state: "stopped",
        cyclesStarted,
        restartsPerformed,
        lastExit: event!,
      };
    }

    if (restartsPerformed >= options.maxRestarts) {
      return {
        state: "restart_budget_exhausted",
        cyclesStarted,
        restartsPerformed,
        lastExit: event!,
      };
    }

    restartsPerformed += 1;
    await options.onRestart?.(restartsPerformed, event!);
  }
}
