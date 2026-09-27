/**
 * WinHelm - SSE Client Example
 * Demonstrates connecting to WinHelm via Server-Sent Events (/sse) endpoint
 */
async function main() {
  const PORT = process.env.PORT || 8788;
  const SSE_URL = `http://localhost:${PORT}/sse`;

  console.log(`Connecting to WinHelm SSE at ${SSE_URL}...`);

  const controller = new AbortController();
  const sseRes = await fetch(SSE_URL, {
    signal: controller.signal,
  });

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let messageEndpoint = "";

  // 1. Read initial endpoint event
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    console.log("SSE Event Received:\n", text);
    const match = text.match(/data: (\S+)/);
    if (match) {
      messageEndpoint = match[1];
      break;
    }
  }

  console.log("[OK] Message Endpoint:", messageEndpoint);

  // 2. Send initialize JSON-RPC request to message endpoint
  const postUrl = `http://localhost:${PORT}${messageEndpoint}`;
  console.log(`Sending initialize request to ${postUrl}...`);

  const postRes = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "winhelm-sse-client", version: "1.0.0" },
      },
    }),
  });

  console.log(`POST response status: ${postRes.status}`);

  // 3. Read response from SSE stream
  const { value } = await reader.read();
  console.log("SSE Response Payload:\n", decoder.decode(value));

  controller.abort();
  console.log("=== SSE Connection Test Successful ===");
}

main().catch(console.error);
