import type { HttpPingResult, HttpRequestOptions, HttpRequestResult } from "../types/index.js";
import { ConfigManager } from "../config/config-manager.js";
import { safeHttpRequest } from "./safe-http.js";

function activeV2NetworkPolicy(): {
  enabled: boolean;
  allowLoopback: boolean;
  effectivePort?: number;
} {
  const manager = ConfigManager.getInstance();
  const config = manager.getConfig();
  return {
    enabled: manager.getConfigMode() === "v2",
    allowLoopback: config.network?.allowLoopback === true,
    effectivePort: manager.getRuntimeEffectivePort(),
  };
}

/**
 * Fast HTTP health check ping for local/remote servers.
 * Legacy mode preserves v1.2.1 fetch behavior. Schema-v2 uses the guarded,
 * DNS-pinned transport and validates every redirect hop.
 */
export async function pingEndpoint(
  url: string,
  timeoutMs = 5000,
  expectedStatus?: number
): Promise<HttpPingResult> {
  const start = Date.now();
  try {
    const policy = activeV2NetworkPolicy();
    let status: number;
    let statusText: string;

    if (policy.enabled) {
      const res = await safeHttpRequest({
        url,
        method: "GET",
        timeoutMs,
        allowLoopback: policy.allowLoopback,
        effectivePort: policy.effectivePort,
      });
      status = res.status;
      statusText = res.statusText;
    } else {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      statusText = res.statusText;
    }

    const latencyMs = Date.now() - start;
    const isExpected = expectedStatus
      ? status === expectedStatus
      : status >= 200 && status < 300;

    return {
      ok: isExpected,
      status,
      statusText,
      latencyMs,
      url,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      statusText: err?.code
        ? `${err.code}: ${err.message}`
        : err?.message || "Connection failed or timed out",
      latencyMs: Date.now() - start,
      url,
    };
  }
}

function prepareRequestHeaders(
  headers: Record<string, string>,
  body: string | undefined,
  methodUpper: string
): Record<string, string> {
  const result = { ...headers };
  if (body && !["GET", "HEAD"].includes(methodUpper)) {
    const hasContentType = Object.keys(result).some(
      (key) => key.toLowerCase() === "content-type"
    );
    if (!hasContentType) {
      try {
        JSON.parse(body);
        result["Content-Type"] = "application/json";
      } catch {
        result["Content-Type"] = "text/plain";
      }
    }
  }
  return result;
}

function parseHttpBody(
  text: string
): { body: string; isJson: boolean; json?: any } {
  const body =
    text.length > 50_000
      ? text.slice(0, 50_000) + "\n...[truncated]"
      : text;

  try {
    return {
      body,
      isJson: true,
      json: JSON.parse(text),
    };
  } catch {
    return {
      body,
      isJson: false,
    };
  }
}

/**
 * Execute HTTP request to test APIs, microservices, and web endpoints.
 */
export async function executeHttpRequest(options: HttpRequestOptions): Promise<HttpRequestResult> {
  const { url, method = "GET", headers = {}, body, timeoutMs = 15000 } = options;
  const start = Date.now();
  const methodUpper = method.toUpperCase();
  const preparedHeaders = prepareRequestHeaders(headers, body, methodUpper);

  try {
    const policy = activeV2NetworkPolicy();

    if (policy.enabled) {
      const res = await safeHttpRequest({
        url,
        method: methodUpper,
        headers: preparedHeaders,
        body,
        timeoutMs,
        allowLoopback: policy.allowLoopback,
        effectivePort: policy.effectivePort,
      });
      const parsed = parseHttpBody(res.body);
      return {
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - start,
        headers: res.headers,
        body: parsed.body,
        isJson: parsed.isJson,
        json: parsed.json,
      };
    }

    const fetchOptions: RequestInit = {
      method: methodUpper,
      headers: preparedHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (body && !["GET", "HEAD"].includes(methodUpper)) {
      fetchOptions.body = body;
    }

    const res = await fetch(url, fetchOptions);
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    const text = await res.text();
    const parsed = parseHttpBody(text);

    return {
      status: res.status,
      statusText: res.statusText,
      durationMs: Date.now() - start,
      headers: resHeaders,
      body: parsed.body,
      isJson: parsed.isJson,
      json: parsed.json,
    };
  } catch (err: any) {
    return {
      status: 0,
      statusText: err?.code
        ? `${err.code}: ${err.message}`
        : err?.message || "HTTP request failed",
      durationMs: Date.now() - start,
      headers: {},
      body: "",
      isJson: false,
    };
  }
}
