import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export type NetworkBlockCode =
  | "NETWORK_INVALID_URL"
  | "NETWORK_UNSUPPORTED_PROTOCOL"
  | "NETWORK_DNS_FAILED"
  | "NETWORK_LOOPBACK_BLOCKED"
  | "NETWORK_LINK_LOCAL_BLOCKED"
  | "NETWORK_METADATA_BLOCKED"
  | "NETWORK_UNSPECIFIED_BLOCKED"
  | "NETWORK_SELF_PORT_BLOCKED";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface NetworkTargetValidation {
  allowed: boolean;
  code?: NetworkBlockCode;
  reason?: string;
  url: URL;
  addresses: ResolvedAddress[];
}

export type NetworkResolver = (
  hostname: string
) => Promise<ResolvedAddress[]>;

export interface NetworkTargetPolicyOptions {
  allowLoopback?: boolean;
  effectivePort?: number;
  resolver?: NetworkResolver;
}

const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
]);

const METADATA_IPV4 = new Set([
  "169.254.169.254",
  "100.100.100.200",
]);

const METADATA_IPV6 = new Set([
  "fd00:ec2::254",
]);

function normalizeHostname(hostname: string): string {
  let value = hostname.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  while (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

function effectiveUrlPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function mappedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  return undefined;
}

function classifyIpv4(
  address: string,
  allowLoopback: boolean
): { code?: NetworkBlockCode; reason?: string } {
  if (METADATA_IPV4.has(address)) {
    return {
      code: "NETWORK_METADATA_BLOCKED",
      reason: `Cloud metadata endpoint is blocked: ${address}`,
    };
  }

  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return {
      code: "NETWORK_DNS_FAILED",
      reason: `Invalid resolved IPv4 address: ${address}`,
    };
  }

  if (octets[0] === 0) {
    return {
      code: "NETWORK_UNSPECIFIED_BLOCKED",
      reason: `Unspecified/reserved destination is blocked: ${address}`,
    };
  }

  if (octets[0] === 127 && !allowLoopback) {
    return {
      code: "NETWORK_LOOPBACK_BLOCKED",
      reason: `Loopback destination is blocked: ${address}`,
    };
  }

  if (octets[0] === 169 && octets[1] === 254) {
    return {
      code: "NETWORK_LINK_LOCAL_BLOCKED",
      reason: `Link-local destination is blocked: ${address}`,
    };
  }

  return {};
}

function classifyIpv6(
  address: string,
  allowLoopback: boolean
): { code?: NetworkBlockCode; reason?: string } {
  const normalized = address.toLowerCase().split("%")[0];

  const mapped = mappedIpv4(normalized);
  if (mapped) return classifyIpv4(mapped, allowLoopback);

  if (METADATA_IPV6.has(normalized)) {
    return {
      code: "NETWORK_METADATA_BLOCKED",
      reason: `Cloud metadata endpoint is blocked: ${address}`,
    };
  }

  if (normalized === "::") {
    return {
      code: "NETWORK_UNSPECIFIED_BLOCKED",
      reason: "IPv6 unspecified destination is blocked.",
    };
  }

  if (normalized === "::1" && !allowLoopback) {
    return {
      code: "NETWORK_LOOPBACK_BLOCKED",
      reason: "IPv6 loopback destination is blocked.",
    };
  }

  // fe80::/10 covers fe8x, fe9x, feax and febx.
  if (/^fe[89ab]/i.test(normalized)) {
    return {
      code: "NETWORK_LINK_LOCAL_BLOCKED",
      reason: `IPv6 link-local destination is blocked: ${address}`,
    };
  }

  return {};
}

function classifyAddress(
  address: string,
  allowLoopback: boolean
): { code?: NetworkBlockCode; reason?: string } {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address, allowLoopback);
  if (family === 6) return classifyIpv6(address, allowLoopback);
  return {
    code: "NETWORK_DNS_FAILED",
    reason: `Resolver returned a non-IP address: ${address}`,
  };
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  const result = await dns.lookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));
}

/**
 * Validate one HTTP(S) destination after hostname parsing and DNS resolution.
 * Every resolved address must be acceptable; mixed safe/blocked DNS answers
 * fail closed.
 */
export async function validateNetworkTarget(
  input: string | URL,
  options: NetworkTargetPolicyOptions = {}
): Promise<NetworkTargetValidation> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    url = new URL("http://invalid.invalid/");
    return {
      allowed: false,
      code: "NETWORK_INVALID_URL",
      reason: "Invalid URL.",
      url,
      addresses: [],
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      code: "NETWORK_UNSUPPORTED_PROTOCOL",
      reason: `Only http: and https: URLs are supported (got ${url.protocol}).`,
      url,
      addresses: [],
    };
  }

  const effectivePort = effectiveUrlPort(url);
  if (
    Number.isInteger(options.effectivePort) &&
    (options.effectivePort as number) > 0 &&
    effectivePort === options.effectivePort
  ) {
    return {
      allowed: false,
      code: "NETWORK_SELF_PORT_BLOCKED",
      reason: `Destination port ${effectivePort} is reserved for the active WinHelm listener.`,
      url,
      addresses: [],
    };
  }

  const hostname = normalizeHostname(url.hostname);
  if (METADATA_HOSTNAMES.has(hostname)) {
    return {
      allowed: false,
      code: "NETWORK_METADATA_BLOCKED",
      reason: `Cloud metadata hostname is blocked: ${hostname}`,
      url,
      addresses: [],
    };
  }

  const allowLoopback = options.allowLoopback === true;
  const resolver = options.resolver ?? defaultResolver;
  let addresses: ResolvedAddress[];

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch (err) {
      return {
        allowed: false,
        code: "NETWORK_DNS_FAILED",
        reason: `DNS resolution failed for ${hostname}: ${(err as Error).message}`,
        url,
        addresses: [],
      };
    }
  }

  if (addresses.length === 0) {
    return {
      allowed: false,
      code: "NETWORK_DNS_FAILED",
      reason: `DNS resolution returned no addresses for ${hostname}.`,
      url,
      addresses: [],
    };
  }

  for (const entry of addresses) {
    const block = classifyAddress(entry.address, allowLoopback);
    if (block.code) {
      return {
        allowed: false,
        code: block.code,
        reason: block.reason,
        url,
        addresses,
      };
    }
  }

  return {
    allowed: true,
    url,
    addresses,
  };
}
