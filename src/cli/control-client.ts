import fs from "node:fs/promises";
import net from "node:net";
import type { ControlMetadata } from "./control-server.js";
import { getDefaultControlMetadataPath } from "./control-server.js";

export interface ControlClientOptions {
  metadataPath?: string;
  requireInteractive?: boolean;
}

export interface ControlCommand {
  command: "jobs" | "approve" | "deny" | "admin-code";
  jobId?: string;
  refresh?: boolean;
}

export function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function readMetadata(metadataPath: string): Promise<ControlMetadata> {
  const raw = await fs.readFile(metadataPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<ControlMetadata>;
  if (
    typeof parsed.pipeName !== "string" ||
    typeof parsed.capability !== "string" ||
    typeof parsed.pid !== "number"
  ) {
    throw new Error("WinHelm local control metadata is invalid.");
  }
  return parsed as ControlMetadata;
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

  const metadata = await readMetadata(
    options.metadataPath ?? getDefaultControlMetadataPath()
  );

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(metadata.pipeName);
    socket.setEncoding("utf8");
    let buffer = "";

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
      try {
        const response = JSON.parse(buffer.trim());
        resolve(response);
      } catch (err) {
        reject(err);
      }
    });

    socket.on("error", reject);
  });
}
