import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createServer } from "../../src/gateway/server.js";
import {
  createRuntimeGeneration,
  observeWindowsRuntimeEndpoint,
  parseRuntimeEndpointRecord,
  publishCurrentRuntimeEndpoint,
  publishRuntimeEndpointRecord,
  readRuntimeEndpointHint,
  resolveVerifiedRuntimeEndpoint,
  verifyRuntimeEndpointRecord,
  type RuntimeEndpointObservation,
  type RuntimeEndpointRecord,
} from "../../src/runtime/endpoint-registry.js";

const CREATED = "2026-10-18T06:00:00.000Z";
const EXE = "C:\\Program Files\\nodejs\\node.exe";
const ENTRY = "D:\\mcp\\winhelm-v1.4.1-dynamic-internal-ports-r1\\dist\\index.js";

function record(overrides: Partial<RuntimeEndpointRecord> = {}): RuntimeEndpointRecord {
  return {
    schemaVersion: 1,
    role: "core",
    generation: "11111111-1111-4111-8111-111111111111",
    state: "ready",
    host: "127.0.0.1",
    port: 49152,
    pid: 4242,
    processCreatedAt: CREATED,
    executablePath: EXE,
    entrypointPath: ENTRY,
    publishedAt: "2026-10-18T06:00:01.000Z",
    ...overrides,
  };
}

function observation(overrides: Partial<RuntimeEndpointObservation> = {}): RuntimeEndpointObservation {
  return {
    processExists: true,
    processCreatedAt: CREATED,
    executablePath: EXE,
    commandLine: `"${EXE}" "${ENTRY}" --port auto`,
    listeners: [{ localAddress: "127.0.0.1", port: 49152, owningPid: 4242 }],
    ...overrides,
  };
}

function verify(rec: RuntimeEndpointRecord, obs = observation(), health: unknown = undefined) {
  return verifyRuntimeEndpointRecord(rec, {
    expectedRole: "core",
    expectedExecutablePath: EXE,
    expectedEntrypointPath: ENTRY,
    observe: async () => obs,
    probeHealth: async () =>
      health ?? {
        status: "ok",
        server: "winhelm-mcp",
        runtime: {
          role: "core",
          generation: rec.generation,
          pid: rec.pid,
        },
      },
  });
}

async function closeServer(server: Server, stop: (server: Server) => Promise<void>): Promise<void> {
  if (server.listening) await stop(server);
}

describe("WinHelm v1.4.1 verified runtime endpoint registry", () => {
  it("creates a fresh UUID generation per start", () => {
    const a = createRuntimeGeneration();
    const b = createRuntimeGeneration();
    assert.match(a, /^[0-9a-f-]{36}$/i);
    assert.match(b, /^[0-9a-f-]{36}$/i);
    assert.notStrictEqual(a, b);
  });

  it("strictly parses only complete ready loopback records", () => {
    assert.deepStrictEqual(parseRuntimeEndpointRecord(record()), record());
    assert.strictEqual(parseRuntimeEndpointRecord({ ...record(), schemaVersion: 2 }), undefined);
    assert.strictEqual(parseRuntimeEndpointRecord({ ...record(), state: "starting" }), undefined);
    assert.strictEqual(parseRuntimeEndpointRecord({ ...record(), host: "0.0.0.0" }), undefined);
    assert.strictEqual(parseRuntimeEndpointRecord({ ...record(), generation: "" }), undefined);
    assert.strictEqual(parseRuntimeEndpointRecord({ ...record(), pid: 0 }), undefined);
    assert.strictEqual(parseRuntimeEndpointRecord({ ...record(), processCreatedAt: "bad" }), undefined);
  });

  it("accepts only conjunctive process, listener, entrypoint, and generation proof", async () => {
    const rec = record();
    const verified = await verify(rec);
    assert.deepStrictEqual(verified, {
      role: "core",
      generation: rec.generation,
      host: rec.host,
      port: rec.port,
      pid: rec.pid,
    });
  });

  it("accepts a sufficiently specific relative command-line entrypoint suffix", async () => {
    const rec = record();
    assert.deepStrictEqual(
      await verify(
        rec,
        observation({
          commandLine: `"${EXE}" .\\winhelm-v1.4.1-dynamic-internal-ports-r1\\dist\\index.js --port auto`,
        })
      ),
      {
        role: "core",
        generation: rec.generation,
        host: rec.host,
        port: rec.port,
        pid: rec.pid,
      }
    );
  });

  it("rejects stale PID reuse by process creation time", async () => {
    const rec = record();
    assert.strictEqual(
      await verify(rec, observation({ processCreatedAt: "2026-10-18T06:10:00.000Z" })),
      undefined
    );
  });

  it("rejects port reuse by a different listener owner", async () => {
    const rec = record();
    assert.strictEqual(
      await verify(rec, observation({
        listeners: [{ localAddress: rec.host, port: rec.port, owningPid: 9999 }],
      })),
      undefined
    );
  });

  it("rejects executable and entrypoint identity mismatch", async () => {
    const rec = record();
    assert.strictEqual(
      await verify(rec, observation({ executablePath: "C:\\evil\\node.exe" })),
      undefined
    );
    assert.strictEqual(
      await verify(rec, observation({ commandLine: `"${EXE}" "D:\\other\\index.js"` })),
      undefined
    );
  });

  it("rejects health role, pid, or generation mismatch", async () => {
    const rec = record();
    for (const runtime of [
      { role: "r7", generation: rec.generation, pid: rec.pid },
      { role: "core", generation: "22222222-2222-4222-8222-222222222222", pid: rec.pid },
      { role: "core", generation: rec.generation, pid: rec.pid + 1 },
    ]) {
      assert.strictEqual(
        await verify(rec, observation(), {
          status: "ok",
          server: "winhelm-mcp",
          runtime,
        }),
        undefined
      );
    }
  });

  it("exposes role, generation, and pid through the live health identity", async () => {
    const generation = "33333333-3333-4333-8333-333333333333";
    const created = createServer({
      port: 0,
      host: "127.0.0.1",
      internalPortSelection: { mode: "auto" },
      runtimeIdentity: { role: "core", generation },
    });
    let server: Server | undefined;

    try {
      server = await created.start();
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      assert.strictEqual(response.status, 200);
      const body = (await response.json()) as any;
      assert.deepStrictEqual(body.runtime, {
        role: "core",
        generation,
        pid: process.pid,
      });
    } finally {
      if (server) await closeServer(server, created.stop);
    }
  });

  it("retries transient current-observation failure before publication", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-endpoint-publish-retry-"));
    const file = path.join(dir, "core.json");
    const generation = "55555555-5555-4555-8555-555555555555";
    let calls = 0;

    try {
      const published = await publishCurrentRuntimeEndpoint({
        role: "core",
        generation,
        host: "127.0.0.1",
        port: 49152,
        expectedExecutablePath: EXE,
        expectedEntrypointPath: ENTRY,
        filePath: file,
        observe: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient observation failure");
          return {
            processExists: true,
            processCreatedAt: CREATED,
            executablePath: EXE,
            commandLine: `"${EXE}" .\\winhelm-v1.4.1-dynamic-internal-ports-r1\\dist\\index.js --port auto`,
            listeners: [{ localAddress: "127.0.0.1", port: 49152, owningPid: process.pid }],
          };
        },
        probeHealth: async () => ({
          status: "ok",
          server: "winhelm-mcp",
          runtime: { role: "core", generation, pid: process.pid },
        }),
      });

      assert.ok(calls >= 2);
      assert.strictEqual(published.pid, process.pid);
      assert.deepStrictEqual(readRuntimeEndpointHint(file), published);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses publication when current identity proof is incomplete", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-endpoint-publish-deny-"));
    const file = path.join(dir, "core.json");
    const generation = "44444444-4444-4444-8444-444444444444";

    try {
      await assert.rejects(
        publishCurrentRuntimeEndpoint({
          role: "core",
          generation,
          host: "127.0.0.1",
          port: 49152,
          expectedExecutablePath: EXE,
          expectedEntrypointPath: ENTRY,
          filePath: file,
          observe: async () => ({
            ...observation({
              listeners: [{ localAddress: "127.0.0.1", port: 49152, owningPid: process.pid + 1 }],
            }),
            processCreatedAt: CREATED,
            executablePath: EXE,
            commandLine: `"${EXE}" "${ENTRY}" --port auto`,
          }),
          probeHealth: async () => ({
            status: "ok",
            server: "winhelm-mcp",
            runtime: { role: "core", generation, pid: process.pid },
          }),
        }),
        /identity could not be proven/i
      );
      assert.strictEqual(readRuntimeEndpointHint(file), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes a live Windows endpoint only after OS and health verification", async () => {
    const generation = createRuntimeGeneration();
    const entrypoint = fileURLToPath(import.meta.url);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-endpoint-live-"));
    const file = path.join(dir, "core.json");
    const created = createServer({
      port: 0,
      host: "127.0.0.1",
      internalPortSelection: { mode: "auto" },
      runtimeIdentity: { role: "core", generation },
    });
    let server: Server | undefined;

    try {
      server = await created.start();
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const observed = await observeWindowsRuntimeEndpoint({
        pid: process.pid,
        host: address.address,
        port: address.port,
      });
      assert.strictEqual(observed.processExists, true);
      assert.strictEqual(observed.executablePath?.toLowerCase(), process.execPath.toLowerCase());
      const entrypointTail = entrypoint
        .replace(/\//g, "\\")
        .toLowerCase()
        .split("\\")
        .filter(Boolean)
        .slice(-3)
        .join("\\");
      assert.ok(
        observed.commandLine
          ?.replace(/\//g, "\\")
          .toLowerCase()
          .includes(entrypointTail)
      );
      assert.ok(
        observed.listeners.some(
          (listener) =>
            listener.localAddress === address.address &&
            listener.port === address.port &&
            listener.owningPid === process.pid
        )
      );

      const published = await publishCurrentRuntimeEndpoint({
        role: "core",
        generation,
        host: address.address,
        port: address.port,
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: entrypoint,
        filePath: file,
      });

      assert.strictEqual(published.pid, process.pid);
      assert.strictEqual(published.generation, generation);
      assert.deepStrictEqual(readRuntimeEndpointHint(file), published);
    } finally {
      if (server) await closeServer(server, created.stop);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a hint only through the verified consumer path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-endpoint-resolve-"));
    const file = path.join(dir, "core.json");
    const rec = record();

    try {
      await publishRuntimeEndpointRecord(rec, file);
      const resolved = await resolveVerifiedRuntimeEndpoint({
        role: "core",
        expectedExecutablePath: EXE,
        expectedEntrypointPath: ENTRY,
        filePath: file,
        observe: async () => observation(),
        probeHealth: async () => ({
          status: "ok",
          server: "winhelm-mcp",
          runtime: { role: "core", generation: rec.generation, pid: rec.pid },
        }),
      });
      assert.deepStrictEqual(resolved, {
        role: "core",
        generation: rec.generation,
        host: rec.host,
        port: rec.port,
        pid: rec.pid,
      });

      await fs.writeFile(file, JSON.stringify({ host: rec.host, port: rec.port }), "utf8");
      assert.strictEqual(
        await resolveVerifiedRuntimeEndpoint({
          role: "core",
          expectedExecutablePath: EXE,
          expectedEntrypointPath: ENTRY,
          filePath: file,
          observe: async () => {
            throw new Error("must not observe invalid hint");
          },
          probeHealth: async () => {
            throw new Error("must not probe invalid hint");
          },
        }),
        undefined
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes atomically and reads the record only as a strict hint", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-endpoint-registry-"));
    const file = path.join(dir, "core.json");
    const rec = record();

    try {
      await publishRuntimeEndpointRecord(rec, file);
      assert.deepStrictEqual(readRuntimeEndpointHint(file), rec);

      await fs.writeFile(file, JSON.stringify({ host: rec.host, port: rec.port }), "utf8");
      assert.strictEqual(readRuntimeEndpointHint(file), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
