/**
 * WinHelm - Streamable HTTP Client Example
 * Demonstrates connecting to WinHelm via Streamable HTTP (/mcp) endpoint
 */
async function main() {
  const PORT = process.env.PORT || 8788;
  const BASE_URL = `http://localhost:${PORT}/mcp`;

  console.log(`Connecting to WinHelm at ${BASE_URL}...`);

  // 1. Initialize session
  const initRes = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "winhelm-example-client", version: "1.0.0" },
      },
    }),
  });

  const sessionId = initRes.headers.get("mcp-session-id");
  console.log(`[OK] Initialized. Status: ${initRes.status} | Session ID: ${sessionId}`);

  // Send notifications/initialized
  await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId || "",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  // 2. Call system_info tool
  console.log("\nCalling 'system_info' tool...");
  const callRes = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId || "",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "system_info",
        arguments: {},
      },
    }),
  });

  const result = await callRes.json();
  console.log("Result:\n", JSON.stringify(result, null, 2));
}

main().catch(console.error);
