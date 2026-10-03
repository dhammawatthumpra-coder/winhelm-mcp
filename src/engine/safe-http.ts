import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import { isIP } from "node:net";
import {
  validateNetworkTarget,
  type NetworkResolver,
  type NetworkTargetPolicyOptions,
  type ResolvedAddress,
} from "../permissions/network-target.js";

export interface SafeHttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  allowLoopback?: boolean;
  effectivePort?: number;
  resolver?: NetworkResolver;
}

export interface SafeHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  redirects: string[];
}

export class NetworkPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result[name] = value.join(", ");
    } else if (value !== undefined) {
      result[name] = String(value);
    }
  }
  return result;
}

function stripSensitiveRedirectHeaders(
  headers: Record<string, string>,
  from: URL,
  to: URL
): Record<string, string> {
  if (from.origin === to.origin) return { ...headers };

  const blocked = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "cookie2",
  ]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

function requestOnce(
  url: URL,
  address: ResolvedAddress,
  options: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;

    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
      timeout: options.timeoutMs,
      lookup: ((_hostname: string, lookupOptions: any, callback: any) => {
        // Node 20+ may request { all: true } for Happy Eyeballs. Preserve the
        // vetted/pinned address in either callback shape instead of letting
        // the runtime perform a second DNS lookup.
        if (lookupOptions && lookupOptions.all === true) {
          callback(null, [
            { address: address.address, family: address.family as 4 | 6 },
          ]);
          return;
        }
        callback(null, address.address, address.family as 4 | 6);
      }) as any,
    };

    if (url.protocol === "https:" && !isIP(hostname)) {
      (requestOptions as https.RequestOptions).servername = hostname;
    }

    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

      res.on("data", (chunk: Buffer) => {
        if (totalBytes >= MAX_RESPONSE_BYTES) return;
        const remaining = MAX_RESPONSE_BYTES - totalBytes;
        const part = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        chunks.push(part);
        totalBytes += part.length;
      });

      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          headers: normalizeHeaders(res.headers),
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`HTTP request timed out after ${options.timeoutMs}ms`));
    });
    req.on("error", reject);

    if (options.body && !["GET", "HEAD"].includes(options.method)) {
      req.write(options.body);
    }
    req.end();
  });
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function redirectedMethod(
  status: number,
  currentMethod: string
): { method: string; keepBody: boolean } {
  if (status === 303) return { method: "GET", keepBody: false };
  if ((status === 301 || status === 302) && currentMethod === "POST") {
    return { method: "GET", keepBody: false };
  }
  return { method: currentMethod, keepBody: true };
}

/**
 * HTTP(S) transport for schema-v2 network tools.
 *
 * Security properties:
 * - validates hostname + every DNS answer before each connection;
 * - pins the vetted address through the request lookup callback;
 * - handles redirects manually and re-validates every hop;
 * - strips credentials/cookies on cross-origin redirects.
 */
export async function safeHttpRequest(
  input: SafeHttpRequestOptions
): Promise<SafeHttpResponse> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const maxRedirects = input.maxRedirects ?? 5;
  let currentUrl = new URL(input.url);
  let method = (input.method ?? "GET").toUpperCase();
  let body = input.body;
  let headers = { ...(input.headers ?? {}) };
  const redirects: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const policy: NetworkTargetPolicyOptions = {
      allowLoopback: input.allowLoopback,
      effectivePort: input.effectivePort,
      resolver: input.resolver,
    };
    const validation = await validateNetworkTarget(currentUrl, policy);

    if (!validation.allowed) {
      throw new NetworkPolicyError(
        validation.code ?? "NETWORK_TARGET_BLOCKED",
        validation.reason ?? "Network target blocked by WinHelm policy."
      );
    }

    const selectedAddress = validation.addresses[0];
    if (!selectedAddress) {
      throw new NetworkPolicyError(
        "NETWORK_DNS_FAILED",
        "No validated destination address is available."
      );
    }

    const response = await requestOnce(currentUrl, selectedAddress, {
      method,
      headers,
      body,
      timeoutMs,
    });

    const location = response.headers.location;
    if (!isRedirect(response.status) || !location) {
      return {
        ...response,
        finalUrl: currentUrl.toString(),
        redirects,
      };
    }

    if (hop === maxRedirects) {
      throw new NetworkPolicyError(
        "NETWORK_REDIRECT_LIMIT",
        `HTTP redirect limit exceeded (${maxRedirects}).`
      );
    }

    const nextUrl = new URL(location, currentUrl);
    headers = stripSensitiveRedirectHeaders(headers, currentUrl, nextUrl);
    const nextMethod = redirectedMethod(response.status, method);
    method = nextMethod.method;
    if (!nextMethod.keepBody) {
      body = undefined;
      for (const key of Object.keys(headers)) {
        if (["content-length", "content-type"].includes(key.toLowerCase())) {
          delete headers[key];
        }
      }
    }

    redirects.push(nextUrl.toString());
    currentUrl = nextUrl;
  }

  throw new NetworkPolicyError(
    "NETWORK_REDIRECT_LIMIT",
    "HTTP redirect limit exceeded."
  );
}
