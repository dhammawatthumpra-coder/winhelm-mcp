import { hasInteractiveTerminal } from "./control-client.js";
import {
  sendControlCommand,
  type ControlCommand,
} from "./control-client.js";
import {
  decideSharedApprovalJob,
  listSharedApprovalJobs,
} from "./decision-cli.js";

export const CONTROL_CLI_COMMANDS = new Set([
  "status",
  "jobs",
  "approve",
  "deny",
  "admin-code",
]);

export interface ControlCliResult {
  handled: boolean;
  exitCode: number;
  output?: string;
  error?: string;
}

function formatJobs(jobs: any[]): string {
  if (jobs.length === 0) return "No approval jobs.";

  return jobs
    .map((job) => {
      const expires = new Date(job.expiresAt).toISOString();
      return [
        job.id,
        job.state,
        job.tool,
        "session=" + String(job.sessionId).slice(0, 8),
        "expires=" + expires,
      ].join("\t");
    })
    .join("\n");
}

export async function runControlCliCommand(
  args: string[]
): Promise<ControlCliResult> {
  const command = args[0];
  if (!command || !CONTROL_CLI_COMMANDS.has(command)) {
    return { handled: false, exitCode: 0 };
  }

  try {
    // DEF-02a: approval listing and decisions no longer route through the
    // single-slot control pipe. Jobs are listed from the shared durable
    // state and decisions are recorded as per-job files that the owning
    // process consumes, so every active WinHelm instance is reachable.
    if (command === "jobs") {
      const listing = listSharedApprovalJobs();
      return {
        handled: true,
        exitCode: 0,
        output: formatJobs(listing),
      };
    }

    if (command === "approve" || command === "deny") {
      const jobId = args[1];
      if (!jobId) {
        return {
          handled: true,
          exitCode: 2,
          error: `Usage: winhelm ${command} <jobId>`,
        };
      }
      // Human-in-the-loop gate stays: decisions require an interactive
      // local terminal.
      if (!hasInteractiveTerminal()) {
        return {
          handled: true,
          exitCode: 1,
          error: "This WinHelm command requires an interactive local terminal.",
        };
      }
      const outcome = await decideSharedApprovalJob(
        jobId,
        command === "approve" ? "approved" : "denied",
        "cli"
      );
      if (!outcome.ok) {
        return {
          handled: true,
          exitCode: 1,
          error: outcome.message,
        };
      }
      return {
        handled: true,
        exitCode: 0,
        output:
          (command === "approve" ? "Approved " : "Denied ") +
          jobId +
          " (" +
          outcome.state +
          ")",
      };
    }

    let request: ControlCommand;
    let requireInteractive = false;

    switch (command) {
      case "status":
        request = { command: "status" };
        break;

      case "admin-code":
        requireInteractive = true;
        request = {
          command: "admin-code",
          refresh: args.includes("--refresh"),
        };
        break;

      default:
        return { handled: false, exitCode: 0 };
    }

    const response = await sendControlCommand(request, {
      requireInteractive,
    });

    if (!response?.ok) {
      return {
        handled: true,
        exitCode: 1,
        error:
          response?.error?.message ??
          response?.error?.code ??
          "WinHelm local control request failed.",
      };
    }

    if (command === "status") {
      return {
        handled: true,
        exitCode: 0,
        output: JSON.stringify(response.status ?? {}, null, 2),
      };
    }

    if (command === "admin-code") {
      return {
        handled: true,
        exitCode: 0,
        output: [
          "Admin code: " + response.code,
          "Expires: " + new Date(response.expiresAt).toISOString(),
          "This code is single-use. Do not paste it into an AI chat.",
        ].join("\n"),
      };
    }

    return {
      handled: true,
      exitCode: 0,
      output: "OK",
    };
  } catch (err) {
    return {
      handled: true,
      exitCode: 1,
      error: (err as Error).message || String(err),
    };
  }
}
