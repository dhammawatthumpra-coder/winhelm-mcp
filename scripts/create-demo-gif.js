import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

async function makeDemoGif() {
  const PORT = 8793;
  const tempDir = path.resolve("temp/gif_frames");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  console.log(`Starting WinHelm on port ${PORT}...`);
  const serverProc = spawn("node", ["dist/index.js", "--port", String(PORT)], { stdio: "ignore" });

  await new Promise((r) => setTimeout(r, 2000));

  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const ffmpeg = "D:\\ffmpeg\\bin\\ffmpeg.exe";

  const captureFrame = (frameNum) => {
    const framePath = path.join(tempDir, `frame_${frameNum}.png`);
    execSync(
      `"${edge}" --headless --disable-gpu --window-size=1280,800 --screenshot="${framePath}" "http://127.0.0.1:${PORT}/dashboard"`,
      { stdio: "ignore" }
    );
  };

  try {
    // Frame 1: Fresh Dashboard
    captureFrame(1);

    // Init MCP
    const initRes = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo", version: "1.0" } },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id");

    // Frame 2: Start background task
    await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "terminal_task_start",
          arguments: { command: "for ($i=1; $i -le 3; $i++) { Write-Host \"Building module $i of 3...\"; Start-Sleep -Seconds 1 }; Write-Host \"Build successful!\" -ForegroundColor Green" },
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 800));
    captureFrame(2);

    // Frame 3: Call system info
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
    await new Promise((r) => setTimeout(r, 1200));
    captureFrame(3);

    // Frame 4: Run process top
    await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "process_list", arguments: { sortBy: "memory", limit: 5 } },
      }),
    });
    await new Promise((r) => setTimeout(r, 1500));
    captureFrame(4);

    // Frame 5: Finished and logged
    await new Promise((r) => setTimeout(r, 1500));
    captureFrame(5);

    console.log("Generating animated GIF with ffmpeg...");
    const gifOutput = path.resolve("assets/demo.gif");
    const inputPattern = path.join(tempDir, "frame_%d.png").replace(/\\/g, "/");
    execSync(
      `"${ffmpeg}" -y -framerate 1.2 -i "${inputPattern}" -vf "scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "${gifOutput}"`,
      { stdio: "ignore" }
    );
    console.log("Demo GIF saved to:", gifOutput);
  } finally {
    serverProc.kill("SIGKILL");
    if (serverProc.pid && process.platform === "win32") {
      try { execSync(`taskkill /pid ${serverProc.pid} /T /F`, { stdio: "ignore" }); } catch {}
    }
    // Clean temp frames
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

makeDemoGif().catch(console.error);
