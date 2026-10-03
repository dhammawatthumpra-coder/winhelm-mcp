import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  NetworkPolicyError,
  safeHttpRequest,
} from "../../src/engine/safe-http.js";
import type { NetworkResolver } from "../../src/permissions/network-target.js";

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

const loopbackResolver: NetworkResolver = async () => [
  { address: "127.0.0.1", family: 4 },
];

describe("Schema-v2 safe HTTP transport", () => {
  it("pins the vetted DNS address instead of resolving the hostname again", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ host: req.headers.host }));
      },
      async (port) => {
        const response = await safeHttpRequest({
          url: `http://example.invalid:${port}/hello`,
          allowLoopback: true,
          resolver: loopbackResolver,
        });

        assert.strictEqual(response.status, 200);
        assert.match(response.body, /example\.invalid/);
        assert.strictEqual(response.redirects.length, 0);
      }
    );
  });

  it("blocks a loopback destination before connecting when loopback is disabled", async () => {
    await withServer(
      (_req, res) => {
        res.end("should-not-be-reached");
      },
      async (port) => {
        await assert.rejects(
          () =>
            safeHttpRequest({
              url: `http://fixture.invalid:${port}/`,
              allowLoopback: false,
              resolver: loopbackResolver,
            }),
          (err: any) =>
            err instanceof NetworkPolicyError &&
            err.code === "NETWORK_LOOPBACK_BLOCKED"
        );
      }
    );
  });

  it("re-validates redirect targets and blocks metadata before the next connection", async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 302;
        res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
        res.end();
      },
      async (port) => {
        await assert.rejects(
          () =>
            safeHttpRequest({
              url: `http://redirector.invalid:${port}/`,
              allowLoopback: true,
              resolver: loopbackResolver,
            }),
          (err: any) =>
            err instanceof NetworkPolicyError &&
            err.code === "NETWORK_METADATA_BLOCKED"
        );
      }
    );
  });

  it("follows a safe redirect and records the redirect chain", async () => {
    await withServer(
      (req, res) => {
        if (req.url === "/start") {
          res.statusCode = 302;
          res.setHeader("location", "/done");
          res.end();
          return;
        }
        res.end("done");
      },
      async (port) => {
        const response = await safeHttpRequest({
          url: `http://redirect-safe.invalid:${port}/start`,
          allowLoopback: true,
          resolver: loopbackResolver,
        });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body, "done");
        assert.strictEqual(response.redirects.length, 1);
        assert.match(response.finalUrl, /\/done$/);
      }
    );
  });

  it("strips Authorization and Cookie on cross-origin redirects", async () => {
    await withServer(
      (req, res) => {
        res.end(
          JSON.stringify({
            authorization: req.headers.authorization ?? null,
            cookie: req.headers.cookie ?? null,
          })
        );
      },
      async (targetPort) => {
        await withServer(
          (_req, res) => {
            res.statusCode = 302;
            res.setHeader(
              "location",
              `http://target.invalid:${targetPort}/final`
            );
            res.end();
          },
          async (sourcePort) => {
            const response = await safeHttpRequest({
              url: `http://source.invalid:${sourcePort}/start`,
              allowLoopback: true,
              resolver: loopbackResolver,
              headers: {
                Authorization: "Bearer secret",
                Cookie: "session=secret",
                "X-Test": "keep",
              },
            });
            const parsed = JSON.parse(response.body);
            assert.strictEqual(parsed.authorization, null);
            assert.strictEqual(parsed.cookie, null);
          }
        );
      }
    );
  });

  it("blocks the active WinHelm effective port even when loopback is allowed", async () => {
    await withServer(
      (_req, res) => res.end("self"),
      async (port) => {
        await assert.rejects(
          () =>
            safeHttpRequest({
              url: `http://127.0.0.1:${port}/`,
              allowLoopback: true,
              effectivePort: port,
            }),
          (err: any) =>
            err instanceof NetworkPolicyError &&
            err.code === "NETWORK_SELF_PORT_BLOCKED"
        );
      }
    );
  });
});
