import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { ConfigManager } from "../config/config-manager.js";
import { markdownToHtml } from "../engine/pdf-generator.js";

/**
 * Generate standalone responsive Dark-Mode HTML preview page for any file
 */
export async function getFilePreviewHtml(filePath: string): Promise<string> {
  const configManager = ConfigManager.getInstance();
  const resolvedPath = path.resolve(filePath);

  const pathCheck = configManager.isPathAllowed(resolvedPath);
  if (!pathCheck.allowed) {
    return renderErrorPage(resolvedPath, pathCheck.reason || "Access to path is blocked by security policy.");
  }

  if (!existsSync(resolvedPath)) {
    return renderErrorPage(resolvedPath, "File does not exist.");
  }

  const stat = statSync(resolvedPath);
  if (stat.isDirectory()) {
    return renderErrorPage(resolvedPath, "Target is a directory, not a file.");
  }

  const fileName = path.basename(resolvedPath);
  const ext = path.extname(resolvedPath).toLowerCase();
  const fileSizeKb = (stat.size / 1024).toFixed(1);

  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"];
  const isImage = imageExts.includes(ext);
  const isPdf = ext === ".pdf";

  let bodyContent = "";
  let lineCount = 0;

  if (isImage) {
    const rawBuffer = await fs.readFile(resolvedPath);
    const mime = ext === ".svg" ? "image/svg+xml" : `image/${ext.replace(".", "")}`;
    const base64 = rawBuffer.toString("base64");
    bodyContent = `
      <div class="image-container">
        <img src="data:${mime};base64,${base64}" alt="${escapeHtml(fileName)}" />
      </div>
    `;
  } else if (isPdf) {
    const rawBuffer = await fs.readFile(resolvedPath);
    const base64 = rawBuffer.toString("base64");
    bodyContent = `
      <div class="pdf-container">
        <iframe src="data:application/pdf;base64,${base64}" width="100%" height="800px"></iframe>
      </div>
    `;
  } else {
    // Text / Code / Markdown
    try {
      const content = await fs.readFile(resolvedPath, "utf-8");
      const lines = content.split(/\r?\n/);
      lineCount = lines.length;

      if (ext === ".md" || ext === ".markdown") {
        const renderedMd = markdownToHtml(content, fileName);
        // Extract inner body from renderedMd
        const bodyMatch = renderedMd.match(/<body>([\s\S]*?)<\/body>/i);
        const mdHtml = bodyMatch ? bodyMatch[1] : renderedMd;

        bodyContent = `
          <div class="tabs">
            <button class="tab-btn active" onclick="switchTab('rendered')">Preview</button>
            <button class="tab-btn" onclick="switchTab('raw')">Raw Markdown</button>
          </div>
          <div id="tab-rendered" class="tab-content active markdown-body">
            ${mdHtml}
          </div>
          <div id="tab-raw" class="tab-content">
            <pre class="code-view"><code>${escapeHtml(content)}</code></pre>
          </div>
        `;
      } else {
        // Source Code or JSON with line numbers
        const numberedLines = lines
          .map(
            (line, idx) =>
              `<div class="code-line"><span class="line-num">${idx + 1}</span><span class="line-code">${escapeHtml(line)}</span></div>`
          )
          .join("");

        bodyContent = `
          <div class="code-container">
            ${numberedLines}
          </div>
        `;
      }
    } catch (err: any) {
      return renderErrorPage(resolvedPath, `Error reading file: ${err.message}`);
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)} - WinHelm Preview</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220%22><text y=%2226%22 font-size=%2226%22>⚡</text></svg>">
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --accent-hover: #1f6feb;
      --code-bg: #090d13;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .header {
      background-color: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .file-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .file-name {
      font-size: 16px;
      font-weight: 600;
      color: #f0f6fc;
    }
    .file-meta {
      font-size: 12px;
      color: var(--text-muted);
      background: #21262d;
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .btn {
      background: #21262d;
      color: var(--text);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      text-decoration: none;
      transition: background 0.2s;
    }
    .btn:hover {
      background: #30363d;
      color: #fff;
    }
    .btn-primary {
      background: #238636;
      border-color: #2ea043;
      color: #fff;
    }
    .btn-primary:hover {
      background: #2ea043;
    }
    .container {
      max-width: 1200px;
      margin: 24px auto;
      padding: 0 16px;
    }
    .preview-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      padding: 24px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .tab-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      padding: 6px 16px;
      cursor: pointer;
      font-weight: 500;
      font-size: 14px;
      border-radius: 6px;
    }
    .tab-btn.active {
      background: #21262d;
      color: var(--accent);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .code-container {
      background: var(--code-bg);
      border-radius: 6px;
      font-family: "Cascadia Code", Consolas, monospace;
      font-size: 13px;
      overflow-x: auto;
      padding: 12px 0;
    }
    .code-line {
      display: flex;
      line-height: 1.6;
    }
    .code-line:hover { background: #161b22; }
    .line-num {
      width: 50px;
      text-align: right;
      padding-right: 16px;
      color: #484f58;
      user-select: none;
    }
    .line-code {
      white-space: pre;
      color: #e6edf3;
      flex: 1;
      padding-right: 16px;
    }
    .image-container {
      text-align: center;
      padding: 30px;
    }
    .image-container img {
      max-width: 100%;
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    /* Markdown dark styles */
    .markdown-body {
      color: #e6edf3;
      line-height: 1.7;
    }
    .markdown-body h1, .markdown-body h2 {
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.3em;
    }
    .markdown-body table {
      border-collapse: collapse;
      width: 100%;
      margin: 16px 0;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--border);
      padding: 8px 12px;
    }
    .markdown-body th { background: #21262d; }
    .markdown-body pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      padding: 14px;
      border-radius: 6px;
      overflow-x: auto;
    }
    .markdown-body blockquote {
      border-left: 4px solid var(--accent);
      margin: 0;
      padding: 4px 16px;
      color: var(--text-muted);
      background: #161b22;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="file-info">
      <span style="font-size: 20px;">📄</span>
      <span class="file-name">${escapeHtml(fileName)}</span>
      <span class="file-meta">${fileSizeKb} KB</span>
      ${lineCount > 0 ? `<span class="file-meta">${lineCount} lines</span>` : ""}
      <span class="file-meta">${escapeHtml(ext.toUpperCase() || "FILE")}</span>
    </div>
    <div class="actions">
      <button class="btn" onclick="copyPath()">Copy Path</button>
      <a class="btn" href="/dashboard">Dashboard</a>
    </div>
  </div>

  <div class="container">
    <div class="preview-box">
      ${bodyContent}
    </div>
  </div>

  <script>
    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      if (tab === 'rendered') {
        document.querySelectorAll('.tab-btn')[0].classList.add('active');
        document.getElementById('tab-rendered').classList.add('active');
      } else {
        document.querySelectorAll('.tab-btn')[1].classList.add('active');
        document.getElementById('tab-raw').classList.add('active');
      }
    }
    function copyPath() {
      navigator.clipboard.writeText(${JSON.stringify(resolvedPath)}).then(() => {
        alert('Copied path to clipboard!');
      });
    }
  </script>
</body>
</html>`;
}

function renderErrorPage(targetPath: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Preview Error - WinHelm</title>
  <style>
    body { background: #0d1117; color: #f85149; font-family: sans-serif; padding: 40px; text-align: center; }
    .box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; max-width: 600px; margin: 0 auto; padding: 30px; }
    h2 { color: #f85149; }
    p { color: #8b949e; }
    a { color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Access Blocked or File Not Found</h2>
    <p>${escapeHtml(message)}</p>
    <p><code>${escapeHtml(targetPath)}</code></p>
    <a href="/dashboard">Return to Dashboard</a>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/['\u2018\u2019\u201A\u201B]/g, "&#039;");
}
