import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildRuntimeChainProcessSpecs,
  createR8TlsHealthProbe,
  launchRuntimeChain,
  resolveInternalPortLaunchPlan,
} from "../../../dist/runtime/launcher-contract.js";
import {
  defaultRuntimeEndpointPath,
  observeWindowsRuntimeEndpoint,
  resolveVerifiedRuntimeEndpoint,
} from "../../../dist/runtime/endpoint-registry.js";

function parseArgs(argv) {
  const result = { planOnly: false };
  for (const arg of argv) {
    if (arg === "--plan-only") {
      result.planOnly = true;
      continue;
    }
    const match = /^--config=(.+)$/.exec(arg);
    if (match) {
      result.config = match[1];
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  if (!result.config) throw new Error("Missing --config=<absolute path>.");
  return result;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertNoSecretFields(value, pathLabel = "config") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|token|password|private.?key|admin.?code)/i.test(key)) {
      throw new Error(
        `Secret-bearing field is forbidden in launcher config: ${pathLabel}.${key}`
      );
    }
    assertNoSecretFields(child, `${pathLabel}.${key}`);
  }
}

function parseFixedPorts(value, label) {
  if (value === undefined) return undefined;
  const object = assertObject(value, label);
  return {
    core: object.core,
    r7: object.r7,
    r8: object.r8,
  };
}

function sanitizePlan(plan, specs) {
  return {
    schema: 1,
    event: "WINHELM_RUNTIME_CHAIN_PLAN",
    mode: plan.mode,
    installationKind: plan.installationKind,
    migration: plan.migration,
    requiresUserPortInput: plan.requiresUserPortInput,
    public: plan.public,
    internal: {
      core: { selector: plan.core.selector, discovery: plan.core.discovery },
      r7: { selector: plan.r7.selector, discovery: plan.r7.discovery },
      r8: { selector: plan.r8.selector, discovery: plan.r8.discovery },
    },
    processes: specs.map((spec) => ({
      role: spec.role,
      executable: spec.executable,
      cwd: spec.cwd,
    })),
    sensitiveValuesPersisted: false,
  };
}

async function readConfig(filePath) {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Launcher config path must be absolute.");
  }
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  assertNoSecretFields(parsed);
  const config = assertObject(parsed, "config");
  if (config.schema !== 1) throw new Error("Launcher config schema must be 1.");
  return config;
}

function toContractInput(config) {
  const installation = assertObject(config.installation, "installation");
  const internalPorts = assertObject(config.internalPorts, "internalPorts");
  return {
    installationKind: installation.kind,
    requestedMode: internalPorts.mode,
    existingMode: installation.existingMode,
    existingFixedPorts: parseFixedPorts(
      installation.existingFixedPorts,
      "installation.existingFixedPorts"
    ),
    requestedFixedPorts: parseFixedPorts(
      internalPorts.fixedPorts,
      "internalPorts.fixedPorts"
    ),
    explicitModeChange: internalPorts.explicitModeChange === true,
  };
}

function toPaths(config) {
  const paths = assertObject(config.paths, "paths");
  const oauth = assertObject(config.oauth, "oauth");
  const publicConfig = assertObject(config.public, "public");
  const coreRegistry =
    paths.coreRegistry ?? defaultRuntimeEndpointPath("core");
  const expectedDefaultCoreRegistry = defaultRuntimeEndpointPath("core");
  if (path.resolve(coreRegistry) !== path.resolve(expectedDefaultCoreRegistry)) {
    throw new Error(
      "Core registry path must match the Core default runtime registry; Core does not accept a custom registry path."
    );
  }

  return {
    coreExecutable: assertString(paths.coreExecutable, "paths.coreExecutable"),
    coreEntrypoint: assertString(paths.coreEntrypoint, "paths.coreEntrypoint"),
    coreConfig:
      typeof paths.coreConfig === "string" && paths.coreConfig.trim()
        ? paths.coreConfig
        : undefined,
    r7Executable: assertString(paths.r7Executable, "paths.r7Executable"),
    r7Entrypoint: assertString(paths.r7Entrypoint, "paths.r7Entrypoint"),
    r7SourceRoot: assertString(paths.r7SourceRoot, "paths.r7SourceRoot"),
    r7Store: assertString(paths.r7Store, "paths.r7Store"),
    r7Receipt: assertString(paths.r7Receipt, "paths.r7Receipt"),
    r7Origin: assertString(publicConfig.origin, "public.origin"),
    r7ClientId: assertString(oauth.clientId, "oauth.clientId"),
    r7RedirectUri: assertString(oauth.redirectUri, "oauth.redirectUri"),
    r8SupervisorExecutable: assertString(
      paths.r8SupervisorExecutable,
      "paths.r8SupervisorExecutable"
    ),
    r8SupervisorEntrypoint: assertString(
      paths.r8SupervisorEntrypoint,
      "paths.r8SupervisorEntrypoint"
    ),
    r8Binary: assertString(paths.r8Binary, "paths.r8Binary"),
    r8ConfigTemplate: assertString(
      paths.r8ConfigTemplate,
      "paths.r8ConfigTemplate"
    ),
    r8RuntimeConfig: assertString(
      paths.r8RuntimeConfig,
      "paths.r8RuntimeConfig"
    ),
    coreRegistry,
    r7Registry: assertString(paths.r7Registry, "paths.r7Registry"),
    r8Registry: assertString(paths.r8Registry, "paths.r8Registry"),
    r7Preference:
      typeof paths.r7Preference === "string" ? paths.r7Preference : undefined,
    r8Preference:
      typeof paths.r8Preference === "string" ? paths.r8Preference : undefined,
  };
}

function healthOk(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        method: "GET",
        path: "/health",
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 64 * 1024) body += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(res.statusCode === 200 && parsed?.status === "ok");
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.once("error", () => resolve(false));
    req.end();
  });
}

function createChild(spec) {
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    windowsHide: true,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  let exitResult;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });

  return {
    role: spec.role,
    pid: child.pid,
    exited,
    get exitResult() {
      return exitResult;
    },
    async stop() {
      if (exitResult) return;
      child.kill();
      const timer = new Promise((resolve) => setTimeout(resolve, 3000, "timeout"));
      if ((await Promise.race([exited, timer])) === "timeout" && !exitResult) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

async function waitUntil(label, check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const detail =
    lastError instanceof Error && lastError.message ? `: ${lastError.message}` : "";
  throw new Error(`${label} did not reach verified readiness${detail}`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const configPath = path.resolve(args.config);
  const config = await readConfig(configPath);
  const plan = resolveInternalPortLaunchPlan(toContractInput(config));
  const launcherPaths = toPaths(config);
  const specs = buildRuntimeChainProcessSpecs(plan, launcherPaths);

  if (args.planOnly) {
    process.stdout.write(JSON.stringify(sanitizePlan(plan, specs), null, 2) + "\n");
    return;
  }

  if (!process.env.WINHELM_R7_ISOLATED_GEMINI_CLIENT_SECRET) {
    throw new Error(
      "WINHELM_R7_ISOLATED_GEMINI_CLIENT_SECRET must be supplied ephemerally in the environment."
    );
  }

  const publicConfig = assertObject(config.public, "public");
  const expectedPublicHost = new URL(
    assertString(publicConfig.origin, "public.origin")
  ).hostname;
  const childByRole = new Map();

  const started = await launchRuntimeChain({
    specs,
    spawn: async (spec) => {
      const child = createChild(spec);
      if (!child.pid) throw new Error(`${spec.role} process did not expose a PID.`);
      childByRole.set(spec.role, child);
      child.exited.then((result) => {
        if (result?.code && result.code !== 0) {
          process.stderr.write(
            JSON.stringify({
              event: "runtime_component_exited",
              role: spec.role,
              code: result.code,
            }) + "\n"
          );
        }
      });
      return child;
    },
    waitReady: async (role) => {
      if (role === "core" && plan.mode === "fixed") {
        const child = childByRole.get("core");
        await waitUntil("Fixed Core", async () => {
          if (child.exitResult) return false;
          const observation = await observeWindowsRuntimeEndpoint({
            pid: child.pid,
            host: "127.0.0.1",
            port: plan.core.selector,
          });
          const ownsListener = observation.listeners.some(
            (listener) =>
              listener.owningPid === child.pid &&
              listener.port === plan.core.selector
          );
          return ownsListener &&
            (await healthOk("127.0.0.1", plan.core.selector))
            ? true
            : false;
        });
        return;
      }

      if (role === "core") {
        await waitUntil("Core", () =>
          resolveVerifiedRuntimeEndpoint({
            role: "core",
            expectedExecutablePath: launcherPaths.coreExecutable,
            expectedEntrypointPath: launcherPaths.coreEntrypoint,
            filePath: launcherPaths.coreRegistry,
          })
        );
        return;
      }

      if (role === "r7") {
        await waitUntil("R7", () =>
          resolveVerifiedRuntimeEndpoint({
            role: "r7",
            expectedExecutablePath: launcherPaths.r7Executable,
            expectedEntrypointPath: launcherPaths.r7Entrypoint,
            expectedHealthServer: "winhelm-r7",
            filePath: launcherPaths.r7Registry,
          })
        );
        return;
      }

      await waitUntil("R8", () =>
        resolveVerifiedRuntimeEndpoint({
          role: "r8",
          expectedExecutablePath: launcherPaths.r8Binary,
          expectedEntrypointPath: launcherPaths.r8Binary,
          expectedHealthServer: "winhelm-r8",
          filePath: launcherPaths.r8Registry,
          probeHealth: createR8TlsHealthProbe(expectedPublicHost),
        })
      );
    },
  });

  process.stdout.write(
    JSON.stringify({
      event: "WINHELM_RUNTIME_CHAIN_READY",
      mode: plan.mode,
      publicPort: 443,
      publicRoute: "inactive",
      internalPortsUserSelected: plan.requiresUserPortInput,
      roles: ["core", "r7", "r8"],
    }) + "\n"
  );

  let stopping = false;
  const stopAll = async () => {
    if (stopping) return;
    stopping = true;
    for (const child of [...started].reverse()) {
      await child.stop().catch(() => {});
    }
  };
  process.once("SIGINT", () => void stopAll());
  process.once("SIGTERM", () => void stopAll());

  await Promise.race(started.map((child) => child.exited));
  await stopAll();
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        event: "WINHELM_RUNTIME_CHAIN_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }) + "\n"
    );
    process.exitCode = 1;
  });
}

export { main, parseArgs, readConfig, sanitizePlan, toContractInput, toPaths };
