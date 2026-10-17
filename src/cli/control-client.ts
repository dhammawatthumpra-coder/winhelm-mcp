import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  getControlRegistryDir,
  getDefaultControlMetadataPath,
  type ControlMetadata,
} from "./control-server.js";
import { isProcessAlive } from "../approval/cross-process.js";

export interface ControlClientOptions {
  metadataPath?: string;
  requireInteractive?: boolean;
  connectTimeoutMs?: number;
}

export interface ControlCommand {
  command: "status" | "jobs" | "approve" | "deny" | "admin-code";
  jobId?: string;
  refresh?: boolean;
}

export function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function parseMetadata(
  raw: string,
  options: { requireInstanceId?: boolean } = {}
): ControlMetadata {
  const parsed = JSON.parse(raw) as Partial<ControlMetadata>;
  const createdAtMs =
    typeof parsed.createdAt === "string"
      ? Date.parse(parsed.createdAt)
      : Number.NaN;
  const hasValidInstanceId =
    typeof parsed.instanceId === "string" &&
    parsed.instanceId.trim().length > 0;

  if (
    typeof parsed.pipeName !== "string" ||
    parsed.pipeName.trim().length === 0 ||
    typeof parsed.capability !== "string" ||
    parsed.capability.trim().length === 0 ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(createdAtMs) ||
    (options.requireInstanceId === true && !hasValidInstanceId) ||
    (parsed.instanceId !== undefined && !hasValidInstanceId)
  ) {
    throw new Error("WinHelm local control metadata is invalid.");
  }
  return parsed as ControlMetadata;
}

async function tryReadMetadata(
  metadataPath: string,
  options: { requireInstanceId?: boolean } = {}
): Promise<ControlMetadata | undefined> {
  try {
    return parseMetadata(
      await fs.readFile(metadataPath, "utf8"),
      options
    );
  } catch {
    return undefined;
  }
}

function metadataKey(metadata: ControlMetadata): string {
  return (
    metadata.instanceId ??
    `${metadata.pid}\n${metadata.pipeName}\n${metadata.capability}`
  );
}

async function readRegistryMetadata(
  metadataPath: string
): Promise<ControlMetadata[]> {
  const registryDir = getControlRegistryDir(metadataPath);
  let entries;
  try {
    entries = await fs.readdir(registryDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: ControlMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    const record = await tryReadMetadata(
      path.join(registryDir, entry.name),
      { requireInstanceId: true }
    ).catch(() => undefined);
    if (!record?.instanceId) continue;

    const expectedName =
      crypto
        .createHash("sha256")
        .update(record.instanceId, "utf8")
        .digest("hex") + ".json";
    if (entry.name !== expectedName) continue;

    records.push(record);
  }

  records.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    return (Number.isFinite(rightTime) ? rightTime : 0) -
      (Number.isFinite(leftTime) ? leftTime : 0);
  });
  return records;
}

async function loadMetadataCandidates(
  metadataPath: string
): Promise<ControlMetadata[]> {
  const candidates: ControlMetadata[] = [];
  const seen = new Set<string>();

  const primary = await tryReadMetadata(metadataPath);
  if (primary) {
    candidates.push(primary);
    seen.add(metadataKey(primary));
  }

  for (const record of await readRegistryMetadata(metadataPath)) {
    const key = metadataKey(record);
    if (seen.has(key)) continue;
    candidates.push(record);
    seen.add(key);
  }

  return candidates;
}

function isRetryableTransportError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT"
  );
}

async function sendToMetadata(
  metadata: ControlMetadata,
  command: ControlCommand,
  timeoutMs: number
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(metadata.pipeName);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let buffer = "";
    let settled = false;

    const finishReject = (err: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          capability: metadata.capability,
          ...command,
        }) + "\n"
      );
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });

    socket.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const response = JSON.parse(buffer.trim());
        resolve(response);
      } catch (err) {
        reject(err);
      }
    });

    socket.on("timeout", () => {
      const err = new Error(
        `Timed out connecting to WinHelm local control owner PID ${metadata.pid}.`
      ) as Error & { code?: string };
      err.code = "ETIMEDOUT";
      finishReject(err);
    });

    socket.on("error", (err) => {
      finishReject(err as Error & { code?: string });
    });
  });
}

export async function sendControlCommand(
  command: ControlCommand,
  options: ControlClientOptions = {}
): Promise<any> {
  if (options.requireInteractive === true && !hasInteractiveTerminal()) {
    throw new Error(
      "This WinHelm command requires an interactive local terminal."
    );
  }

  const metadataPath =
    options.metadataPath ?? getDefaultControlMetadataPath();
  const candidates = await loadMetadataCandidates(metadataPath);

  if (candidates.length === 0) {
    throw new Error(
      "No WinHelm local control metadata is available. Start an active WinHelm instance first."
    );
  }

  let lastTransportError: unknown;
  for (const metadata of candidates) {
    if (!isProcessAlive(metadata.pid)) {
      continue;
    }

    try {
      return await sendToMetadata(
        metadata,
        command,
        options.connectTimeoutMs ?? 2_000
      );
    } catch (err) {
      if (!isRetryableTransportError(err)) {
        throw err;
      }
      lastTransportError = err;
    }
  }

  const detail =
    lastTransportError instanceof Error
      ? ` Last transport error: ${lastTransportError.message}`
      : "";
  throw new Error(
    "No live WinHelm local control instance is reachable." + detail
  );
}
