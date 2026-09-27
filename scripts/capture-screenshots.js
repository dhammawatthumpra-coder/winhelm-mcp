import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

async function run() {
  const PORT = 8792;
  console.log(`Starting WinHelm on port ${PORT}...`);

  const serverProc = spawn("node", ["dist/index.js", "--port", String(PORT)], {
    stdio: "inherit",
  });

  // Wait for server to come up
  await new Promise((r) => setTimeout(r, 2000));

  try {
    // 1. Initialize MCP session and generate some tool calls
    console.log("Generating sample activity...");
    const initRes = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo-client", version: "1.0" } },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id");

    // Call terminal_run
    await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "terminal_run", arguments: { command: "Get-Date; Write-Host 'WinHelm System Online' -ForegroundColor Cyan" } },
      }),
    });

    // Call system_info
    await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "system_info", arguments: {} },
      }),
    });

    // Wait a brief moment for dashboard to refresh stats
    await new Promise((r) => setTimeout(r, 1000));

    // 2. Locate Edge
    const edgePaths = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    const edge = edgePaths.find((p) => fs.existsSync(p));
    if (!edge) throw new Error("Microsoft Edge not found");

    console.log("Capturing Dashboard screenshot...");
    const dashOutput = path.resolve("assets/dashboard.png");
    execSync(
      `"${edge}" --headless --disable-gpu --window-size=1400,920 --screenshot="${dashOutput}" "http://127.0.0.1:${PORT}/dashboard"`,
      { stdio: "ignore" }
    );
    console.log("Dashboard screenshot saved to:", dashOutput);

    console.log("Capturing File Preview screenshot...");
    const previewOutput = path.resolve("assets/preview.png");
    execSync(
      `"${edge}" --headless --disable-gpu --window-size=1400,920 --screenshot="${previewOutput}" "http://127.0.0.1:${PORT}/preview?path=package.json"`,
      { stdio: "ignore" }
    );
    console.log("Preview screenshot saved to:", previewOutput);
  } finally {
    console.log("Stopping server...");
    serverProc.kill("SIGKILL");
    if (serverProc.pid && process.platform === "win32") {
      try { execSync(`taskkill /pid ${serverProc.pid} /T /F`, { stdio: "ignore" }); } catch {}
    }
  }
}

run().catch((err) => {
  console.error("Error capturing screenshots:", err);
  process.exit(1);
});
