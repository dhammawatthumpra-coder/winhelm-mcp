import type { HttpPingResult, HttpRequestOptions, HttpRequestResult } from "../types/index.js";

/**
 * Fast HTTP health check ping for local/remote servers
 */
export async function pingEndpoint(
  url: string,
  timeoutMs = 5000,
  expectedStatus?: number
): Promise<HttpPingResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - start;
    const isExpected = expectedStatus ? res.status === expectedStatus : res.ok;

    return {
      ok: isExpected,
      status: res.status,
      statusText: res.statusText,
      latencyMs,
      url,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      statusText: err?.message || "Connection failed or timed out",
      latencyMs: Date.now() - start,
      url,
    };
  }
}

/**
 * Execute HTTP request to test APIs, microservices, and web endpoints
 */
export async function executeHttpRequest(options: HttpRequestOptions): Promise<HttpRequestResult> {
  const { url, method = "GET", headers = {}, body, timeoutMs = 15000 } = options;
  const start = Date.now();

  const fetchOptions: RequestInit = {
    method: method.toUpperCase(),
    headers: { ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (body && !["GET", "HEAD"].includes(method.toUpperCase())) {
    fetchOptions.body = body;
    if (!fetchOptions.headers || !(fetchOptions.headers as any)["Content-Type"]) {
      // Auto-detect JSON
      try {
        JSON.parse(body);
        (fetchOptions.headers as any)["Content-Type"] = "application/json";
      } catch {
        (fetchOptions.headers as any)["Content-Type"] = "text/plain";
      }
    }
  }

  try {
    const res = await fetch(url, fetchOptions);
    const durationMs = Date.now() - start;

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    const text = await res.text();
    let isJson = false;
    let json: any = undefined;

    try {
      json = JSON.parse(text);
      isJson = true;
    } catch {
      // plain text
    }

    return {
      status: res.status,
      statusText: res.statusText,
      durationMs,
      headers: resHeaders,
      body: text.length > 50000 ? text.slice(0, 50000) + "\n...[truncated]" : text,
      isJson,
      json,
    };
  } catch (err: any) {
    return {
      status: 0,
      statusText: err?.message || "HTTP request failed",
      durationMs: Date.now() - start,
      headers: {},
      body: "",
      isJson: false,
    };
  }
}
