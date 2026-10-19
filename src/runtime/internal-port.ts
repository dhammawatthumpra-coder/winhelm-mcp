import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteUtf8 } from "../config/atomic-write.js";
import { isLoopbackHost } from "../utils/network-gate.js";

const CORE_ROLE = "core";

function validateRuntimeRole(role: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(role)) {
    throw new Error(`Invalid WinHelm runtime role: ${role}`);
  }
  return role;
}

export function defaultInternalPortPreferencePath(role: string = CORE_ROLE): string {
  const safeRole = validateRuntimeRole(role);
  return path.join(
    os.homedir(),
    ".winhelm",
    "runtime",
    "preferences",
    `${safeRole}.json`
  );
}

export function readPreferredInternalPortForRole(
  role: string,
  filePath: string = defaultInternalPortPreferencePath(role)
): number | undefined {
  const safeRole = validateRuntimeRole(role);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      schemaVersion?: unknown;
      role?: unknown;
      preferredPort?: unknown;
    };
    if (parsed.schemaVersion !== 1 || parsed.role !== safeRole) return undefined;
    if (
      typeof parsed.preferredPort !== "number" ||
      !Number.isInteger(parsed.preferredPort) ||
      parsed.preferredPort < 1 ||
      parsed.preferredPort > 65535
    ) {
      return undefined;
    }
    return parsed.preferredPort;
  } catch {
    return undefined;
  }
}

export async function writePreferredInternalPortForRole(
  role: string,
  port: number,
  filePath: string = defaultInternalPortPreferencePath(role)
): Promise<void> {
  const safeRole = validateRuntimeRole(role);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid preferred WinHelm port: ${port}`);
  }

  await atomicWriteUtf8(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        role: safeRole,
        preferredPort: port,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
}

export function readPreferredInternalPort(
  filePath: string = defaultInternalPortPreferencePath()
): number | undefined {
  return readPreferredInternalPortForRole(CORE_ROLE, filePath);
}

export async function writePreferredInternalPort(
  port: number,
  filePath: string = defaultInternalPortPreferencePath()
): Promise<void> {
  await writePreferredInternalPortForRole(CORE_ROLE, port, filePath);
}

export type InternalPortSelection =
  | { mode: "fixed"; port: number }
  | { mode: "auto" };

export interface ResolveInternalPortSelectionInput {
  cliPort?: string;
  envPort?: string;
  host: string;
  defaultPort?: number;
}

function parseFixedPort(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid WinHelm port: "${value}"`);
  }

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WinHelm port: "${value}"`);
  }
  return port;
}

export interface BindInternalListenerInput {
  selection: InternalPortSelection;
  host: string;
  preferredPort?: number;
  listen: (port: number, host: string) => Server;
}

export interface BoundInternalListener {
  server: Server;
  port: number;
}

function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    server.once("listening", onListening);
    server.once("error", onError);
  });
}

async function bindOnce(
  listen: (port: number, host: string) => Server,
  port: number,
  host: string
): Promise<BoundInternalListener> {
  const server = listen(port, host);
  await waitForListening(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
    throw new Error("Bound WinHelm listener did not report an IP port.");
  }

  return { server, port: address.port };
}

export async function bindInternalListener(
  input: BindInternalListenerInput
): Promise<BoundInternalListener> {
  if (input.selection.mode === "auto" && !isLoopbackHost(input.host)) {
    throw new Error("Automatic internal port allocation requires a loopback host.");
  }

  if (input.selection.mode === "fixed") {
    return bindOnce(input.listen, input.selection.port, input.host);
  }

  if (
    input.preferredPort !== undefined &&
    Number.isInteger(input.preferredPort) &&
    input.preferredPort >= 1 &&
    input.preferredPort <= 65535
  ) {
    try {
      return await bindOnce(input.listen, input.preferredPort, input.host);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw err;
      }
    }
  }

  return bindOnce(input.listen, 0, input.host);
}

export function resolveInternalPortSelection(
  input: ResolveInternalPortSelectionInput
): InternalPortSelection {
  const raw =
    input.cliPort !== undefined
      ? input.cliPort
      : input.envPort !== undefined && input.envPort !== ""
        ? input.envPort
        : String(input.defaultPort ?? 8788);

  if (raw.trim().toLowerCase() === "auto") {
    if (!isLoopbackHost(input.host)) {
      throw new Error("Automatic internal port allocation requires a loopback host.");
    }
    return { mode: "auto" };
  }

  return { mode: "fixed", port: parseFixedPort(raw) };
}
