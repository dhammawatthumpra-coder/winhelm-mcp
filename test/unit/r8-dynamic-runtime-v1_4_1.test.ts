import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  publishObservedRuntimeEndpoint,
  readRuntimeEndpointHint,
  type RuntimeEndpointObservation,
  type RuntimeEndpointRecord,
} from "../../src/runtime/endpoint-registry.js";
import {
  resolveR8R7Upstream,
  publishR8RuntimeEndpoint,
} from "../../src/runtime/r8-runtime.js";

const EXE = "D:\\mcp\\candidate\\winhelm-r8.exe";
const R7_ENTRY =
  "D:\\mcp\\winhelm-v1.4.1-dynamic-internal-ports-r1\\prototype\\dynamic-internal-ports\\r7\\live-server-dynamic-upstream.mjs";

describe("WinHelm v1.4.1 Phase 4 R8 dynamic runtime", () => {
  it("preserves the fixed legacy R7 upstream without discovery", async () => {
    let calls = 0;
    const upstream = await resolveR8R7Upstream({
      selection: { mode: "fixed", port: 64239 },
      host: "127.0.0.1",
      resolveVerified: async () => {
        calls += 1;
        return undefined;
      },
    });
    assert.deepStrictEqual(upstream, {
      mode: "fixed",
      host: "127.0.0.1",
      port: 64239,
    });
    assert.strictEqual(calls, 0);
  });

  it("uses only a verified R7 endpoint in auto upstream mode", async () => {
    const upstream = await resolveR8R7Upstream({
      selection: { mode: "auto" },
      host: "127.0.0.1",
      expectedR7ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      expectedR7EntrypointPath: R7_ENTRY,
      resolveVerified: async (options) => {
        assert.strictEqual(options.role, "r7");
        assert.strictEqual(options.expectedHealthServer, "winhelm-r7");
        return {
          role: "r7",
          generation: "11111111-1111-4111-8111-111111111111",
          host: "127.0.0.1",
          port: 64066,
          pid: 39868,
        };
      },
    });
    assert.deepStrictEqual(upstream, {
      mode: "auto",
      host: "127.0.0.1",
      port: 64066,
      generation: "11111111-1111-4111-8111-111111111111",
      pid: 39868,
    });
  });

  it("fails closed before R8 launch when verified R7 discovery is unavailable", async () => {
    await assert.rejects(
      resolveR8R7Upstream({
        selection: { mode: "auto" },
        host: "127.0.0.1",
        expectedR7ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
        expectedR7EntrypointPath: R7_ENTRY,
        resolveVerified: async () => undefined,
      }),
      /verified R7 runtime endpoint is unavailable/i
    );
  });

  it("rejects a forged R7 registry hint through the real shared verifier", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r8-forged-r7-"));
    const registry = path.join(dir, "r7.json");
    try {
      await fs.writeFile(
        registry,
        JSON.stringify(
          {
            schemaVersion: 1,
            role: "r7",
            generation: "22222222-2222-4222-8222-222222222222",
            state: "ready",
            host: "127.0.0.1",
            port: 64066,
            pid: 999999,
            processCreatedAt: "2026-10-18T06:00:00.000Z",
            executablePath: "C:\\Program Files\\nodejs\\node.exe",
            entrypointPath: R7_ENTRY,
            publishedAt: "2026-10-18T06:00:01.000Z",
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      await assert.rejects(
        resolveR8R7Upstream({
          selection: { mode: "auto" },
          host: "127.0.0.1",
          expectedR7ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
          expectedR7EntrypointPath: R7_ENTRY,
          r7RegistryPath: registry,
        }),
        /verified R7 runtime endpoint is unavailable/i
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes a child R8 endpoint only after child PID/listener/health proof", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r8-publish-"));
    const registry = path.join(dir, "r8.json");
    const generation = "33333333-3333-4333-8333-333333333333";
    const pid = 5151;
    const port = 62001;
    const created = "2026-10-18T06:00:00.000Z";
    const observation: RuntimeEndpointObservation = {
      processExists: true,
      processCreatedAt: created,
      executablePath: EXE,
      commandLine: `"${EXE}" --config D:\\mcp\\candidate\\r8.json`,
      listeners: [{ localAddress: "127.0.0.1", port, owningPid: pid }],
    };

    try {
      const record = await publishObservedRuntimeEndpoint({
        role: "r8",
        generation,
        pid,
        host: "127.0.0.1",
        port,
        expectedExecutablePath: EXE,
        expectedEntrypointPath: EXE,
        expectedHealthServer: "winhelm-r8",
        filePath: registry,
        observe: async () => observation,
        probeHealth: async () => ({
          status: "ok",
          server: "winhelm-r8",
          runtime: { role: "r8", generation, pid },
        }),
      });
      assert.strictEqual(record.pid, pid);
      assert.strictEqual(record.port, port);
      assert.deepStrictEqual(readRuntimeEndpointHint(registry), record);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes a real Windows child endpoint only after OS listener and live health proof", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r8-live-child-"));
    const registry = path.join(dir, "r8.json");
    const childScript = path.join(dir, "runtime", "child", "r8-child.mjs");
    const generation = "55555555-5555-4555-8555-555555555555";
    await fs.mkdir(path.dirname(childScript), { recursive: true });
    await fs.writeFile(
      childScript,
      `import http from "node:http";
const generation = process.env.TEST_GENERATION;
const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.headers["x-winhelm-runtime-generation"] === generation) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      server: "winhelm-r8",
      runtime: { role: "r8", generation, pid: process.pid }
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
process.on("SIGINT", () => server.close(() => process.exit(0)));
`,
      "utf8"
    );

    const child = spawn(process.execPath, [childScript], {
      env: { ...process.env, TEST_GENERATION: generation },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    try {
      child.stdout.setEncoding("utf8");
      const [chunk] = (await once(child.stdout, "data")) as [string];
      const ready = JSON.parse(String(chunk).trim()) as { port: number };
      assert.ok(Number.isInteger(ready.port) && ready.port > 0);

      const record = await publishObservedRuntimeEndpoint({
        role: "r8",
        generation,
        pid: child.pid!,
        host: "127.0.0.1",
        port: ready.port,
        expectedExecutablePath: process.execPath,
        expectedEntrypointPath: childScript,
        expectedHealthServer: "winhelm-r8",
        filePath: registry,
        probeHealth: async (candidate) => {
          const response = await fetch(
            `http://127.0.0.1:${candidate.port}/health`,
            {
              headers: {
                "x-winhelm-runtime-generation": candidate.generation,
              },
            }
          );
          assert.strictEqual(response.status, 200);
          return response.json();
        },
      });

      assert.strictEqual(record.pid, child.pid);
      assert.strictEqual(record.port, ready.port);
      assert.deepStrictEqual(readRuntimeEndpointHint(registry), record);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit").catch(() => {});
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses R8 publication when the listener belongs to another PID", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-r8-deny-"));
    const registry = path.join(dir, "r8.json");
    try {
      await assert.rejects(
        publishR8RuntimeEndpoint({
          generation: "44444444-4444-4444-8444-444444444444",
          pid: 5151,
          host: "127.0.0.1",
          port: 62002,
          expectedExecutablePath: EXE,
          registryPath: registry,
          observe: async () => ({
            processExists: true,
            processCreatedAt: "2026-10-18T06:00:00.000Z",
            executablePath: EXE,
            commandLine: `"${EXE}" --config x.json`,
            listeners: [
              { localAddress: "127.0.0.1", port: 62002, owningPid: 6161 },
            ],
          }),
          probeHealth: async () => ({
            status: "ok",
            server: "winhelm-r8",
            runtime: {
              role: "r8",
              generation: "44444444-4444-4444-8444-444444444444",
              pid: 5151,
            },
          }),
        }),
        /identity could not be proven/i
      );
      assert.strictEqual(readRuntimeEndpointHint(registry), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
