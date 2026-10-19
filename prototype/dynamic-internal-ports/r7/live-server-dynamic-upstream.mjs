import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveInternalPortSelection,
} from "../../../dist/runtime/internal-port.js";
import {
  startR7Runtime,
} from "../../../dist/runtime/r7-runtime.js";

const LISTENER_HOST = "127.0.0.1";
const BACKEND_HOST = "127.0.0.1";
const EXPECTED_ORIGIN = "https://winhelm-gemini-go-hardening-01.tailabb39e.ts.net";

export function parseArgs(argv) {
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

async function importReviewedSource(sourceRoot) {
  const serverModule = await import(
    pathToFileURL(path.join(sourceRoot, "server-r7.mjs")).href
  );
  const storeModule = await import(
    pathToFileURL(path.join(sourceRoot, "r7_store.mjs")).href
  );
  const aliasModule = await import(
    pathToFileURL(path.join(sourceRoot, "alias_store.mjs")).href
  );
  if (typeof serverModule.createR7IngressServer !== "function") {
    throw new Error("Reviewed R7 source does not export createR7IngressServer.");
  }
  if (typeof storeModule.RegistrationStore !== "function") {
    throw new Error("Reviewed R7 source does not export RegistrationStore.");
  }
  if (typeof aliasModule.readCoreToken !== "function") {
    throw new Error("Reviewed R7 source does not export readCoreToken.");
  }
  return {
    createR7IngressServer: serverModule.createR7IngressServer,
    RegistrationStore: storeModule.RegistrationStore,
    readCoreToken: aliasModule.readCoreToken,
  };
}

function sanitizedLogger(entry) {
  const safe = {
    event: typeof entry?.event === "string" ? entry.event : "r7_event",
    method: typeof entry?.method === "string" ? entry.method : undefined,
    status: Number.isInteger(entry?.status) ? entry.status : undefined,
    adapterType: typeof entry?.adapterType === "string" ? entry.adapterType : undefined,
  };
  process.stdout.write(JSON.stringify(safe) + "\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  for (const key of [
    "store",
    "port",
    "origin",
    "receipt",
    "client-id",
    "redirect-uri",
    "source-root",
  ]) {
    required(args, key);
  }

  const listenerSelection = resolveInternalPortSelection({
    cliPort: args.port,
    host: LISTENER_HOST,
    defaultPort: 64239,
  });
  const backendSelection = resolveInternalPortSelection({
    cliPort: args["backend-port"],
    host: BACKEND_HOST,
    defaultPort: 18788,
  });

  const origin = new URL(args.origin).origin;
  if (origin !== EXPECTED_ORIGIN) {
    throw new Error("Isolated upstream origin mismatch");
  }
  const redirectUri = new URL(args["redirect-uri"]);
  if (
    redirectUri.protocol !== "https:" ||
    redirectUri.hostname !== "oauth-redirect.googleusercontent.com"
  ) {
    throw new Error(
      "Gemini redirect URI must be HTTPS on oauth-redirect.googleusercontent.com"
    );
  }

  if (!process.env.WINHELM_R7_ISOLATED_GEMINI_CLIENT_SECRET) {
    throw new Error("WINHELM_R7_ISOLATED_GEMINI_CLIENT_SECRET missing");
  }
  process.env.WINHELM_R7_GEMINI_CLIENT_SECRET =
    process.env.WINHELM_R7_ISOLATED_GEMINI_CLIENT_SECRET;
  delete process.env.WINHELM_R7_ISOLATED_GEMINI_CLIENT_SECRET;

  const sourceRoot = path.resolve(args["source-root"]);
  const {
    createR7IngressServer,
    RegistrationStore,
    readCoreToken,
  } = await importReviewedSource(sourceRoot);

  const storePath = path.resolve(args.store);
  const receiptPath = path.resolve(args.receipt);
  process.env.WINHELM_R7_STORE_PATH = storePath;
  process.env.WINHELM_R7_EXTERNAL_ORIGIN = origin;
  process.env.WINHELM_R7_GEMINI_STATIC_OAUTH_ENABLED = "1";
  process.env.WINHELM_R7_GEMINI_CLIENT_ID = args["client-id"];
  process.env.WINHELM_R7_GEMINI_REDIRECT_URI = redirectUri.toString();

  const coreToken = await readCoreToken();
  const store = new RegistrationStore({ storePath });
  const entrypointPath = fileURLToPath(import.meta.url);

  const coreBackend = {
    selection: backendSelection,
    host: BACKEND_HOST,
    expectedCoreExecutablePath:
      backendSelection.mode === "auto"
        ? required(args, "core-executable")
        : undefined,
    expectedCoreEntrypointPath:
      backendSelection.mode === "auto"
        ? required(args, "core-entrypoint")
        : undefined,
    coreRegistryPath: args["core-registry"]
      ? path.resolve(args["core-registry"])
      : undefined,
  };

  const started = await startR7Runtime({
    listenerSelection,
    listenerHost: LISTENER_HOST,
    coreBackend,
    createServer: (backend) =>
      createR7IngressServer({
        store,
        coreToken,
        backendHost: backend.host,
        backendPort: backend.port,
        externalOrigin: origin,
        logger: sanitizedLogger,
      }),
    expectedExecutablePath: process.execPath,
    expectedEntrypointPath: entrypointPath,
    registryPath: args["r7-registry"]
      ? path.resolve(args["r7-registry"])
      : undefined,
    preferencePath: args["r7-preference"]
      ? path.resolve(args["r7-preference"])
      : undefined,
    onPreferenceWriteError: () => {
      process.stderr.write(
        JSON.stringify({ event: "r7_sticky_preference_write_failed" }) + "\n"
      );
    },
  });

  const clientIdHash = createHash("sha256")
    .update(args["client-id"], "utf8")
    .digest("hex");
  const receipt = {
    schema: 2,
    event: "DYNAMIC_INTERNAL_PORT_R7_UPSTREAM_READY",
    executable: process.execPath,
    scriptPath: entrypointPath,
    sourceRoot,
    storePath,
    listener: `${LISTENER_HOST}:${started.port}`,
    listenerMode: listenerSelection.mode,
    generation: started.generation,
    origin,
    redirectHost: redirectUri.hostname,
    clientIdSha256: clientIdHash,
    backend: `${started.backend.host}:${started.backend.port}`,
    backendMode: started.backend.mode,
    backendGeneration: started.backend.generation ?? null,
    startedAt: new Date().toISOString(),
    sensitiveValuesPersisted: false,
  };
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  process.stdout.write(
    JSON.stringify({
      event: receipt.event,
      listener: receipt.listener,
      backend: receipt.backend,
      generation: receipt.generation,
    }) + "\n"
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
