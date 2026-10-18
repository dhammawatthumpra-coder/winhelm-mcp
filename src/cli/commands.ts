import { hasInteractiveTerminal } from "./control-client.js";
import {
  sendControlCommand,
  type ControlCommand,
} from "./control-client.js";
import {
  decideSharedApprovalJob,
  listSharedApprovalJobs,
} from "./decision-cli.js";
import {
  executeNativeDecision,
  parseApprovalProtocolUri,
} from "../approval/decision-activator.js";

export const CONTROL_CLI_COMMANDS = new Set([
  "status",
  "jobs",
  "approve",
  "deny",
  "admin-code",
  "approval-activate",
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

    if (command === "approval-activate") {
      let jobId: string | undefined;
      let decision: "approved" | "denied" | undefined;
      let token: string | undefined;

      let parsedJournal: string | undefined;

      const rawArg = args[1] || "";
      if (rawArg.startsWith("winhelm-approval:")) {
        const parsed = parseApprovalProtocolUri(rawArg);
        jobId = parsed.jobId;
        decision = parsed.decision;
        token = parsed.token;
        parsedJournal = parsed.journalPath;
      } else {
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--job" && args[i + 1]) {
            jobId = args[++i];
          } else if (args[i].startsWith("--job=")) {
            jobId = args[i].slice(6);
          } else if (args[i] === "--decision" && args[i + 1]) {
            const d = args[++i];
            if (d === "approved" || d === "denied") decision = d;
          } else if (args[i].startsWith("--decision=")) {
            const d = args[i].slice(11);
            if (d === "approved" || d === "denied") decision = d;
          } else if (args[i] === "--token" && args[i + 1]) {
            token = args[++i];
          } else if (args[i].startsWith("--token=")) {
            token = args[i].slice(8);
          } else if (args[i] === "--journal" && args[i + 1]) {
            parsedJournal = args[++i];
          } else if (args[i].startsWith("--journal=")) {
            parsedJournal = args[i].slice(10);
          } else if (!jobId && args[i].startsWith("job_")) {
            jobId = args[i];
          } else if (!decision && (args[i] === "approved" || args[i] === "denied")) {
            decision = args[i] as "approved" | "denied";
          }
        }
      }

      if (!jobId || !decision || !token) {
        return {
          handled: true,
          exitCode: 2,
          error:
            "Usage: winhelm approval-activate --job <jobId> --decision <approved|denied> --token <token> OR winhelm approval-activate <protocol-uri>",
        };
      }

      const outcome = await executeNativeDecision(jobId, decision, token, {
        channel: "native_toast",
        notifyOutcome: false,
        journalPath: parsedJournal,
      });

      if (!outcome.ok) {
        return {
          handled: true,
          exitCode: 1,
          error: outcome.message || outcome.code || "Activation failed",
        };
      }

      return {
        handled: true,
        exitCode: 0,
        output: `${decision === "approved" ? "Approved" : "Denied"} ${jobId} (${outcome.state})`,
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
