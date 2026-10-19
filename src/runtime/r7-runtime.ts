import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import {
  bindInternalListener,
  readPreferredInternalPortForRole,
  writePreferredInternalPortForRole,
  type InternalPortSelection,
} from "./internal-port.js";
import {
  createRuntimeGeneration,
  publishCurrentRuntimeEndpoint,
  resolveVerifiedRuntimeEndpoint,
  type ResolveVerifiedRuntimeEndpointOptions,
  type RuntimeEndpointObservation,
  type RuntimeEndpointRecord,
  type RuntimeEndpointTarget,
  type VerifiedRuntimeEndpoint,
} from "./endpoint-registry.js";
import { isLoopbackHost } from "../utils/network-gate.js";

const R7_ROLE = "r7";
const R7_HEALTH_SERVER = "winhelm-r7";
const RUNTIME_GENERATION_HEADER = "x-winhelm-runtime-generation";

export interface R7BackendEndpoint {
  mode: "fixed" | "auto";
  host: string;
  port: number;
  generation?: string;
  pid?: number;
}

export interface ResolveR7CoreBackendOptions {
  selection: InternalPortSelection;
  host: string;
  expectedCoreExecutablePath?: string;
  expectedCoreEntrypointPath?: string;
  coreRegistryPath?: string;
  resolveVerified?: (
    options: ResolveVerifiedRuntimeEndpointOptions
  ) => Promise<VerifiedRuntimeEndpoint | undefined>;
}

export async function resolveR7CoreBackend(
  options: ResolveR7CoreBackendOptions
): Promise<R7BackendEndpoint> {
  if (!isLoopbackHost(options.host)) {
    throw new Error("R7 Core backend must remain on a loopback host.");
  }

  if (options.selection.mode === "fixed") {
    return {
      mode: "fixed",
      host: options.host,
      port: options.selection.port,
    };
  }

  if (!options.expectedCoreExecutablePath || !options.expectedCoreEntrypointPath) {
    throw new Error(
      "R7 Core auto discovery requires trusted Core executable and entrypoint paths."
    );
  }

  const resolver = options.resolveVerified ?? resolveVerifiedRuntimeEndpoint;
  const verified = await resolver({
    role: "core",
    expectedExecutablePath: options.expectedCoreExecutablePath,
    expectedEntrypointPath: options.expectedCoreEntrypointPath,
    filePath: options.coreRegistryPath,
  });
  if (!verified) {
    throw new Error("Verified Core runtime endpoint is unavailable.");
  }
  if (!isLoopbackHost(verified.host)) {
    throw new Error("Verified Core runtime endpoint is not loopback.");
  }

  return {
    mode: "auto",
    host: verified.host,
    port: verified.port,
    generation: verified.generation,
    pid: verified.pid,
  };
}

export interface R7RuntimeHealthIdentity {
  generation: string;
  pid: number;
}

function sendHiddenNotFound(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(404, {
    "content-length": "0",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end();
}

function sendRuntimeHealth(res: ServerResponse, identity: R7RuntimeHealthIdentity): void {
  const payload = Buffer.from(
    JSON.stringify({
      status: "ok",
      server: R7_HEALTH_SERVER,
      runtime: {
        role: R7_ROLE,
        generation: identity.generation,
        pid: identity.pid,
      },
    }),
    "utf8"
  );
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function generationHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers[RUNTIME_GENERATION_HEADER];
  if (Array.isArray(raw)) return undefined;
  return typeof raw === "string" ? raw : undefined;
}

export function installR7RuntimeHealthRoute(
  server: Server,
  identity: R7RuntimeHealthIdentity
): void {
  const previous = server.listeners("request") as RequestListener[];
  server.removeAllListeners("request");

  server.on("request", (req, res) => {
    let pathname: string | undefined;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      pathname = undefined;
    }

    if (req.method === "GET" && pathname === "/health") {
      if (generationHeader(req) !== identity.generation) {
        sendHiddenNotFound(res);
        return;
      }
      sendRuntimeHealth(res, identity);
      return;
    }

    for (const listener of previous) {
      Reflect.apply(listener, server, [req, res]);
    }
  });
}

async function closeBoundServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export interface StartR7RuntimeOptions {
  listenerSelection: InternalPortSelection;
  listenerHost: string;
  preferredPort?: number;
  coreBackend: ResolveR7CoreBackendOptions;
  createServer: (backend: R7BackendEndpoint) => Server;
  expectedExecutablePath: string;
  expectedEntrypointPath: string;
  generation?: string;
  registryPath?: string;
  preferencePath?: string;
  observe?: (target: RuntimeEndpointTarget) => Promise<RuntimeEndpointObservation>;
  probeHealth?: (record: RuntimeEndpointRecord) => Promise<unknown>;
  onPreferenceWriteError?: (error: unknown) => void;
}

export interface StartedR7Runtime {
  server: Server;
  port: number;
  generation: string;
  backend: R7BackendEndpoint;
  registryRecord: RuntimeEndpointRecord;
}

export async function startR7Runtime(
  options: StartR7RuntimeOptions
): Promise<StartedR7Runtime> {
  if (!isLoopbackHost(options.listenerHost)) {
    throw new Error("R7 listener must remain on a loopback host.");
  }

  const backend = await resolveR7CoreBackend(options.coreBackend);
  const generation = options.generation ?? createRuntimeGeneration();
  const server = options.createServer(backend);
  installR7RuntimeHealthRoute(server, { generation, pid: process.pid });

  let bound: Awaited<ReturnType<typeof bindInternalListener>> | undefined;
  try {
    const preferredPort =
      options.preferredPort ??
      (options.listenerSelection.mode === "auto"
        ? readPreferredInternalPortForRole(R7_ROLE, options.preferencePath)
        : undefined);

    bound = await bindInternalListener({
      selection: options.listenerSelection,
      host: options.listenerHost,
      preferredPort,
      listen: (port, host) => {
        server.listen(port, host);
        return server;
      },
    });

    const registryRecord = await publishCurrentRuntimeEndpoint({
      role: R7_ROLE,
      generation,
      host: options.listenerHost,
      port: bound.port,
      expectedExecutablePath: options.expectedExecutablePath,
      expectedEntrypointPath: options.expectedEntrypointPath,
      expectedHealthServer: R7_HEALTH_SERVER,
      filePath: options.registryPath,
      observe: options.observe,
      probeHealth: options.probeHealth,
    });

    if (options.listenerSelection.mode === "auto") {
      try {
        await writePreferredInternalPortForRole(
          R7_ROLE,
          bound.port,
          options.preferencePath
        );
      } catch (error) {
        options.onPreferenceWriteError?.(error);
      }
    }

    return {
      server: bound.server,
      port: bound.port,
      generation,
      backend,
      registryRecord,
    };
  } catch (error) {
    if (bound?.server.listening || server.listening) {
      await closeBoundServer(bound?.server ?? server).catch(() => {});
    }
    throw error;
  }
}
