import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { ConfigManager } from "../config/config-manager.js";
import type { PdfGenerateOptions, PdfGenerateResult } from "../types/index.js";

const execFileAsync = promisify(execFile);

/**
 * Locate system Chromium browser (Edge or Chrome)
 */
export function findChromiumPath(): string | null {
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(localAppData, "Microsoft\\Edge\\Application\\msedge.exe"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Lightweight, robust Markdown to HTML converter with print styling
 */
export function markdownToHtml(md: string, title = "Document"): string {
  // Convert Markdown blocks
  const lines = md.split(/\r?\n/);
  const htmlParts: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBuffer: string[] = [];
  let inList = false;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        const safeLang = escapeHtml(codeBlockLang.replace(/[^\w\-]/g, ""));
        htmlParts.push(
          `<pre class="code-block ${safeLang}"><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`
        );
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeBlockLang = line.trim().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Tables
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      if (!inTable) {
        inTable = true;
        htmlParts.push("<table>");
      }
      // Check if delimiter row
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) {
        continue;
      }
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      const isHeader = i > 0 && lines[i + 1] && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim());
      const tag = isHeader ? "th" : "td";
      htmlParts.push(`<tr>${cells.map((c) => `<${tag}>${formatInline(c)}</${tag}>`).join("")}</tr>`);
      continue;
    } else if (inTable) {
      inTable = false;
      htmlParts.push("</table>");
    }

    // Lists
    if (/^\s*[\*\-]\s+(.*)$/.test(line)) {
      if (!inList) {
        inList = true;
        htmlParts.push("<ul>");
      }
      const itemText = line.replace(/^\s*[\*\-]\s+/, "");
      htmlParts.push(`<li>${formatInline(itemText)}</li>`);
      continue;
    } else if (inList) {
      inList = false;
      htmlParts.push("</ul>");
    }

    // Headings
    if (/^######\s+(.*)$/.test(line)) {
      htmlParts.push(`<h6>${formatInline(line.replace(/^######\s+/, ""))}</h6>`);
    } else if (/^#####\s+(.*)$/.test(line)) {
      htmlParts.push(`<h5>${formatInline(line.replace(/^#####\s+/, ""))}</h5>`);
    } else if (/^####\s+(.*)$/.test(line)) {
      htmlParts.push(`<h4>${formatInline(line.replace(/^####\s+/, ""))}</h4>`);
    } else if (/^###\s+(.*)$/.test(line)) {
      htmlParts.push(`<h3>${formatInline(line.replace(/^###\s+/, ""))}</h3>`);
    } else if (/^##\s+(.*)$/.test(line)) {
      htmlParts.push(`<h2>${formatInline(line.replace(/^##\s+/, ""))}</h2>`);
    } else if (/^#\s+(.*)$/.test(line)) {
      htmlParts.push(`<h1>${formatInline(line.replace(/^#\s+/, ""))}</h1>`);
    } else if (/^>\s*(.*)$/.test(line)) {
      htmlParts.push(`<blockquote>${formatInline(line.replace(/^>\s*/, ""))}</blockquote>`);
    } else if (/^---|\*\*\*|___$/.test(line.trim())) {
      htmlParts.push("<hr />");
    } else if (line.trim().length > 0) {
      htmlParts.push(`<p>${formatInline(line)}</p>`);
    }
  }

  if (inList) htmlParts.push("</ul>");
  if (inTable) htmlParts.push("</table>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page {
      margin: 15mm 20mm;
      size: A4 portrait;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #24292f;
      background: #ffffff;
      padding: 0;
      margin: 0;
    }
    h1, h2, h3, h4, h5, h6 {
      color: #1f2328;
      margin-top: 1.4em;
      margin-bottom: 0.6em;
      font-weight: 600;
      page-break-after: avoid;
    }
    h1 { font-size: 20pt; border-bottom: 1.5px solid #d0d7de; padding-bottom: 0.3em; }
    h2 { font-size: 15pt; border-bottom: 1px solid #eaeef2; padding-bottom: 0.2em; }
    h3 { font-size: 13pt; }
    p, ul, ol { margin-top: 0; margin-bottom: 1em; }
    ul { padding-left: 2em; }
    li { margin-bottom: 0.25em; }
    code {
      font-family: "Cascadia Code", Consolas, "Courier New", monospace;
      font-size: 9.5pt;
      background-color: #f6f8fa;
      padding: 0.2em 0.4em;
      border-radius: 4px;
      border: 1px solid #e1e4e8;
    }
    pre.code-block {
      background-color: #f6f8fa;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      padding: 14px;
      overflow-x: auto;
      font-size: 9pt;
      line-height: 1.45;
      page-break-inside: avoid;
    }
    pre.code-block code {
      background: none;
      border: none;
      padding: 0;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
      font-size: 10pt;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #d0d7de;
      padding: 8px 12px;
      text-align: left;
    }
    th {
      background-color: #f6f8fa;
      font-weight: 600;
    }
    blockquote {
      border-left: 4px solid #0969da;
      margin: 1em 0;
      padding: 0.5em 1em;
      color: #57606a;
      background-color: #f6f8fa;
    }
    hr {
      border: 0;
      height: 1px;
      background: #d0d7de;
      margin: 1.5em 0;
    }
  </style>
</head>
<body>
  ${htmlParts.join("\n")}
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

export function sanitizeHref(url: string): string {
  const clean = url.trim().replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  const normalized = clean.replace(/&#x?[0-9a-f]+;?/gi, (match) => {
    try {
      if (match.startsWith("&#x") || match.startsWith("&#X")) {
        return String.fromCharCode(parseInt(match.slice(3), 16));
      } else if (match.startsWith("&#")) {
        return String.fromCharCode(parseInt(match.slice(2), 10));
      }
    } catch {}
    return match;
  });

  if (/^(?:javascript|vbscript|data)\s*:/i.test(normalized.trim())) {
    return "#";
  }
  return clean;
}

function formatInline(str: string): string {
  return escapeHtml(str)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/~~(.*?)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, href) => {
      return `<a href="${sanitizeHref(href)}">${text}</a>`;
    });
}

/**
 * Generate a PDF from a Markdown, HTML, or Text file using native Chromium headless
 */
export async function generatePdf(options: PdfGenerateOptions): Promise<PdfGenerateResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("Operation blocked: Server is running in read-only mode.");
  }

  const resolvedSource = path.resolve(options.sourcePath);
  const resolvedPdf = path.resolve(options.pdfPath);

  if (!existsSync(resolvedSource)) {
    throw new Error(`Source file not found: ${options.sourcePath}`);
  }

  const dstCheck = configManager.isPathAllowed(resolvedPdf);
  if (!dstCheck.allowed) {
    throw new Error(dstCheck.reason);
  }

  const browserPath = findChromiumPath();
  if (!browserPath) {
    throw new Error(
      "No Chromium-based browser (Microsoft Edge or Google Chrome) found on this Windows system."
    );
  }

  // Ensure output directory exists
  await fs.mkdir(path.dirname(resolvedPdf), { recursive: true });

  const ext = path.extname(resolvedSource).toLowerCase();
  let htmlPath = resolvedSource;
  let tempHtmlPath: string | null = null;

  if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
    const rawContent = await fs.readFile(resolvedSource, "utf-8");
    const docTitle = options.title || path.basename(resolvedSource, ext);
    const htmlContent = markdownToHtml(rawContent, docTitle);

    tempHtmlPath = path.join(
      os.tmpdir(),
      `wincommander_pdf_${Date.now()}_${Math.random().toString(36).slice(2)}.html`
    );
    await fs.writeFile(tempHtmlPath, htmlContent, "utf-8");
    htmlPath = tempHtmlPath;
  }

  const args: string[] = [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    `--print-to-pdf=${resolvedPdf}`,
    htmlPath,
  ];

  try {
    await execFileAsync(browserPath, args, {
      timeout: 30000,
      windowsHide: true,
    });

    if (!existsSync(resolvedPdf)) {
      throw new Error(`PDF generation completed but target file was not created at ${resolvedPdf}`);
    }

    const stat = statSync(resolvedPdf);
    return {
      success: true,
      pdfPath: resolvedPdf,
      sourcePath: resolvedSource,
      sizeBytes: stat.size,
      browserUsed: path.basename(browserPath),
    };
  } finally {
    if (tempHtmlPath && existsSync(tempHtmlPath)) {
      await fs.unlink(tempHtmlPath).catch(() => {});
    }
  }
}
