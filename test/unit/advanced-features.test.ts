import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { searchCodebase } from "../../src/engine/ripgrep.js";
import { generatePdf, findChromiumPath, markdownToHtml } from "../../src/engine/pdf-generator.js";
import { getFilePreviewHtml } from "../../src/gateway/preview-html.js";
import { ConfigManager } from "../../src/config/config-manager.js";

describe("Advanced Features: Ripgrep, PDF & Interactive Preview", () => {
  const testDir = path.join(process.cwd(), "test", "unit", "tmp-advanced");

  before(async () => {
    await fs.mkdir(testDir, { recursive: true });
    const configManager = ConfigManager.getInstance();
    configManager.init({
      allowedDirectories: [process.cwd(), "D:\\"],
      blockedCommands: [],
      fileReadLineLimit: 2000,
      defaultTimeoutMs: 15000,
      telemetryEnabled: false,
    });
  });

  after(async () => {
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("Feature 1: Ripgrep Streaming & Paginated Search", () => {
    it("should search codebase using ripgrep with pagination", async () => {
      const dummyFile = path.join(testDir, "search-sample.ts");
      await fs.writeFile(
        dummyFile,
        "export const WIN_COMMANDER_FLAG_1 = 'Alpha';\nexport const WIN_COMMANDER_FLAG_2 = 'Beta';\n"
      );

      const res = await searchCodebase({
        query: "WIN_COMMANDER_FLAG",
        searchPath: testDir,
        pageSize: 1,
        page: 1,
      });

      assert.strictEqual(res.query, "WIN_COMMANDER_FLAG");
      assert.strictEqual(res.totalMatches >= 2, true);
      assert.strictEqual(res.matches.length, 1);
      assert.strictEqual(res.page, 1);
      assert.strictEqual(res.hasMore, true);
      assert.ok(res.matches[0].text.includes("WIN_COMMANDER_FLAG"));
    });

    it("should fetch page 2 correctly", async () => {
      const res = await searchCodebase({
        query: "WIN_COMMANDER_FLAG",
        searchPath: testDir,
        pageSize: 1,
        page: 2,
      });

      assert.strictEqual(res.matches.length, 1);
      assert.strictEqual(res.page, 2);
    });
  });

  describe("Feature 2: Native Windows PDF Generation", () => {
    it("should convert markdown to clean HTML template", () => {
      const md = "# Test Title\n\nParagraph text with **bold**.\n\n```ts\nconsole.log(1);\n```";
      const html = markdownToHtml(md, "Test Title");
      assert.ok(html.includes("<h1>Test Title</h1>"));
      assert.ok(html.includes("<strong>bold</strong>"));
      assert.ok(html.includes("<pre class=\"code-block ts\">"));
    });

    it("should sanitize dangerous javascript: and vbscript: links in markdownToHtml", () => {
      const md = "[Malicious Link](javascript:alert(1)) and [Safe Link](https://example.com) and [VBScript](vbscript:msgbox)";
      const html = markdownToHtml(md, "XSS Test");
      assert.ok(html.includes('<a href="#">Malicious Link</a>'));
      assert.ok(html.includes('<a href="#">VBScript</a>'));
      assert.ok(html.includes('<a href="https://example.com">Safe Link</a>'));
      assert.strictEqual(html.includes("javascript:"), false);
      assert.strictEqual(html.includes("vbscript:"), false);
    });

    it("should locate Chromium browser (Edge or Chrome)", () => {
      const browser = findChromiumPath();
      assert.ok(browser !== null, "At least Edge or Chrome must be installed on Windows");
      assert.strictEqual(existsSync(browser!), true);
    });

    it("should generate PDF from Markdown file using native Chromium headless", async () => {
      const mdFile = path.join(testDir, "sample-doc.md");
      const pdfFile = path.join(testDir, "sample-doc.pdf");

      await fs.writeFile(
        mdFile,
        "# WinHelm Architecture Report\n\nGenerated automatically via **Native Chromium Headless** on Windows.\n\n- Feature 1: Ripgrep\n- Feature 2: PDF\n- Feature 3: Web Preview\n"
      );

      const res = await generatePdf({
        sourcePath: mdFile,
        pdfPath: pdfFile,
        title: "Architecture Report",
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(existsSync(pdfFile), true);
      assert.ok(res.sizeBytes > 1000, "PDF size must be greater than 1KB");
    });
  });

  describe("Feature 3: Interactive File & Markdown Preview", () => {
    it("should generate rich preview HTML for Markdown", async () => {
      const mdFile = path.join(testDir, "preview-sample.md");
      await fs.writeFile(mdFile, "# Preview Title\n\nSample content for preview.");

      const html = await getFilePreviewHtml(mdFile);
      assert.ok(html.includes("preview-sample.md"));
      assert.ok(html.includes("Preview Title"));
      assert.ok(html.includes("Raw Markdown"));
    });

    it("should generate code preview HTML with line numbers for source code", async () => {
      const codeFile = path.join(testDir, "code-sample.ts");
      await fs.writeFile(codeFile, "function test() {\n  return 42;\n}");

      const html = await getFilePreviewHtml(codeFile);
      assert.ok(html.includes("code-line"));
      assert.ok(html.includes("line-num"));
      assert.ok(html.includes("return 42;"));
    });
  });
});
