import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { startManagedTunnel } from "../../src/integrations/chatgpt-tunnel.js";

const FAKE_CLIENT = path.resolve(
  import.meta.dirname,
  "../fixtures/m3a-p2/fake-tunnel-client.mjs"
);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
      cwd: REPO_ROOT,
      env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function makeFakeBackend(dir: string): Promise<{ markerPath: string }> {
  const backendRoot = path.join(dir, "backend");
  await fs.mkdir(path.join(backendRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(backendRoot, "dist", "index.js"), "process.exit(0);\n", "utf8");
  const configPath = path.join(backendRoot, "winhelm.config.json");
  await fs.writeFile(configPath, "{}\n", "utf8");
  await fs.writeFile(path.join(backendRoot, "start-active-stdio.ps1"), "# fixture\n", "utf8");
  await fs.writeFile(path.join(backendRoot, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["-C", backendRoot, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", backendRoot, "config", "user.email", "fixture@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", backendRoot, "config", "user.name", "Fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", backendRoot, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", backendRoot, "commit", "--no-gpg-sign", "-m", "fixture"], { stdio: "ignore" });
  const head = execFileSync("git", ["-C", backendRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const markerPath = path.join(dir, "winhelm.active-backend.json");
  await fs.writeFile(
    markerPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "fixture",
      backendRoot,
      expectedHead: head,
      configPath,
    }),
    "utf8"
  );
  return { markerPath };
}

/**
 * M3A P2 — local CLI recovery surface (`winhelm tunnel ...`). The CLI must
 * recover lifecycle state when the Product Shell is unavailable, print no
 * secrets, keep status/doctor read-only, and share the same backend lifecycle
 * service as the Admin plane.
 */
describe("M3A P2: winhelm tunnel CLI recovery surface", () => {
  let root: string;
  let stateDir: string;
  let markerPath: string;
  let profilePath: string;
  let baseEnv: NodeJS.ProcessEnv;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-m3a-p2-cli-"));
    stateDir = path.join(root, "tunnel-state");
    ({ markerPath } = await makeFakeBackend(root));
    profilePath = path.join(root, "profile.yaml");
    await fs.writeFile(profilePath, "fake: profile\n", "utf8");

    for (const key of [
      "WINHELM_TUNNEL_STATE_DIR",
      "WINHELM_ACTIVE_BACKEND_MARKER",
      "FAKE_TUNNEL_VERSION",
      "FAKE_TUNNEL_CRASH_BEFORE_READY_MS",
    ]) {
      savedEnv[key] = process.env[key];
    }
    // In-process service calls (cross-process stop scenario) must use the
    // scratch state dir, never real user state.
    process.env.WINHELM_TUNNEL_STATE_DIR = stateDir;
    baseEnv = {
      ...process.env,
      WINHELM_TUNNEL_STATE_DIR: stateDir,
      FAKE_TUNNEL_REFUSE_DUPLICATE: undefined as unknown as string,
    };
    delete baseEnv.WINHELM_ACTIVE_BACKEND_MARKER;
    delete baseEnv.FAKE_TUNNEL_VERSION;
    delete baseEnv.FAKE_TUNNEL_CRASH_BEFORE_READY_MS;
    delete baseEnv.FAKE_TUNNEL_REFUSE_DUPLICATE;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports an unconfigured tunnel without crashing and without secrets", async () => {
    const res = await runCli(["tunnel", "status"], baseEnv);
    assert.strictEqual(res.code, 0, `status failed: ${res.stderr}`);
    const body = JSON.parse(res.stdout) as any;
    assert.strictEqual(body.configPresent, false);
    assert.strictEqual(body.dependency.state, "missing");
    assert.strictEqual(body.daemon.ownership, "none");
    assert.ok(!res.stdout.includes("sk-"));
  });

  it("distinguishes the ChatGPT/OpenAI Tunnel from the Tailscale Funnel in help", async () => {
    const res = await runCli(["tunnel"], baseEnv);
    const text = res.stdout + res.stderr;
    assert.match(text, /ChatGPT/i);
    assert.match(text, /Tailscale/i);
    assert.match(text, /manual|advanced/i);
  });

  it("configures non-secret lifecycle settings and runs a read-only doctor", async () => {
    const configure = await runCli(
      [
        "tunnel",
        "configure",
        "--exe",
        process.execPath,
        "--exe-arg",
        FAKE_CLIENT,
        "--profile",
        profilePath,
        "--marker",
        markerPath,
      ],
      baseEnv
    );
    assert.strictEqual(configure.code, 0, `configure failed: ${configure.stderr}`);
    const config = JSON.parse(configure.stdout) as any;
    assert.strictEqual(config.executablePath, process.execPath);
    assert.deepStrictEqual(config.executableArgs, [FAKE_CLIENT]);

    const before = await fs.readdir(stateDir, { recursive: true });
    const doctor = await runCli(["tunnel", "doctor"], baseEnv);
    assert.strictEqual(doctor.code, 0, `doctor failed: ${doctor.stderr}`);
    const checks = (JSON.parse(doctor.stdout) as any).checks;
    assert.ok(Array.isArray(checks) && checks.length > 0);
    const names = checks.map((c: any) => c.name);
    assert.ok(names.includes("dependency"));
    assert.ok(names.includes("backendReadiness"));
    const after = await fs.readdir(stateDir, { recursive: true });
    assert.deepStrictEqual(after, before, "doctor must be read-only");
  });

  it("starts a managed fake tunnel through the shared service", async () => {
    const configure = await runCli(
      [
        "tunnel",
        "configure",
        "--exe",
        process.execPath,
        "--exe-arg",
        FAKE_CLIENT,
        "--profile",
        profilePath,
        "--marker",
        markerPath,
      ],
      baseEnv
    );
    assert.strictEqual(configure.code, 0);

    const start = await runCli(["tunnel", "start"], baseEnv);
    assert.strictEqual(start.code, 0, `start failed: ${start.stderr}`);
    const startStatus = JSON.parse(start.stdout) as any;
    assert.strictEqual(startStatus.daemon.state, "managed_ready");
    assert.strictEqual(startStatus.daemon.ownership, "managed");
    assert.ok(startStatus.daemon.pid > 0);
    assert.ok(startStatus.daemon.healthUrl?.startsWith("http://127.0.0.1:"));
  });

  it("stops a live managed daemon cross-process through the shared service", async () => {
    const configure = await runCli(
      [
        "tunnel",
        "configure",
        "--exe",
        process.execPath,
        "--exe-arg",
        FAKE_CLIENT,
        "--profile",
        profilePath,
        "--marker",
        markerPath,
      ],
      baseEnv
    );
    assert.strictEqual(configure.code, 0);

    // Start in-process so the daemon outlives the start call; the CLI stop
    // then runs in a DIFFERENT process from the creator, which is exactly the
    // persisted-identity + PID-reuse-defense scenario.
    await startManagedTunnel();

    const status = await runCli(["tunnel", "status"], baseEnv);
    assert.strictEqual(status.code, 0);
    assert.strictEqual((JSON.parse(status.stdout) as any).daemon.state, "managed_ready");

    const stop = await runCli(["tunnel", "stop"], baseEnv);
    assert.strictEqual(stop.code, 0, `stop failed: ${stop.stderr}`);
    assert.strictEqual((JSON.parse(stop.stdout) as any).daemon.state, "stopped");

    const after = await runCli(["tunnel", "status"], baseEnv);
    assert.strictEqual((JSON.parse(after.stdout) as any).daemon.state, "stopped");
  });

  it("fails with a bounded error when stopping with no managed state", async () => {
    const res = await runCli(["tunnel", "stop"], baseEnv);
    assert.strictEqual(res.code, 1);
    const err = JSON.parse(res.stderr) as any;
    assert.strictEqual(err.error.code, "TUNNEL_NOT_MANAGED");
  });
});
