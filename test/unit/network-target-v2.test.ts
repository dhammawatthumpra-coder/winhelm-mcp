import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateNetworkTarget,
  type NetworkResolver,
} from "../../src/permissions/network-target.js";

function resolver(...addresses: string[]): NetworkResolver {
  return async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
}

describe("Schema-v2 network target policy", () => {
  it("blocks IPv4 and IPv6 loopback by default", async () => {
    const ipv4 = await validateNetworkTarget("http://127.0.0.1:3000/");
    assert.strictEqual(ipv4.allowed, false);
    assert.strictEqual(ipv4.code, "NETWORK_LOOPBACK_BLOCKED");

    const ipv6 = await validateNetworkTarget("http://[::1]:3000/");
    assert.strictEqual(ipv6.allowed, false);
    assert.strictEqual(ipv6.code, "NETWORK_LOOPBACK_BLOCKED");
  });

  it("can allow loopback explicitly without allowing metadata/link-local", async () => {
    const loopback = await validateNetworkTarget("http://127.0.0.1:3000/", {
      allowLoopback: true,
    });
    assert.strictEqual(loopback.allowed, true);

    const metadata = await validateNetworkTarget("http://169.254.169.254/", {
      allowLoopback: true,
    });
    assert.strictEqual(metadata.allowed, false);
    assert.strictEqual(metadata.code, "NETWORK_METADATA_BLOCKED");

    const linkLocal = await validateNetworkTarget("http://169.254.20.30/", {
      allowLoopback: true,
    });
    assert.strictEqual(linkLocal.allowed, false);
    assert.strictEqual(linkLocal.code, "NETWORK_LINK_LOCAL_BLOCKED");
  });

  it("blocks the named metadata endpoints required by the spec", async () => {
    const google = await validateNetworkTarget("http://metadata.google.internal/", {
      resolver: resolver("10.1.2.3"),
    });
    assert.strictEqual(google.allowed, false);
    assert.strictEqual(google.code, "NETWORK_METADATA_BLOCKED");

    const alibaba = await validateNetworkTarget("http://100.100.100.200/");
    assert.strictEqual(alibaba.allowed, false);
    assert.strictEqual(alibaba.code, "NETWORK_METADATA_BLOCKED");
  });

  it("does not blanket-block CGNAT 100.64.0.0/10 or RFC1918 LAN addresses", async () => {
    const cgnat = await validateNetworkTarget("http://tailscale-host.test/", {
      resolver: resolver("100.64.12.34"),
    });
    assert.strictEqual(cgnat.allowed, true);

    const rfc1918 = await validateNetworkTarget("http://lan-host.test/", {
      resolver: resolver("192.168.1.25"),
    });
    assert.strictEqual(rfc1918.allowed, true);
  });

  it("fails closed if any DNS answer is blocked", async () => {
    const result = await validateNetworkTarget("http://mixed.test/", {
      resolver: resolver("192.168.1.25", "127.0.0.1"),
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, "NETWORK_LOOPBACK_BLOCKED");
  });

  it("blocks link-local IPv6 and IPv4-mapped loopback", async () => {
    const linkLocal = await validateNetworkTarget("http://host.test/", {
      resolver: resolver("fe80::1234"),
    });
    assert.strictEqual(linkLocal.allowed, false);
    assert.strictEqual(linkLocal.code, "NETWORK_LINK_LOCAL_BLOCKED");

    const mapped = await validateNetworkTarget("http://mapped.test/", {
      resolver: resolver("::ffff:127.0.0.1"),
    });
    assert.strictEqual(mapped.allowed, false);
    assert.strictEqual(mapped.code, "NETWORK_LOOPBACK_BLOCKED");
  });

  it("blocks the current effective WinHelm port regardless of allowLoopback", async () => {
    const result = await validateNetworkTarget("http://192.168.1.25:8788/", {
      effectivePort: 8788,
      allowLoopback: true,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, "NETWORK_SELF_PORT_BLOCKED");
  });

  it("uses protocol default ports when checking the effective port", async () => {
    const result = await validateNetworkTarget("https://example.test/", {
      effectivePort: 443,
      resolver: resolver("203.0.113.10"),
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, "NETWORK_SELF_PORT_BLOCKED");
  });

  it("rejects unsupported URL protocols and DNS failures", async () => {
    const file = await validateNetworkTarget("file:///C:/Windows/win.ini");
    assert.strictEqual(file.allowed, false);
    assert.strictEqual(file.code, "NETWORK_UNSUPPORTED_PROTOCOL");

    const failed = await validateNetworkTarget("http://does-not-resolve.test/", {
      resolver: async () => {
        throw new Error("fixture DNS failure");
      },
    });
    assert.strictEqual(failed.allowed, false);
    assert.strictEqual(failed.code, "NETWORK_DNS_FAILED");
  });
});
