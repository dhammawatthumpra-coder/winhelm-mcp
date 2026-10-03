import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import {
  isLoopbackAddress,
  isLoopbackHostHeader,
  isLoopbackOrigin,
  validateAdminLocality,
} from "../../src/admin/loopback.js";

describe("Admin loopback boundary", () => {
  it("recognizes only loopback socket addresses", () => {
    for (const value of [
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "::ffff:127.0.0.1",
    ]) {
      assert.strictEqual(isLoopbackAddress(value), true, value);
    }

    for (const value of [
      "0.0.0.0",
      "192.168.1.10",
      "100.64.1.2",
      "203.0.113.10",
      "::",
      "fe80::1",
    ]) {
      assert.strictEqual(isLoopbackAddress(value), false, value);
    }
  });

  it("accepts loopback Host headers and rejects tunnel/non-loopback hosts", () => {
    for (const host of [
      "localhost",
      "localhost:8788",
      "127.0.0.1",
      "127.0.0.1:8788",
      "[::1]",
      "[::1]:8788",
    ]) {
      assert.strictEqual(isLoopbackHostHeader(host), true, host);
    }

    for (const host of [
      "winhelm.example.ts.net",
      "192.168.1.20:8788",
      "evil.example",
      "0.0.0.0:8788",
    ]) {
      assert.strictEqual(isLoopbackHostHeader(host), false, host);
    }
  });

  it("requires loopback Origin and can bind it to the runtime port", () => {
    assert.strictEqual(
      isLoopbackOrigin("http://127.0.0.1:8788", 8788),
      true
    );
    assert.strictEqual(
      isLoopbackOrigin("http://localhost:8788", 8788),
      true
    );
    assert.strictEqual(
      isLoopbackOrigin("http://[::1]:8788", 8788),
      true
    );
    assert.strictEqual(
      isLoopbackOrigin("http://localhost:9999", 8788),
      false
    );
    assert.strictEqual(
      isLoopbackOrigin("https://example.ts.net", 443),
      false
    );
  });

  function fakeRequest(remoteAddress: string, host: string): Request {
    return {
      socket: { remoteAddress },
      ip: remoteAddress,
      get(name: string) {
        return name.toLowerCase() === "host" ? host : undefined;
      },
    } as unknown as Request;
  }

  it("validates both socket locality and Host header", () => {
    assert.deepStrictEqual(
      validateAdminLocality(fakeRequest("127.0.0.1", "localhost:8788")),
      { allowed: true }
    );

    const remote = validateAdminLocality(
      fakeRequest("100.64.1.2", "localhost:8788")
    );
    assert.strictEqual(remote.allowed, false);
    assert.strictEqual(remote.code, "ADMIN_REMOTE_BLOCKED");

    const host = validateAdminLocality(
      fakeRequest("127.0.0.1", "example.ts.net")
    );
    assert.strictEqual(host.allowed, false);
    assert.strictEqual(host.code, "ADMIN_HOST_BLOCKED");
  });
});
