import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, test } from "node:test";
import {
  bindInternalListener,
  writePreferredInternalPortForRole,
} from "../../src/runtime/internal-port.js";
import {
  publishObservedRuntimeEndpoint,
  readRuntimeEndpointHint,
  resolveVerifiedRuntimeEndpoint,
  verifyRuntimeEndpointRecord,
  type RuntimeEndpointRecord,
} from "../../src/runtime/endpoint-registry.js";
import { resolveR7CoreBackend } from "../../src/runtime/r7-runtime.js";
import { resolveR8R7Upstream } from "../../src/runtime/r8-runtime.js";
import {
  buildRuntimeChainProcessSpecs,
  resolveInternalPortLaunchPlan,
  superviseRuntimeChain,
  verifiedEndpointBelongsToPid,
  type ManagedLaunchedProcess,
  type ProcessSpec,
} from "../../src/runtime/launcher-contract.js";

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function childReadyLine(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5000
): Promise<string> {
  child.stdout?.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("child readiness timed out"));
    }, timeoutMs);
    const onData = (chunk: string | Buffer) => {
      cleanup();
      resolve(String(chunk).trim());
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited before readiness: ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.once("data", onData);
    child.once("exit", onExit);
  });
}

async function stopChild(
  child: ReturnType<typeof spawn> | undefined,
  timeoutMs = 5000
): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill();
  await Promise.race([
    exited,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("child exit timed out")), timeoutMs)
    ),
  ]);
}

function abs(name: string): string {
  return path.resolve("D:\\phase7-fixture", name);
}

function launcherPaths() {
  return {
    coreExecutable: abs("node.exe"),
    coreEntrypoint: abs("core\\dist\\index.js"),
    r7Executable: abs("node.exe"),
    r7Entrypoint: abs("r7\\live-server-dynamic-upstream.mjs"),
    r7SourceRoot: abs("r7\\reviewed"),
    r7Store: abs("state\\r7-store.json"),
    r7Receipt: abs("state\\r7-receipt.json"),
    r7Origin: "https://winhelm-gemini-go-hardening-01.tailabb39e.ts.net",
    r7ClientId: "phase7-client-id",
    r7RedirectUri:
      "https://oauth-redirect.googleusercontent.com/r/winhelm-phase7",
    r8SupervisorExecutable: abs("node.exe"),
    r8SupervisorEntrypoint: abs("r8\\r8-runtime-supervisor.mjs"),
    r8Binary: abs("r8\\winhelm-r8.exe"),
    r8ConfigTemplate: abs("r8\\config.template.json"),
    r8RuntimeConfig: abs("state\\r8-runtime.json"),
    coreRegistry: abs("runtime\\core.json"),
    r7Registry: abs("runtime\\r7.json"),
    r8Registry: abs("runtime\\r8.json"),
  };
}

describe("WinHelm v1.4.1 Phase 7 collision / restart / rollback", () => {
  test("simultaneous automatic binds acquire distinct owned loopback ports", async () => {
    let a: Server | undefined;
    let b: Server | undefined;
    try {
      const [first, second] = await Promise.all([
        bindInternalListener({
          selection: { mode: "auto" },
          host: "127.0.0.1",
          listen: (port, host) => http.createServer().listen(port, host),
        }),
        bindInternalListener({
          selection: { mode: "auto" },
          host: "127.0.0.1",
          listen: (port, host) => http.createServer().listen(port, host),
        }),
      ]);
      a = first.server;
      b = second.server;
      assert.notEqual(first.port, second.port);
      assert.ok(first.port > 0);
      assert.ok(second.port > 0);
    } finally {
      if (a) await close(a);
      if (b) await close(b);
    }
  });

  test("occupied sticky preference falls back by real bind and leaves occupier untouched", async () => {
    const occupier = http.createServer();
    await new Promise<void>((resolve, reject) => {
      occupier.once("error", reject);
      occupier.listen(0, "127.0.0.1", resolve);
    });
    const address = occupier.address();
    assert.ok(address && typeof address === "object");

    let dynamic: Server | undefined;
    try {
      const result = await bindInternalListener({
        selection: { mode: "auto" },
        host: "127.0.0.1",
        preferredPort: address.port,
        listen: (port, host) => http.createServer().listen(port, host),
      });
      dynamic = result.server;
      assert.notEqual(result.port, address.port);
      assert.equal(occupier.listening, true);
    } finally {
      if (dynamic) await close(dynamic);
      await close(occupier);
    }
  });

  test("crash before registry publication leaves no ready record", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-phase7-prepublish-"));
    const registry = path.join(dir, "core.json");
    try {
      await assert.rejects(
        publishObservedRuntimeEndpoint({
          role: "core",
          generation: "11111111-1111-4111-8111-111111111111",
          pid: 515151,
          host: "127.0.0.1",
          port: 55151,
          expectedExecutablePath: process.execPath,
          expectedEntrypointPath: abs("core\\dist\\index.js"),
          filePath: registry,
          observe: async () => ({
            processExists: false,
            listeners: [],
          }),
          probeHealth: async () => {
            throw new Error("health must not authorize a dead process");
          },
        }),
        /identity could not be proven/i
      );
      assert.equal(readRuntimeEndpointHint(registry), undefined);
      await assert.rejects(fs.access(registry));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("crash after publication leaves stale record but verified discovery rejects it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-phase7-postpublish-"));
    const registry = path.join(dir, "core.json");
    const childScript = path.join(dir, "runtime", "child", "core-child.mjs");
    const generation = "22222222-2222-4222-8222-222222222222";
    await fs.mkdir(path.dirname(childScript), { recursive: true });
    await fs.writeFile(
      childScript,
      `import http from "node:http";
const generation = process.env.TEST_GENERATION;
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      server: "winhelm-mcp",
      runtime: { role: "core", generation, pid: process.pid }
    }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ port: address.port }) + "\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
      "utf8"
    );

    const child = spawn(process.execPath, [childScript], {
      env: { ...process.env, TEST_GENERATION: generation },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    try {
      const ready = JSON.parse(await childReadyLine(child)) as { port: number };

      const createdAt = new Date().toISOString();
      const record = await publishObservedRuntimeEndpoint({
        role: "core",
        generation,
        pid: child.pid!,
        host: "127.0.0.1",
        port: ready.port,
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: childScript,
        filePath: registry,
        observe: async (target) => ({
          processExists: true,
          processCreatedAt: createdAt,
          executablePath: process.execPath,
          commandLine: `"${process.execPath}" "${childScript}"`,
          listeners: [
            {
              localAddress: target.host,
              port: target.port,
              owningPid: target.pid,
            },
          ],
        }),
        probeHealth: async (candidate) => {
          const response = await fetch(`http://127.0.0.1:${candidate.port}/health`);
          return response.json();
        },
      });
      assert.equal(record.pid, child.pid);
      assert.ok(readRuntimeEndpointHint(registry));

      await stopChild(child);

      assert.ok(readRuntimeEndpointHint(registry), "stale hint deliberately survives crash");
      const resolved = await resolveVerifiedRuntimeEndpoint({
        role: "core",
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: childScript,
        filePath: registry,
        observe: async () => ({
          processExists: false,
          listeners: [],
        }),
      });
      assert.equal(resolved, undefined);
    } finally {
      await stopChild(child).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("stale port taken over by an unrelated process remains unauthorized", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-phase7-port-reuse-"));
    const registry = path.join(dir, "core.json");
    const aScript = path.join(dir, "a", "core-a.mjs");
    const bScript = path.join(dir, "b", "unrelated-b.mjs");
    const generation = "33333333-3333-4333-8333-333333333333";
    await fs.mkdir(path.dirname(aScript), { recursive: true });
    await fs.mkdir(path.dirname(bScript), { recursive: true });
    const childSource = (portExpr: string) => `import http from "node:http";
const generation = process.env.TEST_GENERATION;
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      server: "winhelm-mcp",
      runtime: { role: "core", generation, pid: process.pid }
    }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(${portExpr}, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ port: address.port }) + "\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
    await fs.writeFile(aScript, childSource("0"), "utf8");

    let a = spawn(process.execPath, [aScript], {
      env: { ...process.env, TEST_GENERATION: generation },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let b: ReturnType<typeof spawn> | undefined;

    try {
      const ready = JSON.parse(await childReadyLine(a)) as { port: number };
      const createdAt = new Date().toISOString();
      await publishObservedRuntimeEndpoint({
        role: "core",
        generation,
        pid: a.pid!,
        host: "127.0.0.1",
        port: ready.port,
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: aScript,
        filePath: registry,
        observe: async (target) => ({
          processExists: true,
          processCreatedAt: createdAt,
          executablePath: process.execPath,
          commandLine: `"${process.execPath}" "${aScript}"`,
          listeners: [
            {
              localAddress: target.host,
              port: target.port,
              owningPid: target.pid,
            },
          ],
        }),
        probeHealth: async (candidate) =>
          (await fetch(`http://127.0.0.1:${candidate.port}/health`)).json(),
      });

      await stopChild(a);

      await fs.writeFile(bScript, childSource(String(ready.port)), "utf8");
      b = spawn(process.execPath, [bScript], {
        env: {
          ...process.env,
          TEST_GENERATION: "44444444-4444-4444-8444-444444444444",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      await childReadyLine(b);

      const bCreatedAt = new Date(Date.now() + 60_000).toISOString();
      const stale = await resolveVerifiedRuntimeEndpoint({
        role: "core",
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: aScript,
        filePath: registry,
        observe: async () => ({
          processExists: true,
          processCreatedAt: bCreatedAt,
          executablePath: process.execPath,
          commandLine: `"${process.execPath}" "${bScript}"`,
          listeners: [
            {
              localAddress: "127.0.0.1",
              port: ready.port,
              owningPid: b!.pid!,
            },
          ],
        }),
      });
      assert.equal(stale, undefined);
      assert.ok(readRuntimeEndpointHint(registry));
    } finally {
      await stopChild(a).catch(() => {});
      await stopChild(b).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("truncated or corrupt registry is unavailable and never authorizes fallback", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-phase7-corrupt-registry-"));
    const registry = path.join(dir, "core.json");
    try {
      await fs.writeFile(registry, "{\"schemaVersion\":1,\"role\":\"core\"", "utf8");
      const resolved = await resolveVerifiedRuntimeEndpoint({
        role: "core",
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: abs("core\\dist\\index.js"),
        filePath: registry,
      });
      assert.equal(resolved, undefined);
      assert.equal(readRuntimeEndpointHint(registry), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("a verified duplicate process cannot satisfy readiness for the launcher-owned PID", () => {
    const endpoint = {
      role: "core",
      generation: "66666666-6666-4666-8666-666666666666",
      host: "127.0.0.1",
      port: 56066,
      pid: 6066,
    };
    assert.equal(verifiedEndpointBelongsToPid(endpoint, 6066), true);
    assert.equal(verifiedEndpointBelongsToPid(endpoint, 7077), false);
    assert.equal(verifiedEndpointBelongsToPid(undefined, 6066), false);
  });

  test("PID reuse is rejected even when PID, listener, executable, and health look plausible", async () => {
    const record: RuntimeEndpointRecord = {
      schemaVersion: 1,
      role: "core",
      generation: "55555555-5555-4555-8555-555555555555",
      state: "ready",
      host: "127.0.0.1",
      port: 55055,
      pid: 5055,
      processCreatedAt: "2026-10-18T06:00:00.000Z",
      executablePath: process.execPath,
      entrypointPath: abs("core\\dist\\index.js"),
      publishedAt: "2026-10-18T06:00:01.000Z",
    };
    const verified = await verifyRuntimeEndpointRecord(record, {
      expectedRole: "core",
      expectedExecutablePath: process.execPath,
      expectedEntrypointPath: record.entrypointPath,
      observe: async () => ({
        processExists: true,
        processCreatedAt: "2026-10-18T07:00:00.000Z",
        executablePath: process.execPath,
        commandLine: `"${process.execPath}" "${record.entrypointPath}" --port auto`,
        listeners: [
          {
            localAddress: record.host,
            port: record.port,
            owningPid: record.pid,
          },
        ],
      }),
      probeHealth: async () => ({
        status: "ok",
        server: "winhelm-mcp",
        runtime: {
          role: "core",
          generation: record.generation,
          pid: record.pid,
        },
      }),
    });
    assert.equal(verified, undefined);
  });

  test("out-of-order R7 and R8 startup fail closed without historical-port fallback", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-phase7-order-"));
    try {
      await assert.rejects(
        resolveR7CoreBackend({
          selection: { mode: "auto" },
          host: "127.0.0.1",
          expectedCoreExecutablePath: process.execPath,
          expectedCoreEntrypointPath: abs("core\\dist\\index.js"),
          coreRegistryPath: path.join(dir, "missing-core.json"),
        }),
        /Verified Core runtime endpoint is unavailable/
      );
      await assert.rejects(
        resolveR8R7Upstream({
          selection: { mode: "auto" },
          host: "127.0.0.1",
          expectedR7ExecutablePath: process.execPath,
          expectedR7EntrypointPath: abs("r7\\live-server.mjs"),
          r7RegistryPath: path.join(dir, "missing-r7.json"),
        }),
        /Verified R7 runtime endpoint is unavailable/
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("dependency exit while downstream is alive tears down reverse-order and re-verifies a fresh cycle", async () => {
    const specs: ProcessSpec[] = (["core", "r7", "r8"] as const).map((role) => ({
      role,
      executable: abs(`${role}.exe`),
      args: [],
      cwd: abs(role),
    }));
    const events: string[] = [];
    let cycle = 0;

    const result = await superviseRuntimeChain({
      specs,
      maxRestarts: 2,
      spawn: async (spec) => ({
        role: spec.role,
        stop: async () => {
          events.push(`stop:${cycle}:${spec.role}`);
        },
      }),
      waitReady: async (role) => {
        events.push(`verify:${cycle}:${role}`);
      },
      onCycleReady: async () => {
        cycle += 1;
        events.push(`ready:${cycle}`);
      },
      waitForExit: async () => {
        if (cycle === 1) {
          events.push("exit:1:core");
          return { role: "core", reason: "dependency_crash" };
        }
        events.push("exit:2:r8");
        return { role: "r8", reason: "shutdown" };
      },
      shouldRestart: async (event) => event.reason !== "shutdown",
      onRestart: async (restart) => {
        events.push(`restart:${restart}`);
      },
    });

    assert.equal(result.state, "stopped");
    assert.equal(result.cyclesStarted, 2);
    assert.equal(result.restartsPerformed, 1);
    assert.deepEqual(events, [
      "verify:0:core",
      "verify:0:r7",
      "verify:0:r8",
      "ready:1",
      "exit:1:core",
      "stop:1:r8",
      "stop:1:r7",
      "stop:1:core",
      "restart:1",
      "verify:1:core",
      "verify:1:r7",
      "verify:1:r8",
      "ready:2",
      "exit:2:r8",
      "stop:2:r8",
      "stop:2:r7",
      "stop:2:core",
    ]);
  });

  test("restart storm exhausts bounded budget only after cleaning every cycle", async () => {
    const specs: ProcessSpec[] = (["core", "r7", "r8"] as const).map((role) => ({
      role,
      executable: abs(`${role}.exe`),
      args: [],
      cwd: abs(role),
    }));
    const stops: string[] = [];
    let cycle = 0;

    const result = await superviseRuntimeChain({
      specs,
      maxRestarts: 1,
      spawn: async (spec): Promise<ManagedLaunchedProcess> => ({
        role: spec.role,
        stop: async () => {
          stops.push(`${cycle}:${spec.role}`);
        },
      }),
      waitReady: async () => {},
      onCycleReady: async () => {
        cycle += 1;
      },
      waitForExit: async () => ({ role: "core", reason: "crash" }),
    });

    assert.equal(result.state, "restart_budget_exhausted");
    assert.equal(result.cyclesStarted, 2);
    assert.equal(result.restartsPerformed, 1);
    assert.deepEqual(stops, [
      "1:r8",
      "1:r7",
      "1:core",
      "2:r8",
      "2:r7",
      "2:core",
    ]);
  });

  test("explicit rollback from automatic produces a fixed non-discovery topology", () => {
    const rollback = resolveInternalPortLaunchPlan({
      installationKind: "existing",
      existingMode: "automatic",
      requestedMode: "fixed",
      requestedFixedPorts: { core: 18788, r7: 64239, r8: 19447 },
      explicitModeChange: true,
    });
    assert.equal(rollback.mode, "fixed");
    assert.equal(rollback.migration, "explicit_mode_change");

    const specs = buildRuntimeChainProcessSpecs(rollback, launcherPaths());
    assert.ok(specs[0]!.args.includes("18788"));
    assert.ok(specs[1]!.args.includes("--backend-port=18788"));
    assert.ok(specs[1]!.args.includes("--port=64239"));
    assert.ok(specs[2]!.args.includes("--r7-port=64239"));
    assert.ok(specs[2]!.args.includes("--port=19447"));
    assert.ok(!specs[1]!.args.some((arg) => arg.startsWith("--core-registry=")));
    assert.ok(!specs[2]!.args.some((arg) => arg.startsWith("--r7-registry=")));
  });
});
