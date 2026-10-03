import {
  sendControlCommand,
  type ControlCommand,
} from "./control-client.js";

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
    let request: ControlCommand;
    let requireInteractive = false;

    switch (command) {
      case "status":
        request = { command: "status" };
        break;

      case "jobs":
        request = { command: "jobs" };
        break;

      case "approve": {
        const jobId = args[1];
        if (!jobId) {
          return {
            handled: true,
            exitCode: 2,
            error: "Usage: winhelm approve <jobId>",
          };
        }
        requireInteractive = true;
        request = { command: "approve", jobId };
        break;
      }

      case "deny": {
        const jobId = args[1];
        if (!jobId) {
          return {
            handled: true,
            exitCode: 2,
            error: "Usage: winhelm deny <jobId>",
          };
        }
        requireInteractive = true;
        request = { command: "deny", jobId };
        break;
      }

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

    if (command === "jobs") {
      return {
        handled: true,
        exitCode: 0,
        output: formatJobs(Array.isArray(response.jobs) ? response.jobs : []),
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
      output:
        (command === "approve" ? "Approved " : "Denied ") +
        response.job.id +
        " (" +
        response.job.state +
        ")",
    };
  } catch (err) {
    return {
      handled: true,
      exitCode: 1,
      error: (err as Error).message || String(err),
    };
  }
}
