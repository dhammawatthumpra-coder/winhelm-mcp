// Deterministic fake tunnel-client fixture for M3A-P2 lifecycle tests.
// Contract mirrors the qualified reference binary:
//   fake --version
//   fake run --config <profile> --health.listen-addr 127.0.0.1:0 --health.url-file <file>
// Behavior is controlled via FAKE_TUNNEL_* environment variables. It never
// touches any real tunnel-client process, profile, or marker.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const QUALIFIED = "0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0";

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
    res.end(
      JSON.stringify({
        status: "ok",
        version: process.env.FAKE_TUNNEL_VERSION || QUALIFIED,
      })
    );
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
