import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const LAUNCHER = path.resolve(import.meta.dirname, "../../start-active-stdio.ps1");

let scratch: string;
let savedMarkerEnv: string | undefined;
let savedNodeEnv: string | undefined;

interface LauncherResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function runLauncher(markerPath: string | null, extraEnv: Record<string, string> = {}): LauncherResult {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (markerPath === null) {
    delete env.WINHELM_ACTIVE_BACKEND_MARKER;
  } else {
    env.WINHELM_ACTIVE_BACKEND_MARKER = markerPath;
  }
  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      LAUNCHER,
    ],
    { env, encoding: "utf8", timeout: 60_000 }
  );
  return {
    status: res.status,
    stderr: res.stderr || "",
    stdout: res.stdout || "",
  };
}

async function writeMarker(dir: string, marker: Record<string, unknown>): Promise<string> {
  const markerPath = path.join(dir, "winhelm.active-backend.json");
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), "utf8");
  return markerPath;
}

async function makeBackend(
  dir: string,
  opts: {
    head?: string | null;
    includeDist?: boolean;
    includeConfig?: boolean;
  } = {}
): Promise<{ root: string; configPath: string; head: string }> {
  const root = path.join(dir, "backend");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  if (opts.includeDist !== false) {
    await fs.writeFile(
      path.join(root, "dist", "index.js"),
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.env.FAKE_BACKEND_ARGS_FILE, JSON.stringify(process.argv.slice(2)), 'utf8');",
        "process.exit(Number(process.env.FAKE_BACKEND_EXIT_CODE || 0));",
        "",
      ].join("\n"),
      "utf8"
    );
  }
  const configPath = path.join(root, "winhelm.config.json");
  if (opts.includeConfig !== false) {
    await fs.writeFile(configPath, "{}\n", "utf8");
  }
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "--no-gpg-sign", "-m", "fixture"], { stdio: "ignore" });
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { root, configPath, head };
}

/**
 * M3A P2 — tracked active-stdio launcher contract. Negative paths must fail
 * closed with exit code 1 and stderr diagnostics; success must execute the
 * exact built entrypoint with the exact config path and preserve the child
 * exit code. All cases run against scratch fixtures via the
 * WINHELM_ACTIVE_BACKEND_MARKER override; the real active backend and marker
 * are never touched.
 */
describe("M3A P2: tracked active-stdio launcher", () => {
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-m3a-p2-launcher-"));
    savedMarkerEnv = process.env.WINHELM_ACTIVE_BACKEND_MARKER;
    savedNodeEnv = process.env.WINHELM_NODE_EXECUTABLE_PATH;
    process.env.WINHELM_NODE_EXECUTABLE_PATH = process.execPath;
    delete process.env.FAKE_BACKEND_ARGS_FILE;
    delete process.env.FAKE_BACKEND_EXIT_CODE;
  });

  afterEach(async () => {
    if (savedMarkerEnv === undefined) delete process.env.WINHELM_ACTIVE_BACKEND_MARKER;
    else process.env.WINHELM_ACTIVE_BACKEND_MARKER = savedMarkerEnv;
    if (savedNodeEnv === undefined) delete process.env.WINHELM_NODE_EXECUTABLE_PATH;
    else process.env.WINHELM_NODE_EXECUTABLE_PATH = savedNodeEnv;
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("fails closed when the marker is missing", async () => {
    const missing = path.join(scratch, "absent.json");
    const res = runLauncher(missing);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes("marker"), "stderr must name the marker problem");
  });

  it("fails closed when the marker is malformed JSON", async () => {
    const markerPath = path.join(scratch, "bad.json");
    await fs.writeFile(markerPath, "{not-json", "utf8");
    const res = runLauncher(markerPath);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.length > 0);
  });

  it("fails closed on unsupported marker schemaVersion", async () => {
    const backend = await makeBackend(path.join(scratch, "b1"));
    const markerPath = await writeMarker(scratch, {
      schemaVersion: 99,
      backendRoot: backend.root,
      expectedHead: backend.head,
      configPath: backend.configPath,
    });
    const res = runLauncher(markerPath);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes("schemaVersion"));
  });

  it("fails closed when backendRoot is not a directory", async () => {
    const backend = await makeBackend(path.join(scratch, "b2"));
    const markerPath = await writeMarker(scratch, {
      schemaVersion: 1,
      backendRoot: path.join(scratch, "no-such-root"),
      expectedHead: backend.head,
      configPath: backend.configPath,
    });
    const res = runLauncher(markerPath);
    assert.strictEqual(res.status, 1);
  });

  it("fails closed when configPath is not a file", async () => {
    const backend = await makeBackend(path.join(scratch, "b3"), { includeConfig: false });
    const markerPath = await writeMarker(scratch, {
      schemaVersion: 1,
      backendRoot: backend.root,
      expectedHead: backend.head,
      configPath: path.join(backend.root, "absent-config.json"),
    });
    const res = runLauncher(markerPath);
    assert.strictEqual(res.status, 1);
  });

  it("fails closed when dist/index.js is not built", async () => {
    const backend = await makeBackend(path.join(scratch, "b4"), { includeDist: false });
    const markerPath = await writeMarker(scratch, {
      schemaVersion: 1,
      backendRoot: backend.root,
      expectedHead: backend.head,
      configPath: backend.configPath,
    });
    const res = runLauncher(markerPath);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes("dist"), "stderr must name the build problem");
  });

  it("fails closed on HEAD mismatch", async () => {
    const backend = await makeBackend(path.join(scratch, "b5"));
    const markerPath = await writeMarker(scratch, {
      schemaVersion: 1,
      backendRoot: backend.root,
      expectedHead: "f".repeat(40),
      configPath: backend.configPath,
    });
    const res = runLauncher(markerPath);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes("HEAD"), "stderr must name the HEAD mismatch");
  });

  it("executes the exact entrypoint with --stdio and the exact config path", async () => {
    const backend = await makeBackend(path.join(scratch, "b6"));
    const argsFile = path.join(scratch, "backend-args.json");
    const markerPath = await writeMarker(scratch, {
      schemaVersion: 1,
      backendRoot: backend.root,
      expectedHead: backend.head,
      configPath: backend.configPath,
    });
    const res = runLauncher(markerPath, {
      FAKE_BACKEND_ARGS_FILE: argsFile,
      FAKE_BACKEND_EXIT_CODE: "0",
    });
    assert.strictEqual(res.status, 0, `launcher failed: ${res.stderr}`);
    const passed = JSON.parse(await fs.readFile(argsFile, "utf8")) as string[];
    assert.deepStrictEqual(passed, ["--stdio", "--config", backend.configPath]);
  });

  it("preserves the child exit code", async () => {
    const backend = await makeBackend(path.join(scratch, "b7"));
    const argsFile = path.join(scratch, "backend-args.json");
    const markerPath = await writeMarker(scratch, {
      schemaVersion: 1,
      backendRoot: backend.root,
      expectedHead: backend.head,
      configPath: backend.configPath,
    });
    const res = runLauncher(markerPath, {
      FAKE_BACKEND_ARGS_FILE: argsFile,
      FAKE_BACKEND_EXIT_CODE: "7",
    });
    assert.strictEqual(res.status, 7);
  });

  it("never prints config contents or secret material", async () => {
    const backend = await makeBackend(path.join(scratch, "b8"));
    const argsFile = path.join(scratch, "backend-args.json");
    const markerPath = await writeMarker(scratch, {
      schemaVersion: 1,
      mode: "fixture",
      secretValue: "sk-should-never-appear",
      backendRoot: backend.root,
      expectedHead: backend.head,
      configPath: backend.configPath,
    });
    const res = runLauncher(markerPath, {
      FAKE_BACKEND_ARGS_FILE: argsFile,
      FAKE_BACKEND_EXIT_CODE: "0",
    });
    assert.strictEqual(res.status, 0);
    const combined = res.stdout + res.stderr;
    assert.ok(!combined.includes("sk-should-never-appear"));
    assert.ok(!combined.includes('"backendRoot"'));
  });
});
