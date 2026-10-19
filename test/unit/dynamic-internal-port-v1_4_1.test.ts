import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bindInternalListener,
  readPreferredInternalPort,
  resolveInternalPortSelection,
  writePreferredInternalPort,
} from "../../src/runtime/internal-port.js";
import { createServer } from "../../src/gateway/server.js";

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function occupyLoopbackPort(): Promise<{ server: Server; port: number }> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

describe("WinHelm v1.4.1 dynamic internal port selection", () => {
  it("preserves CLI > environment > legacy default precedence for fixed ports", () => {
    assert.deepStrictEqual(
      resolveInternalPortSelection({
        cliPort: "18788",
        envPort: "19999",
        host: "127.0.0.1",
      }),
      { mode: "fixed", port: 18788 }
    );

    assert.deepStrictEqual(
      resolveInternalPortSelection({
        envPort: "19999",
        host: "127.0.0.1",
      }),
      { mode: "fixed", port: 19999 }
    );

    assert.deepStrictEqual(
      resolveInternalPortSelection({
        host: "127.0.0.1",
      }),
      { mode: "fixed", port: 8788 }
    );
  });

  it("preserves legacy empty PORT environment fallback to 8788", () => {
    assert.deepStrictEqual(
      resolveInternalPortSelection({
        envPort: "",
        host: "127.0.0.1",
      }),
      { mode: "fixed", port: 8788 }
    );

    assert.throws(
      () =>
        resolveInternalPortSelection({
          cliPort: "",
          envPort: "18788",
          host: "127.0.0.1",
        }),
      /port/i
    );
  });

  it("accepts explicit auto only for loopback hosts", () => {
    assert.deepStrictEqual(
      resolveInternalPortSelection({
        cliPort: "auto",
        envPort: "18788",
        host: "127.0.0.1",
      }),
      { mode: "auto" }
    );

    assert.deepStrictEqual(
      resolveInternalPortSelection({
        envPort: "AUTO",
        host: "::1",
      }),
      { mode: "auto" }
    );

    assert.throws(
      () =>
        resolveInternalPortSelection({
          cliPort: "auto",
          host: "0.0.0.0",
        }),
      /loopback/i
    );
  });

  it("auto mode retries by real bind when the sticky preferred port is occupied", async () => {
    const occupied = await occupyLoopbackPort();
    let dynamic: Server | undefined;

    try {
      const result = await bindInternalListener({
        selection: { mode: "auto" },
        host: "127.0.0.1",
        preferredPort: occupied.port,
        listen: (port, host) => createHttpServer().listen(port, host),
      });
      dynamic = result.server;

      assert.notStrictEqual(result.port, occupied.port);
      assert.ok(result.port > 0);
    } finally {
      if (dynamic) await closeServer(dynamic);
      await closeServer(occupied.server);
    }
  });

  it("createServer honors auto selection instead of a conflicting legacy port field", async () => {
    const occupied = await occupyLoopbackPort();
    let dynamic: Server | undefined;
    let stop: ((server: Server) => Promise<void>) | undefined;

    try {
      const created = createServer({
        port: occupied.port,
        host: "127.0.0.1",
        internalPortSelection: { mode: "auto" },
      });
      stop = created.stop;
      dynamic = await created.start();

      const address = dynamic.address();
      assert.ok(address && typeof address === "object");
      assert.notStrictEqual(address.port, occupied.port);
      assert.ok(address.port > 0);
    } finally {
      if (dynamic && stop) await stop(dynamic);
      await closeServer(occupied.server);
    }
  });

  it("bind primitive independently rejects auto allocation on non-loopback hosts", async () => {
    let listenCalled = false;

    await assert.rejects(
      bindInternalListener({
        selection: { mode: "auto" },
        host: "0.0.0.0",
        listen: (port, host) => {
          listenCalled = true;
          return createHttpServer().listen(port, host);
        },
      }),
      /loopback/i
    );

    assert.strictEqual(listenCalled, false);
  });

  it("auto mode does not fall back on non-collision bind errors", async () => {
    let calls = 0;

    await assert.rejects(
      bindInternalListener({
        selection: { mode: "auto" },
        host: "127.0.0.1",
        preferredPort: 23456,
        listen: () => {
          calls += 1;
          throw Object.assign(new Error("access denied"), { code: "EACCES" });
        },
      }),
      (err: unknown) =>
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "EACCES"
    );

    assert.strictEqual(calls, 1);
  });

  it("fixed mode never falls back when its requested port is occupied", async () => {
    const occupied = await occupyLoopbackPort();

    try {
      await assert.rejects(
        bindInternalListener({
          selection: { mode: "fixed", port: occupied.port },
          host: "127.0.0.1",
          listen: (port, host) => createHttpServer().listen(port, host),
        }),
        (err: unknown) =>
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      );
    } finally {
      await closeServer(occupied.server);
    }
  });

  it("treats sticky preference as an optional validated hint", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-port-pref-"));
    const file = path.join(dir, "core.json");

    try {
      assert.strictEqual(readPreferredInternalPort(file), undefined);

      await fs.writeFile(file, "{not-json", "utf8");
      assert.strictEqual(readPreferredInternalPort(file), undefined);

      await fs.writeFile(
        file,
        JSON.stringify({ schemaVersion: 1, role: "core", preferredPort: 0 }),
        "utf8"
      );
      assert.strictEqual(readPreferredInternalPort(file), undefined);

      await writePreferredInternalPort(23456, file);
      assert.strictEqual(readPreferredInternalPort(file), 23456);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed or out-of-range fixed ports", () => {
    for (const value of ["0", "65536", "-1", "1.5", "18788junk", ""]) {
      assert.throws(
        () =>
          resolveInternalPortSelection({
            cliPort: value,
            host: "127.0.0.1",
          }),
        /port/i,
        value
      );
    }
  });
});
