import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http, { type Server } from "node:http";
import {
  readPreferredInternalPortForRole,
  writePreferredInternalPortForRole,
} from "../../src/runtime/internal-port.js";
import {
  resolveVerifiedRuntimeEndpoint,
  type RuntimeEndpointObservation,
} from "../../src/runtime/endpoint-registry.js";
import {
  installR7RuntimeHealthRoute,
  resolveR7CoreBackend,
  startR7Runtime,
} from "../../src/runtime/r7-runtime.js";

const EXE = "C:\\Program Files\\nodejs\\node.exe";
const CORE_ENTRY = "D:\\mcp\\winhelm-v1.4.1-dynamic-internal-ports-r1\\dist\\index.js";

function observedCore(port = 49152): RuntimeEndpointObservation {
  return {
    processExists: true,
    processCreatedAt: "2026-10-18T06:00:00.000Z",
    executablePath: EXE,
    commandLine: `"${EXE}" "${CORE_ENTRY}" --port auto`,
    listeners: [{ localAddress: "127.0.0.1", port, owningPid: 4242 }],
  };
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("WinHelm v1.4.1 Phase 3 R7 dynamic runtime", () => {
  it("keeps role-scoped sticky preferences isolated while preserving Core helpers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r7-pref-"));
    const core = path.join(dir, "core.json");
    const r7 = path.join(dir, "r7.json");
    try {
      await writePreferredInternalPortForRole("core", 21001, core);
      await writePreferredInternalPortForRole("r7", 21002, r7);
      assert.strictEqual(readPreferredInternalPortForRole("core", core), 21001);
      assert.strictEqual(readPreferredInternalPortForRole("r7", r7), 21002);
      assert.strictEqual(readPreferredInternalPortForRole("core", r7), undefined);
      assert.strictEqual(readPreferredInternalPortForRole("r7", core), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves the fixed legacy Core backend without consulting discovery", async () => {
    let discoveryCalls = 0;
    const backend = await resolveR7CoreBackend({
      selection: { mode: "fixed", port: 18788 },
      host: "127.0.0.1",
      resolveVerified: async () => {
        discoveryCalls += 1;
        return undefined;
      },
    });
    assert.deepStrictEqual(backend, {
      mode: "fixed",
      host: "127.0.0.1",
      port: 18788,
    });
    assert.strictEqual(discoveryCalls, 0);
  });

  it("uses only a verified Core endpoint in auto backend mode", async () => {
    const backend = await resolveR7CoreBackend({
      selection: { mode: "auto" },
      host: "127.0.0.1",
      expectedCoreExecutablePath: EXE,
      expectedCoreEntrypointPath: CORE_ENTRY,
      resolveVerified: async (options) => {
        assert.strictEqual(options.role, "core");
        assert.strictEqual(options.expectedExecutablePath, EXE);
        assert.strictEqual(options.expectedEntrypointPath, CORE_ENTRY);
        return {
          role: "core",
          generation: "11111111-1111-4111-8111-111111111111",
          host: "127.0.0.1",
          port: 49152,
          pid: 4242,
        };
      },
    });
    assert.deepStrictEqual(backend, {
      mode: "auto",
      host: "127.0.0.1",
      port: 49152,
      generation: "11111111-1111-4111-8111-111111111111",
      pid: 4242,
    });
  });

  it("fails closed when Core auto discovery cannot prove the current endpoint", async () => {
    await assert.rejects(
      resolveR7CoreBackend({
        selection: { mode: "auto" },
        host: "127.0.0.1",
        expectedCoreExecutablePath: EXE,
        expectedCoreEntrypointPath: CORE_ENTRY,
        resolveVerified: async () => undefined,
      }),
      /verified Core runtime endpoint is unavailable/i
    );
  });

  it("rejects a forged Core registry hint before R7 listener bind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r7-forged-core-"));
    const registry = path.join(dir, "core.json");
    try {
      await fs.writeFile(
        registry,
        JSON.stringify(
          {
            schemaVersion: 1,
            role: "core",
            generation: "77777777-7777-4777-8777-777777777777",
            state: "ready",
            host: "127.0.0.1",
            port: 49152,
            pid: 999999,
            processCreatedAt: "2026-10-18T06:00:00.000Z",
            executablePath: EXE,
            entrypointPath: CORE_ENTRY,
            publishedAt: "2026-10-18T06:00:01.000Z",
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      await assert.rejects(
        resolveR7CoreBackend({
          selection: { mode: "auto" },
          host: "127.0.0.1",
          expectedCoreExecutablePath: EXE,
          expectedCoreEntrypointPath: CORE_ENTRY,
          coreRegistryPath: registry,
        }),
        /verified Core runtime endpoint is unavailable/i
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("serves R7 runtime health only to a generation-bound local probe and preserves normal routing", async () => {
    const generation = "22222222-2222-4222-8222-222222222222";
    const server = http.createServer((req, res) => {
      res.writeHead(204);
      res.end();
    });
    installR7RuntimeHealthRoute(server, { generation, pid: process.pid });
    const port = await listen(server);
    try {
      const hidden = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(hidden.status, 404);

      const ok = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { "x-winhelm-runtime-generation": generation },
      });
      assert.strictEqual(ok.status, 200);
      const body = (await ok.json()) as any;
      assert.deepStrictEqual(body, {
        status: "ok",
        server: "winhelm-r7",
        runtime: { role: "r7", generation, pid: process.pid },
      });

      const normal = await fetch(`http://127.0.0.1:${port}/mcp`);
      assert.strictEqual(normal.status, 204);
    } finally {
      await close(server);
    }
  });

  it("allows the shared verifier to require the R7 health server identity", async () => {
    const rec = {
      schemaVersion: 1 as const,
      role: "r7",
      generation: "33333333-3333-4333-8333-333333333333",
      state: "ready" as const,
      host: "127.0.0.1",
      port: 49153,
      pid: 4343,
      processCreatedAt: "2026-10-18T06:00:00.000Z",
      executablePath: EXE,
      entrypointPath: "D:\\mcp\\candidate\\r7\\live-server.mjs",
      publishedAt: "2026-10-18T06:00:01.000Z",
    };
    const observed: RuntimeEndpointObservation = {
      processExists: true,
      processCreatedAt: rec.processCreatedAt,
      executablePath: rec.executablePath,
      commandLine: `"${EXE}" "${rec.entrypointPath}"`,
      listeners: [{ localAddress: rec.host, port: rec.port, owningPid: rec.pid }],
    };

    const good = await resolveVerifiedRuntimeEndpoint({
      role: "r7",
      expectedExecutablePath: rec.executablePath,
      expectedEntrypointPath: rec.entrypointPath,
      expectedHealthServer: "winhelm-r7",
      filePath: path.join(os.tmpdir(), "does-not-exist-r7.json"),
      observe: async () => observed,
      probeHealth: async () => ({
        status: "ok",
        server: "winhelm-r7",
        runtime: { role: "r7", generation: rec.generation, pid: rec.pid },
      }),
    });
    assert.strictEqual(good, undefined);

    // Verify the health identity contract directly through the record verifier path
    const { verifyRuntimeEndpointRecord } = await import("../../src/runtime/endpoint-registry.js");
    assert.ok(
      await verifyRuntimeEndpointRecord(rec, {
        expectedRole: "r7",
        expectedExecutablePath: rec.executablePath,
        expectedEntrypointPath: rec.entrypointPath,
        expectedHealthServer: "winhelm-r7",
        observe: async () => observed,
        probeHealth: async () => ({
          status: "ok",
          server: "winhelm-r7",
          runtime: { role: "r7", generation: rec.generation, pid: rec.pid },
        }),
      })
    );
    assert.strictEqual(
      await verifyRuntimeEndpointRecord(rec, {
        expectedRole: "r7",
        expectedExecutablePath: rec.executablePath,
        expectedEntrypointPath: rec.entrypointPath,
        expectedHealthServer: "winhelm-r7",
        observe: async () => observed,
        probeHealth: async () => ({
          status: "ok",
          server: "winhelm-mcp",
          runtime: { role: "r7", generation: rec.generation, pid: rec.pid },
        }),
      }),
      undefined
    );
  });

  it("binds R7 auto race-safely, publishes a verified r7.json, and persists sticky port only after readiness", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r7-runtime-"));
    const registry = path.join(dir, "r7.json");
    const preference = path.join(dir, "r7-pref.json");
    const entrypoint = fileURLToPath(import.meta.url);
    let server: Server | undefined;

    try {
      const started = await startR7Runtime({
        listenerSelection: { mode: "auto" },
        listenerHost: "127.0.0.1",
        coreBackend: {
          selection: { mode: "fixed", port: 18788 },
          host: "127.0.0.1",
        },
        createServer: () =>
          http.createServer((req, res) => {
            res.writeHead(404);
            res.end();
          }),
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: entrypoint,
        registryPath: registry,
        preferencePath: preference,
      });
      server = started.server;

      assert.ok(started.port > 0);
      assert.strictEqual(started.backend.port, 18788);
      assert.strictEqual(readPreferredInternalPortForRole("r7", preference), started.port);

      const resolved = await resolveVerifiedRuntimeEndpoint({
        role: "r7",
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: entrypoint,
        expectedHealthServer: "winhelm-r7",
        filePath: registry,
      });
      assert.ok(resolved);
      assert.strictEqual(resolved?.port, started.port);
      assert.strictEqual(resolved?.generation, started.generation);
    } finally {
      if (server) await close(server);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a verified R7 listener alive when non-authoritative sticky persistence fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r7-pref-write-fail-"));
    const registry = path.join(dir, "r7.json");
    const generation = "88888888-8888-4888-8888-888888888888";
    const entrypoint = "D:\\mcp\\candidate\\r7\\live-server.mjs";
    let server: Server | undefined;
    let preferenceError: unknown;

    try {
      const started = await startR7Runtime({
        listenerSelection: { mode: "auto" },
        listenerHost: "127.0.0.1",
        coreBackend: {
          selection: { mode: "fixed", port: 18788 },
          host: "127.0.0.1",
        },
        createServer: () => http.createServer((_req, res) => res.end("ok")),
        expectedExecutablePath: EXE,
        expectedEntrypointPath: entrypoint,
        generation,
        registryPath: registry,
        // A directory cannot be atomically replaced as the preference file.
        preferencePath: dir,
        observe: async (target) => ({
          processExists: true,
          processCreatedAt: "2026-10-18T06:00:00.000Z",
          executablePath: EXE,
          commandLine: `"${EXE}" "${entrypoint}"`,
          listeners: [
            {
              localAddress: target.host,
              port: target.port,
              owningPid: target.pid,
            },
          ],
        }),
        probeHealth: async (record) => ({
          status: "ok",
          server: "winhelm-r7",
          runtime: {
            role: "r7",
            generation: record.generation,
            pid: record.pid,
          },
        }),
        onPreferenceWriteError: (error) => {
          preferenceError = error;
        },
      });
      server = started.server;
      assert.strictEqual(server.listening, true);
      assert.ok(preferenceError);
    } finally {
      if (server) await close(server);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back from an occupied R7 sticky port through the real bind allocator", async () => {
    const occupied = http.createServer();
    const occupiedPort = await listen(occupied);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r7-collision-"));
    const registry = path.join(dir, "r7.json");
    const preference = path.join(dir, "r7-pref.json");
    const entrypoint = fileURLToPath(import.meta.url);
    await writePreferredInternalPortForRole("r7", occupiedPort, preference);
    let server: Server | undefined;

    try {
      const started = await startR7Runtime({
        listenerSelection: { mode: "auto" },
        listenerHost: "127.0.0.1",
        preferredPort: readPreferredInternalPortForRole("r7", preference),
        coreBackend: {
          selection: { mode: "fixed", port: 18788 },
          host: "127.0.0.1",
        },
        createServer: () => http.createServer((_req, res) => res.end("ok")),
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: entrypoint,
        registryPath: registry,
        preferencePath: preference,
      });
      server = started.server;
      assert.notStrictEqual(started.port, occupiedPort);
      assert.strictEqual(readPreferredInternalPortForRole("r7", preference), started.port);
    } finally {
      if (server) await close(server);
      await close(occupied);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
