import {
  publishObservedRuntimeEndpoint,
  resolveVerifiedRuntimeEndpoint,
  type PublishObservedRuntimeEndpointOptions,
  type ResolveVerifiedRuntimeEndpointOptions,
  type RuntimeEndpointObservation,
  type RuntimeEndpointRecord,
  type RuntimeEndpointTarget,
  type VerifiedRuntimeEndpoint,
} from "./endpoint-registry.js";
import type { InternalPortSelection } from "./internal-port.js";
import { isLoopbackHost } from "../utils/network-gate.js";

const R8_ROLE = "r8";
const R8_HEALTH_SERVER = "winhelm-r8";

export interface R8UpstreamEndpoint {
  mode: "fixed" | "auto";
  host: string;
  port: number;
  generation?: string;
  pid?: number;
}

export interface ResolveR8R7UpstreamOptions {
  selection: InternalPortSelection;
  host: string;
  expectedR7ExecutablePath?: string;
  expectedR7EntrypointPath?: string;
  r7RegistryPath?: string;
  resolveVerified?: (
    options: ResolveVerifiedRuntimeEndpointOptions
  ) => Promise<VerifiedRuntimeEndpoint | undefined>;
}

export async function resolveR8R7Upstream(
  options: ResolveR8R7UpstreamOptions
): Promise<R8UpstreamEndpoint> {
  if (!isLoopbackHost(options.host)) {
    throw new Error("R8 R7 upstream must remain on a loopback host.");
  }

  if (options.selection.mode === "fixed") {
    return {
      mode: "fixed",
      host: options.host,
      port: options.selection.port,
    };
  }

  if (!options.expectedR7ExecutablePath || !options.expectedR7EntrypointPath) {
    throw new Error(
      "R8 R7 auto discovery requires trusted R7 executable and entrypoint paths."
    );
  }

  const resolver = options.resolveVerified ?? resolveVerifiedRuntimeEndpoint;
  const verified = await resolver({
    role: "r7",
    expectedExecutablePath: options.expectedR7ExecutablePath,
    expectedEntrypointPath: options.expectedR7EntrypointPath,
    expectedHealthServer: "winhelm-r7",
    filePath: options.r7RegistryPath,
  });
  if (!verified) {
    throw new Error("Verified R7 runtime endpoint is unavailable.");
  }
  if (!isLoopbackHost(verified.host)) {
    throw new Error("Verified R7 runtime endpoint is not loopback.");
  }

  return {
    mode: "auto",
    host: verified.host,
    port: verified.port,
    generation: verified.generation,
    pid: verified.pid,
  };
}

export interface PublishR8RuntimeEndpointOptions {
  generation: string;
  pid: number;
  host: string;
  port: number;
  expectedExecutablePath: string;
  expectedEntrypointPath?: string;
  registryPath?: string;
  observe?: (target: RuntimeEndpointTarget) => Promise<RuntimeEndpointObservation>;
  probeHealth?: (record: RuntimeEndpointRecord) => Promise<unknown>;
}

export async function publishR8RuntimeEndpoint(
  options: PublishR8RuntimeEndpointOptions
): Promise<RuntimeEndpointRecord> {
  const publishOptions: PublishObservedRuntimeEndpointOptions = {
    role: R8_ROLE,
    generation: options.generation,
    pid: options.pid,
    host: options.host,
    port: options.port,
    expectedExecutablePath: options.expectedExecutablePath,
    expectedEntrypointPath:
      options.expectedEntrypointPath ?? options.expectedExecutablePath,
    expectedHealthServer: R8_HEALTH_SERVER,
    filePath: options.registryPath,
    observe: options.observe,
    probeHealth: options.probeHealth,
  };
  return publishObservedRuntimeEndpoint(publishOptions);
}
