import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createR8TlsHealthProbe,
  resolveInternalPortLaunchPlan,
  resolveVerifiedInternalTopology,
} from "../../../dist/runtime/launcher-contract.js";
import {
  readConfig,
  toContractInput,
  toPaths,
} from "./start-runtime-chain.mjs";

function parseArgs(argv) {
  if (argv.length !== 1 || !argv[0].startsWith("--config=")) {
    throw new Error("Usage: runtime-diagnostics.mjs --config=<absolute path>");
  }
  return { config: argv[0].slice("--config=".length) };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await readConfig(path.resolve(args.config));
  const plan = resolveInternalPortLaunchPlan(toContractInput(config));

  if (plan.mode === "fixed") {
    process.stdout.write(
      JSON.stringify(
        {
          schema: 1,
          mode: "fixed",
          public: { scheme: "https", port: 443 },
          internal: {
            core: {
              state: "configured",
              source: "fixed_install_state",
              host: "127.0.0.1",
              port: plan.core.selector,
            },
            r7: {
              state: "configured",
              source: "fixed_install_state",
              host: "127.0.0.1",
              port: plan.r7.selector,
            },
            r8: {
              state: "configured",
              source: "fixed_install_state",
              host: "127.0.0.1",
              port: plan.r8.selector,
            },
          },
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  const launcherPaths = toPaths(config);
  const publicConfig = config.public;
  const publicHost = new URL(publicConfig.origin).hostname;
  const topology = await resolveVerifiedInternalTopology({
    core: {
      executablePath: launcherPaths.coreExecutable,
      entrypointPath: launcherPaths.coreEntrypoint,
      registryPath: launcherPaths.coreRegistry,
    },
    r7: {
      executablePath: launcherPaths.r7Executable,
      entrypointPath: launcherPaths.r7Entrypoint,
      registryPath: launcherPaths.r7Registry,
      expectedHealthServer: "winhelm-r7",
    },
    r8: {
      executablePath: launcherPaths.r8Binary,
      entrypointPath: launcherPaths.r8Binary,
      registryPath: launcherPaths.r8Registry,
      expectedHealthServer: "winhelm-r8",
      probeHealth: createR8TlsHealthProbe(publicHost),
    },
  });

  process.stdout.write(
    JSON.stringify(
      {
        ...topology,
        mode: "automatic",
      },
      null,
      2
    ) + "\n"
  );
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        event: "WINHELM_RUNTIME_DIAGNOSTICS_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }) + "\n"
    );
    process.exitCode = 1;
  });
}

export { main, parseArgs };
