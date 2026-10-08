// Deterministic fake tunnel-client fixture for M3A-P2 lifecycle tests.
// Contract mirrors the qualified reference binary:
//   fake --version
//   fake health --json --url <healthUrl> --pid <pid> --require-control-plane-poll
//   fake run --config <profile> --health.listen-addr 127.0.0.1:0 --health.url-file <file>
// Behavior is controlled via FAKE_TUNNEL_* environment variables. It never
// touches any real tunnel-client process, profile, or marker.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const QUALIFIED = "0.0.16+5f99daabd4aa4a77049e6d81d54a0d8c18335397";

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

if (args.includes("--version")) {
  const version = process.env.FAKE_TUNNEL_VERSION || QUALIFIED;
  const sha = version.split("+")[1] || "0000000000000000000000000000000000000000";
  process.stdout.write(`${version} (git sha: ${sha})\n`);
  process.exit(0);
}

if (args[0] === "health") {
  const pid = Number(argValue("--pid"));
  const healthUrl = argValue("--url");
  if (
    !args.includes("--json") ||
    !args.includes("--require-control-plane-poll") ||
    !healthUrl ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    process.stderr.write("fake tunnel-client: invalid health invocation\n");
    process.exit(2);
  }
  const exitCode = Number(process.env.FAKE_TUNNEL_HEALTH_EXIT_CODE || 0);
  if (exitCode !== 0) process.exit(exitCode);
  const delayMs = Number(process.env.FAKE_TUNNEL_HEALTH_DELAY_MS || 0);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (process.env.FAKE_TUNNEL_HEALTH_MALFORMED === "1") {
    process.stdout.write("{not json\n");
    process.exit(0);
  }
  const controlPlaneOk = process.env.FAKE_TUNNEL_CONTROL_PLANE_OK !== "0";
  const payload = {
    process: { pid, running: process.env.FAKE_TUNNEL_PROCESS_RUNNING !== "0" },
    healthz: { ok: process.env.FAKE_TUNNEL_HEALTHZ_OK !== "0" },
    readyz: { ok: process.env.FAKE_TUNNEL_READYZ_OK !== "0" },
    control_plane_poll: { ok: controlPlaneOk },
    result: process.env.FAKE_TUNNEL_HEALTH_RESULT || (controlPlaneOk ? "ok" : "not_ready"),
  };
  if (process.env.FAKE_TUNNEL_HEALTH_PID_MISMATCH === "1") payload.process.pid += 1;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

if (args[0] !== "run") {
  process.stderr.write("fake tunnel-client: unknown usage\n");
  process.exit(2);
}

const configPath = argValue("--config");
const listenAddr = argValue("--health.listen-addr") || "127.0.0.1:0";
const urlFile = argValue("--health.url-file");

if (!configPath || !fs.existsSync(configPath)) {
  process.stderr.write("fake tunnel-client: config/profile not found\n");
  process.exit(2);
}

const lockFile = `${configPath}.fake-tunnel-lock`;
if (process.env.FAKE_TUNNEL_REFUSE_DUPLICATE === "1" && fs.existsSync(lockFile)) {
  process.stderr.write("fake tunnel-client: daemon already running\n");
  process.exit(3);
}
if (process.env.FAKE_TUNNEL_REFUSE_DUPLICATE === "1") {
  try {
    fs.writeFileSync(lockFile, String(process.pid), "utf8");
  } catch {
    // non-fatal for tests
  }
}

function cleanup() {
  if (process.env.FAKE_TUNNEL_REFUSE_DUPLICATE === "1") {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // ignore
    }
  }
}
process.on("exit", cleanup);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const crashBeforeReady = Number(process.env.FAKE_TUNNEL_CRASH_BEFORE_READY_MS || 0);
if (crashBeforeReady > 0) {
  setTimeout(() => {
    process.exit(1);
  }, crashBeforeReady);
}

const exitAfter = Number(process.env.FAKE_TUNNEL_EXIT_AFTER_MS || 0);
if (exitAfter > 0) {
  setTimeout(() => {
    process.exit(1);
  }, exitAfter);
}

const notReady = process.env.FAKE_TUNNEL_NOT_READY === "1";
const readyDelay = Number(process.env.FAKE_TUNNEL_READY_DELAY_MS || 0);
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("live");
    return;
  }
  if (url === "/readyz") {
    if (notReady || (readyDelay > 0 && Date.now() - startedAt < readyDelay)) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("not-ready");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ready");
    return;
  }
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    let version = process.env.FAKE_TUNNEL_VERSION || QUALIFIED;
    const versionFile = process.env.FAKE_TUNNEL_HEALTH_VERSION_FILE;
    if (versionFile) {
      try {
        version = fs.readFileSync(versionFile, "utf8").trim();
      } catch {
        // Keep the qualified default when no test override has been written.
      }
    }
    const health = { status: "ok" };
    if (version !== "__missing__") health.version = version;
    res.end(JSON.stringify(health));
    return;
  }
  res.writeHead(404);
  res.end();
});

const [host, portStr] = listenAddr.split(":");
const listenPort = portStr === "0" || portStr === undefined ? 0 : Number(portStr);
server.listen(listenPort, host || "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (urlFile) {
    fs.mkdirSync(path.dirname(urlFile), { recursive: true });
    fs.writeFileSync(urlFile, `http://127.0.0.1:${port}`, "utf8");
  }
});
