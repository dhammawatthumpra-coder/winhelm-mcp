import {
  TunnelLifecycleError,
  getTunnelDoctor,
  getTunnelStatus,
  redactTunnelSecrets,
  restartManagedTunnel,
  saveTunnelLifecycleConfig,
  startManagedTunnel,
  stopManagedTunnel,
  type TunnelLifecycleConfig,
} from "../integrations/chatgpt-tunnel.js";

/**
 * M3A-P2 local CLI recovery surface for the ChatGPT/OpenAI Tunnel.
 * status/doctor are read-only; configure persists only non-secret lifecycle
 * settings; start/stop/restart delegate to the shared lifecycle service — the
 * same authority the Admin plane and Product Shell use.
 *
 * Note: this surface manages the ChatGPT/OpenAI Tunnel only. The Tailscale
 * Funnel / Serve remains an advanced, manually configured integration and is
 * intentionally not part of this lifecycle.
 */

const TUNNEL_USAGE = `
WinHelm tunnel — ChatGPT/OpenAI Tunnel lifecycle (local recovery surface)

Usage:
  winhelm tunnel status                  Show tunnel dependency/profile/backend/daemon state (read-only)
  winhelm tunnel doctor                  Run read-only readiness checks
  winhelm tunnel configure [options]     Persist non-secret lifecycle settings
  winhelm tunnel start                   Start a managed tunnel daemon
  winhelm tunnel stop                    Stop the WinHelm-managed tunnel daemon
  winhelm tunnel restart                 Restart via stop + start through the shared service

Configure options:
  --exe <path>          Tunnel-client executable path (required)
  --exe-arg <arg>       Extra argument passed before the tunnel-client subcommand (repeatable)
  --profile <path>      Tunnel-client profile/YAML path (required)
  --marker <path>       Active-backend marker path (optional; default <repo>\\temp\\winhelm.active-backend.json)
  --health-url <url>    Health base URL for external-daemon observation (optional)

Scope note:
  This command family manages the ChatGPT/OpenAI Tunnel only. The Tailscale
  Funnel / Serve is an advanced, manual integration and is not managed here.
  WinHelm never stops or restarts externally managed tunnel daemons.
`;

interface CliResult {
  handled: boolean;
  exitCode: number;
  output?: string;
  error?: string;
}

function getFlag(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}

function getFlagAll(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) {
      values.push(args[i + 1]);
    }
  }
  return values;
}

function errorJson(err: unknown): string {
  if (err instanceof TunnelLifecycleError) {
    return JSON.stringify(
      redactTunnelSecrets({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      }),
      null,
      2
    );
  }
  return JSON.stringify(
    {
      error: {
        code: "TUNNEL_INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    },
    null,
    2
  );
}

async function handleConfigure(args: string[]): Promise<CliResult> {
  const exe = getFlag(args, "--exe");
  const profile = getFlag(args, "--profile");
  const marker = getFlag(args, "--marker");
  const healthUrl = getFlag(args, "--health-url");
  const exeArgs = getFlagAll(args, "--exe-arg");

  if (!exe) {
    return {
      handled: true,
      exitCode: 2,
      error: "winhelm tunnel configure requires --exe <path>",
    };
  }
  if (!profile) {
    return {
      handled: true,
      exitCode: 2,
      error: "winhelm tunnel configure requires --profile <path>",
    };
  }

  const patch: Partial<Omit<TunnelLifecycleConfig, "schemaVersion">> = {
    executablePath: exe,
    profilePath: profile,
  };
  if (exeArgs.length > 0) patch.executableArgs = exeArgs;
  if (marker !== undefined) patch.markerPath = marker;
  if (healthUrl !== undefined) patch.healthUrl = healthUrl;

  const saved = await saveTunnelLifecycleConfig(patch);
  return {
    handled: true,
    exitCode: 0,
    output: JSON.stringify(redactTunnelSecrets(saved), null, 2),
  };
}

export async function runTunnelCliCommand(args: string[]): Promise<CliResult> {
  if (args[0] !== "tunnel") {
    return { handled: false, exitCode: 0 };
  }
  const sub = args[1];
  try {
    switch (sub) {
      case undefined:
      case "--help":
      case "-h":
        return { handled: true, exitCode: sub === undefined ? 2 : 0, output: TUNNEL_USAGE };
      case "status": {
        const status = await getTunnelStatus();
        return {
          handled: true,
          exitCode: 0,
          output: JSON.stringify(redactTunnelSecrets(status), null, 2),
        };
      }
      case "doctor": {
        const doctor = await getTunnelDoctor();
        return {
          handled: true,
          exitCode: 0,
          output: JSON.stringify(redactTunnelSecrets(doctor), null, 2),
        };
      }
      case "configure":
        return await handleConfigure(args.slice(2));
      case "start": {
        const status = await startManagedTunnel();
        return {
          handled: true,
          exitCode: 0,
          output: JSON.stringify(redactTunnelSecrets(status), null, 2),
        };
      }
      case "stop": {
        const status = await stopManagedTunnel();
        return {
          handled: true,
          exitCode: 0,
          output: JSON.stringify(redactTunnelSecrets(status), null, 2),
        };
      }
      case "restart": {
        const status = await restartManagedTunnel();
        return {
          handled: true,
          exitCode: 0,
          output: JSON.stringify(redactTunnelSecrets(status), null, 2),
        };
      }
      default:
        return {
          handled: true,
          exitCode: 2,
          error: `Unknown tunnel subcommand: ${sub}\n${TUNNEL_USAGE}`,
        };
    }
  } catch (err) {
    return { handled: true, exitCode: 1, error: errorJson(err) };
  }
}
