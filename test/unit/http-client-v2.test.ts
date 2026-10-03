import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  executeHttpRequest,
  pingEndpoint,
} from "../../src/engine/http-client.js";

async function withServer(
  handler: http.RequestListener,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withConfig(
  value: Record<string, unknown>,
  fn: (manager: ConfigManager) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-http-v2-"));
  const configFile = path.join(dir, "config.json");
  await fs.writeFile(configFile, JSON.stringify(value, null, 2), "utf-8");
  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    await fn(manager);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    ConfigManager.resetInstance();
  }
}

function v2Config(allowLoopback: boolean): Record<string, unknown> {
  return {
    schemaVersion: 2,
    folders: [],
    terminal: { mode: "off" },
    toolPolicy: { http_ping: "auto", http_request: "auto" },
    network: { allowLoopback },
  };
}

describe("Schema-v2 HTTP client integration", () => {
  it("preserves legacy localhost HTTP behavior", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 200;
        res.end("legacy-ok");
      },
      async (port) => {
        const manager = ConfigManager.resetInstance();
        assert.strictEqual(manager.getConfigMode(), "legacy");

        const result = await executeHttpRequest({
          url: `http://127.0.0.1:${port}/`,
        });
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body, "legacy-ok");
      }
    );
  });

  it("blocks loopback by default in schema-v2", async () => {
    await withServer(
      (_req, res) => res.end("blocked"),
      async (port) => {
        await withConfig(v2Config(false), async () => {
          const ping = await pingEndpoint(`http://127.0.0.1:${port}/`);
          assert.strictEqual(ping.ok, false);
          assert.strictEqual(ping.status, 0);
          assert.match(ping.statusText, /NETWORK_LOOPBACK_BLOCKED/);

          const request = await executeHttpRequest({
            url: `http://127.0.0.1:${port}/`,
          });
          assert.strictEqual(request.status, 0);
          assert.match(request.statusText, /NETWORK_LOOPBACK_BLOCKED/);
        });
      }
    );
  });

  it("allows loopback when explicitly enabled and parses JSON response", async () => {
    await withServer(
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      },
      async (port) => {
        await withConfig(v2Config(true), async (manager) => {
          manager.setRuntimeEffectivePort(undefined);

          const result = await executeHttpRequest({
            url: `http://127.0.0.1:${port}/`,
          });
          assert.strictEqual(result.status, 200);
          assert.strictEqual(result.isJson, true);
          assert.deepStrictEqual(result.json, { ok: true });
        });
      }
    );
  });

  it("blocks the runtime effective WinHelm port even with allowLoopback enabled", async () => {
    await withServer(
      (_req, res) => res.end("self"),
      async (port) => {
        await withConfig(v2Config(true), async (manager) => {
          manager.setRuntimeEffectivePort(port);

          const result = await executeHttpRequest({
            url: `http://127.0.0.1:${port}/`,
          });
          assert.strictEqual(result.status, 0);
          assert.match(result.statusText, /NETWORK_SELF_PORT_BLOCKED/);
        });
      }
    );
  });

  it("re-checks redirects in the integrated schema-v2 client", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 302;
        res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
        res.end();
      },
      async (port) => {
        await withConfig(v2Config(true), async () => {
          const result = await executeHttpRequest({
            url: `http://127.0.0.1:${port}/start`,
          });
          assert.strictEqual(result.status, 0);
          assert.match(result.statusText, /NETWORK_METADATA_BLOCKED/);
        });
      }
    );
  });
});
