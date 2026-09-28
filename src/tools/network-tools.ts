import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeHttpRequest, pingEndpoint } from "../engine/http-client.js";
import { getNetworkInfo } from "../engine/system.js";
import { ConfigManager } from "../config/config-manager.js";
import { registerTracedTool } from "./tool-wrapper.js";

export function registerNetworkTools(server: McpServer): void {
  // 1. HTTP Ping / Health Check
  registerTracedTool(
    server,
    "http_ping",
    {
      url: z.string().url().describe("HTTP or HTTPS URL to ping (e.g. 'http://localhost:3000', 'http://127.0.0.1:8788/health')"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 5000)"),
      expected_status: z.number().optional().describe("Expected HTTP status code (default: any 2xx status)"),
    },
    async ({ url, timeout_ms, expected_status }) => {
      try {
        const res = await pingEndpoint(url, timeout_ms, expected_status);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `HTTP ping failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 2. Full HTTP Request Client
  registerTracedTool(
    server,
    "http_request",
    {
      url: z.string().url().describe("Target HTTP/HTTPS URL"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"])
        .optional()
        .describe("HTTP method (default: GET)"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Optional key-value HTTP headers"),
      body: z
        .string()
        .optional()
        .describe("Optional request payload (string or JSON string)"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 15000)"),
    },
    async ({ url, method, headers, body, timeout_ms }) => {
      const methodUpper = (method || "GET").toUpperCase();
      if (ConfigManager.getInstance().isReadOnly() && !["GET", "HEAD"].includes(methodUpper)) {
        return {
          content: [
            {
              type: "text",
              text: `HTTP mutation blocked: ${methodUpper} requests are not permitted in read-only mode.`,
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await executeHttpRequest({
          url,
          method,
          headers,
          body,
          timeoutMs: timeout_ms,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: res.status,
                  statusText: res.statusText,
                  durationMs: res.durationMs,
                  headers: res.headers,
                  body: res.isJson ? res.json : res.body,
                },
                null,
                2
              ),
            },
          ],
          isError: res.status === 0 || res.status >= 400,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `HTTP request failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 3. Network & Adapters Inspector
  registerTracedTool(
    server,
    "network_info",
    {
      include_listening_ports: z
        .boolean()
        .optional()
        .describe("Include list of active listening TCP ports and owning processes (default: false)"),
    },
    async ({ include_listening_ports }) => {
      try {
        const res = await getNetworkInfo(include_listening_ports === true);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Network inspection failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}

