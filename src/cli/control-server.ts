import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getApprovalEngine } from "../approval/runtime.js";
import { getAdminAuthManager } from "../admin/runtime.js";
import { buildRuntimeStatusSnapshot } from "../status/runtime-status.js";

export interface ControlServerOptions {
  metadataPath?: string;
  pipeName?: string;
}

export interface ControlMetadata {
  pipeName: string;
  capability: string;
  pid: number;
  createdAt: string;
}

interface ControlRequest {
  capability?: string;
  command?: string;
  jobId?: string;
  refresh?: boolean;
}

function defaultMetadataPath(): string {
  const override = process.env.WINHELM_CONTROL_METADATA_PATH;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".winhelm", "control.json");
}

function defaultPipeName(): string {
  return `\\\\.\\pipe\\winhelm-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function responseLine(payload: unknown): string {
  return JSON.stringify(payload) + "\n";
}

export class LocalControlServer {
  private readonly metadataPath: string;
  private readonly pipeName: string;
  private readonly capability = crypto.randomBytes(32).toString("base64url");
  private server?: net.Server;

  constructor(options: ControlServerOptions = {}) {
    this.metadataPath = options.metadataPath ?? defaultMetadataPath();
    this.pipeName = options.pipeName ?? defaultPipeName();
  }

  async start(): Promise<ControlMetadata> {
    if (this.server) {
      return this.metadata();
    }

    await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });

    this.server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      let totalBytes = 0;
      const MAX_REQUEST_BYTES = 64 * 1024;

      socket.on("data", (chunk: string) => {
        totalBytes += Buffer.byteLength(chunk, "utf8");
        if (totalBytes > MAX_REQUEST_BYTES) {
          socket.end(responseLine({
            ok: false,
            error: { code: "LIMIT_EXCEEDED", message: "Control request is too large." },
          }));
          return;
        }

        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.handleLine(line)
          .then((payload) => socket.end(responseLine(payload)))
          .catch((err) =>
            socket.end(
              responseLine({
                ok: false,
                error: {
                  code: "INTERNAL_ERROR",
                  message: (err as Error).message || String(err),
                },
              })
            )
          );
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.pipeName, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    const metadata = this.metadata();
    await fs.writeFile(
      this.metadataPath,
      JSON.stringify(metadata, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );

    return metadata;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;

    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await fs.rm(this.metadataPath, { force: true }).catch(() => {});
  }

  private metadata(): ControlMetadata {
    return {
      pipeName: this.pipeName,
      capability: this.capability,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
  }

  private async handleLine(line: string): Promise<unknown> {
    let request: ControlRequest;
    try {
      request = JSON.parse(line);
    } catch {
      return {
        ok: false,
        error: { code: "INVALID_ARGUMENT", message: "Control request must be valid JSON." },
      };
    }

    if (
      typeof request.capability !== "string" ||
      !safeEqual(request.capability, this.capability)
    ) {
      return {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Invalid local control capability." },
      };
    }

    switch (request.command) {
      case "status":
        return { ok: true, status: buildRuntimeStatusSnapshot() };

      case "jobs":
        return { ok: true, jobs: getApprovalEngine().list() };

      case "approve": {
        if (!request.jobId) {
          return {
            ok: false,
            error: { code: "INVALID_ARGUMENT", message: "jobId is required." },
          };
        }
        const outcome = getApprovalEngine().approve(request.jobId, "cli");
        return outcome.ok
          ? { ok: true, job: outcome.job }
          : { ok: false, error: { code: outcome.code, status: outcome.status } };
      }

      case "deny": {
        if (!request.jobId) {
          return {
            ok: false,
            error: { code: "INVALID_ARGUMENT", message: "jobId is required." },
          };
        }
        const outcome = getApprovalEngine().deny(request.jobId, "cli");
        return outcome.ok
          ? { ok: true, job: outcome.job }
          : { ok: false, error: { code: outcome.code, status: outcome.status } };
      }

      case "admin-code": {
        const issued = request.refresh
          ? getAdminAuthManager().refreshCode()
          : getAdminAuthManager().issueCode();
        return {
          ok: true,
          code: issued.code,
          expiresAt: issued.expiresAt,
        };
      }

      default:
        return {
          ok: false,
          error: { code: "INVALID_ARGUMENT", message: "Unknown local control command." },
        };
    }
  }
}

export function getDefaultControlMetadataPath(): string {
  return defaultMetadataPath();
}
