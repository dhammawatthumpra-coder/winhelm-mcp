import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readPreferredInternalPortForRole,
  resolveInternalPortSelection,
  writePreferredInternalPortForRole,
} from "../../../dist/runtime/internal-port.js";
import {
  resolveR8R7Upstream,
  publishR8RuntimeEndpoint,
} from "../../../dist/runtime/r8-runtime.js";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z0-9-]+)=(.*)$/.exec(arg);
    if (!m) throw new Error(`Unsupported argument: ${arg}`);
    out[m[1]] = m[2];
  }
  return out;
}

function required(args, key) {
  const value = args[key];
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function parseReadyLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !value ||
    value.event !== "R8_DYNAMIC_RUNTIME_READY" ||
    typeof value.listener !== "string" ||
    typeof value.upstream !== "string" ||
    typeof value.generation !== "string" ||
    !Number.isInteger(value.pid)
  ) {
    return undefined;
  }
  return value;
}

function splitLoopbackListener(listener) {
  const m = /^127\.0\.0\.1:(\d{1,5})$/.exec(listener);
  if (!m) throw new Error("R8 ready listener is not an IPv4 loopback endpoint.");
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("R8 ready listener port is out of range.");
  }
  return { host: "127.0.0.1", port };
}

function probeR8TlsHealth(expectedPublicHost) {
  return async (record) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: record.host,
          port: record.port,
          servername: expectedPublicHost,
          method: "GET",
          path: "/health",
          headers: {
            "x-winhelm-runtime-generation": record.generation,
          },
          rejectUnauthorized: true,
          timeout: 3_000,
        },
        (res) => {
          const chunks = [];
          let total = 0;
          res.on("data", (chunk) => {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += b.length;
            if (total > 64 * 1024) {
              req.destroy(new Error("R8 health response exceeded limit."));
              return;
            }
            chunks.push(b);
          });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`R8 health returned HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks, total).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("R8 health probe timed out.")));
      req.on("error", reject);
      req.end();
    });
}

async function waitForR8Ready(child, generation, timeoutMs = 45_000) {
  let buffer = "";
  const deadline = setTimeout(() => {
    child.kill();
  }, timeoutMs);

  try {
    return await new Promise((resolve, reject) => {
      const onExit = (code, signal) => {
        reject(
          new Error(
            `R8 child exited before verified readiness: code=${code} signal=${signal ?? ""}`
          )
        );
      };
      child.once("exit", onExit);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const idx = buffer.indexOf("\n");
          if (idx < 0) break;
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const ready = parseReadyLine(line);
          if (!ready) {
            process.stdout.write(line + "\n");
            continue;
          }
          if (ready.generation !== generation || ready.pid !== child.pid) {
            reject(new Error("R8 ready event identity mismatch."));
            return;
          }
          child.off("exit", onExit);
          resolve(ready);
          return;
        }
      });
    });
  } finally {
    clearTimeout(deadline);
  }
}

async function generateRuntimeConfig({
  templatePath,
  outputPath,
  listenerSelection,
  preferredPort,
  upstream,
}) {
  const parsed = JSON.parse(await fs.readFile(templatePath, "utf8"));
  if (!parsed || parsed.version !== 1) {
    throw new Error("R8 config template must be version 1.");
  }

  parsed.upstream = `http://${upstream.host}:${upstream.port}`;
  if (listenerSelection.mode === "auto") {
    parsed.listen = "127.0.0.1:0";
    parsed.listenMode = "auto";
    if (preferredPort !== undefined) parsed.preferredPort = preferredPort;
    else delete parsed.preferredPort;
  } else {
    parsed.listen = `127.0.0.1:${listenerSelection.port}`;
    parsed.listenMode = "fixed";
    delete parsed.preferredPort;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const binary = path.resolve(required(args, "binary"));
  const configTemplate = path.resolve(required(args, "config-template"));
  const runtimeConfig = path.resolve(required(args, "runtime-config"));
  const r8Registry = args["r8-registry"]
    ? path.resolve(args["r8-registry"])
    : undefined;
  const r8Preference = args["r8-preference"]
    ? path.resolve(args["r8-preference"])
    : undefined;

  const listenerSelection = resolveInternalPortSelection({
    cliPort: required(args, "port"),
    host: "127.0.0.1",
    defaultPort: 19447,
  });
  const upstreamSelection = resolveInternalPortSelection({
    cliPort: required(args, "r7-port"),
    host: "127.0.0.1",
    defaultPort: 64239,
  });

  const upstream = await resolveR8R7Upstream({
    selection: upstreamSelection,
    host: "127.0.0.1",
    expectedR7ExecutablePath:
      upstreamSelection.mode === "auto" ? required(args, "r7-executable") : undefined,
    expectedR7EntrypointPath:
      upstreamSelection.mode === "auto" ? required(args, "r7-entrypoint") : undefined,
    r7RegistryPath:
      upstreamSelection.mode === "auto" && args["r7-registry"]
        ? path.resolve(args["r7-registry"])
        : undefined,
  });

  const preferredPort =
    listenerSelection.mode === "auto"
      ? readPreferredInternalPortForRole("r8", r8Preference)
      : undefined;

  const runtime = await generateRuntimeConfig({
    templatePath: configTemplate,
    outputPath: runtimeConfig,
    listenerSelection,
    preferredPort,
    upstream,
  });

  const expectedPublicHost = String(runtime.expectedPublicHost ?? "").trim().toLowerCase();
  if (!expectedPublicHost) {
    throw new Error("R8 runtime config has no expectedPublicHost.");
  }

  const generation = randomUUID();
  const child = spawn(binary, [`--config=${runtimeConfig}`], {
    cwd: path.dirname(runtimeConfig),
    windowsHide: true,
    env: {
      ...process.env,
      WINHELM_R8_RUNTIME_GENERATION: generation,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let ready;
  try {
    ready = await waitForR8Ready(child, generation);
    const endpoint = splitLoopbackListener(ready.listener);
    if (ready.upstream !== `http://${upstream.host}:${upstream.port}`) {
      throw new Error("R8 ready event upstream does not match the verified R7 endpoint.");
    }

    const record = await publishR8RuntimeEndpoint({
      generation,
      pid: child.pid,
      host: endpoint.host,
      port: endpoint.port,
      expectedExecutablePath: binary,
      registryPath: r8Registry,
      probeHealth: probeR8TlsHealth(expectedPublicHost),
    });

    if (listenerSelection.mode === "auto") {
      try {
        await writePreferredInternalPortForRole(
          "r8",
          endpoint.port,
          r8Preference
        );
      } catch {
        process.stderr.write(
          JSON.stringify({ event: "r8_sticky_preference_write_failed" }) + "\n"
        );
      }
    }

    process.stdout.write(
      JSON.stringify({
        event: "R8_VERIFIED_DYNAMIC_RUNTIME_READY",
        listener: `${record.host}:${record.port}`,
        generation: record.generation,
        pid: record.pid,
        upstream: `${upstream.host}:${upstream.port}`,
        upstreamMode: upstream.mode,
        upstreamGeneration: upstream.generation ?? null,
        publicRoute: "inactive",
      }) + "\n"
    );
  } catch (error) {
    if (!child.killed) child.kill();
    throw error;
  }

  const forwardSignal = () => {
    if (!child.killed) child.kill();
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.off("SIGINT", forwardSignal);
  process.off("SIGTERM", forwardSignal);

  if (exit.code !== 0 && exit.code !== null) {
    throw new Error(`R8 child exited with code ${exit.code}`);
  }
  return { ready, exit };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
