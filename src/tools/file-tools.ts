import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigManager } from "../config/config-manager.js";
import { PROFILES } from "../config/profiles.js";
import { searchCodebase } from "../engine/ripgrep.js";
import { generatePdf } from "../engine/pdf-generator.js";
import {
  copyFileOrDir,
  createZip,
  deleteFileToRecycleBin,
  editFileContent,
  extractZip,
  hashFile,
  listDirectory,
  moveFile,
  readFileContent,
  searchInFiles,
  tailFileContent,
  writeFileContent,
} from "../engine/filesystem.js";
import { registerTracedTool } from "./tool-wrapper.js";

export function registerFileTools(server: McpServer): void {
  // 1. File Read
  registerTracedTool(
    server,
    "file_read",
    {
      path: z.string().describe("Absolute or relative path to file"),
      start_line: z.number().optional().describe("Starting line number (1-based, inclusive)"),
      end_line: z.number().optional().describe("Ending line number (1-based, inclusive)"),
    },
    async ({ path: filePath, start_line, end_line }) => {
      try {
        const res = await readFileContent(filePath, start_line, end_line);
        return {
          content: [
            {
              type: "text",
              text: res.content,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error reading file: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 2. File Write
  registerTracedTool(
    server,
    "file_write",
    {
      path: z.string().describe("Target file path"),
      content: z.string().describe("Full content to write"),
    },
    async ({ path: filePath, content }) => {
      try {
        const res = await writeFileContent(filePath, content);
        return {
          content: [
            {
              type: "text",
              text: `Successfully wrote ${res.bytesWritten} bytes to ${res.filePath}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error writing file: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 3. File Edit (Surgical Edit)
  registerTracedTool(
    server,
    "file_edit",
    {
      path: z.string().describe("File to edit"),
      old_text: z.string().describe("Exact string to replace (must appear uniquely in the file)"),
      new_text: z.string().describe("Replacement string"),
    },
    async ({ path: filePath, old_text, new_text }) => {
      try {
        const res = await editFileContent(filePath, old_text, new_text);
        return {
          content: [{ type: "text", text: `Successfully updated ${res.filePath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Edit failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 4. File List
  registerTracedTool(
    server,
    "file_list",
    {
      path: z.string().optional().describe("Directory path (default: current directory)"),
      recursive: z.boolean().optional().describe("Whether to scan subdirectories (up to 3 levels)"),
    },
    async ({ path: dirPath = ".", recursive = false }) => {
      try {
        const list = await listDirectory(dirPath, recursive);
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to list directory: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 5. File Search
  registerTracedTool(
    server,
    "file_search",
    {
      query: z.string().describe("Search string to find within files"),
      path: z.string().optional().describe("Folder path to search in (default: current directory)"),
      file_pattern: z.string().optional().describe("File name filter (e.g. '.js', '.json')"),
    },
    async ({ query, path: searchPath = ".", file_pattern = "" }) => {
      try {
        const matches = await searchInFiles(query, searchPath, file_pattern);
        return {
          content: [
            {
              type: "text",
              text:
                matches.length > 0
                  ? JSON.stringify(matches, null, 2)
                  : `No matches found for "${query}"`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Search failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 6. Safe Delete (to Windows Recycle Bin)
  registerTracedTool(
    server,
    "file_delete_safe",
    {
      path: z.string().describe("Target file or directory path to send to Windows Recycle Bin"),
    },
    async ({ path: targetPath }) => {
      try {
        const res = await deleteFileToRecycleBin(targetPath);
        return {
          content: [
            {
              type: "text",
              text: `Successfully sent to Recycle Bin: ${res.path}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Safe delete failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 7. File Move / Rename
  registerTracedTool(
    server,
    "file_move",
    {
      source: z.string().describe("Source file or folder path"),
      destination: z.string().describe("Destination file or folder path"),
      overwrite: z.boolean().optional().describe("Whether to overwrite destination if it exists (default: false)"),
    },
    async ({ source, destination, overwrite }) => {
      try {
        const res = await moveFile(source, destination, overwrite);
        return {
          content: [
            {
              type: "text",
              text: `Successfully moved from ${res.from} to ${res.to}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `File move failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 8. File Copy
  registerTracedTool(
    server,
    "file_copy",
    {
      source: z.string().describe("Source file or folder path"),
      destination: z.string().describe("Destination file or folder path"),
      overwrite: z.boolean().optional().describe("Whether to overwrite destination if it exists (default: true)"),
    },
    async ({ source, destination, overwrite }) => {
      try {
        const res = await copyFileOrDir(source, destination, overwrite);
        return {
          content: [
            {
              type: "text",
              text: `Successfully copied from ${res.from} to ${res.to}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `File copy failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 9. Archive Zip (Create)
  registerTracedTool(
    server,
    "archive_zip",
    {
      source_dir: z.string().describe("Directory path to compress"),
      zip_path: z.string().describe("Destination .zip file path"),
    },
    async ({ source_dir, zip_path }) => {
      try {
        const res = await createZip(source_dir, zip_path);
        return {
          content: [
            {
              type: "text",
              text: `Successfully compressed ${res.targetPath} into ${res.zipPath}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Zip compression failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 10. Archive Unzip (Extract)
  registerTracedTool(
    server,
    "archive_unzip",
    {
      zip_path: z.string().describe("Path to .zip file to extract"),
      target_dir: z.string().describe("Destination directory path for extracted files"),
      overwrite: z.boolean().optional().describe("Whether to overwrite existing files (default: true)"),
    },
    async ({ zip_path, target_dir, overwrite }) => {
      try {
        const res = await extractZip(zip_path, target_dir, overwrite);
        return {
          content: [
            {
              type: "text",
              text: `Successfully extracted ${res.zipPath} to ${res.targetPath}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Zip extraction failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 11. Ripgrep High-Speed Paginated Search
  registerTracedTool(
    server,
    "file_search_ripgrep",
    {
      query: z.string().describe("Search string or regex pattern"),
      path: z.string().optional().describe("Directory path to search in (default: current workspace)"),
      file_pattern: z.string().optional().describe("Glob pattern filter (e.g. '*.ts', '*.py', 'src/**')"),
      case_sensitive: z.boolean().optional().describe("Enable case-sensitive matching (default: false)"),
      is_regex: z.boolean().optional().describe("Treat query as regular expression (default: false)"),
      page: z.number().optional().describe("Page number (1-based, default: 1)"),
      page_size: z.number().optional().describe("Results per page (default: 50, max: 200)"),
      context_lines: z.number().optional().describe("Lines of context around match (default: 0)"),
    },
    async ({
      query,
      path: searchPath,
      file_pattern,
      case_sensitive,
      is_regex,
      page,
      page_size,
      context_lines,
    }) => {
      try {
        const res = await searchCodebase({
          query,
          searchPath,
          filePattern: file_pattern,
          caseSensitive: case_sensitive,
          isRegex: is_regex,
          page,
          pageSize: page_size,
          contextLines: context_lines,
        });

        const summary = [
          `Engine: ${res.engine.toUpperCase()}`,
          `Query: "${res.query}"`,
          `Matches: ${res.totalMatches} total (Showing page ${res.page} with ${res.matches.length} matches, hasMore: ${res.hasMore})`,
          "",
          ...res.matches.map(
            (m) => `${m.file}:${m.line}:${m.column} -> ${m.text}`
          ),
        ].join("\n");

        return {
          content: [{ type: "text", text: summary }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Ripgrep search failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 12. Native Windows PDF Document Generator
  registerTracedTool(
    server,
    "pdf_generate",
    {
      source_path: z.string().describe("Path to input Markdown (.md), HTML (.html), or text file"),
      pdf_path: z.string().describe("Output destination .pdf file path"),
      landscape: z.boolean().optional().describe("Use landscape orientation instead of portrait (default: false)"),
      title: z.string().optional().describe("Document title for header"),
    },
    async ({ source_path, pdf_path, landscape, title }) => {
      try {
        const res = await generatePdf({
          sourcePath: source_path,
          pdfPath: pdf_path,
          landscape,
          title,
        });
        return {
          content: [
            {
              type: "text",
              text: `PDF generated successfully!\nPath: ${res.pdfPath}\nSource: ${res.sourcePath}\nSize: ${(res.sizeBytes / 1024).toFixed(1)} KB\nBrowser Engine: ${res.browserUsed}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `PDF generation failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 13. Interactive File & Markdown Previewer
  registerTracedTool(
    server,
    "file_preview",
    {
      path: z.string().describe("Absolute or relative path to file to preview"),
      max_lines: z.number().optional().describe("Maximum lines of text to return in preview snippet (default: 50)"),
    },
    async ({ path: targetPath, max_lines = 50 }) => {
      try {
        const configManager = ConfigManager.getInstance();
        const resolved = path.resolve(targetPath);
        const pathCheck = configManager.isPathAllowed(resolved);
        if (!pathCheck.allowed) {
          throw new Error(pathCheck.reason);
        }

        if (!existsSync(resolved)) {
          throw new Error(`File not found: ${targetPath}`);
        }

        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          throw new Error(`Path is a directory: ${targetPath}`);
        }

        const ext = path.extname(resolved).toLowerCase();
        const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"];
        const isImage = imageExts.includes(ext);
        const isPdf = ext === ".pdf";
        const isBinary = isImage || isPdf;

        let snippet = "";
        let lineCount = 0;

        if (!isBinary) {
          const content = await fs.readFile(resolved, "utf-8");
          const lines = content.split(/\r?\n/);
          lineCount = lines.length;
          snippet = lines.slice(0, max_lines).join("\n");
          if (lines.length > max_lines) {
            snippet += `\n... [${lines.length - max_lines} more lines truncated]`;
          }
        }

        const previewUrl = `http://localhost:8788/preview?path=${encodeURIComponent(resolved)}`;

        const result = {
          file: path.basename(resolved),
          path: resolved,
          extension: ext,
          sizeBytes: stat.size,
          sizeKb: (stat.size / 1024).toFixed(1),
          lineCount: isBinary ? undefined : lineCount,
          isBinary,
          previewUrl,
          snippet: isBinary ? `[Binary/Image file (${ext}) - view at ${previewUrl}]` : snippet,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `File preview failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 14. File Tail (Read last N lines)
  registerTracedTool(
    server,
    "file_tail",
    {
      path: z.string().describe("Target file path to tail"),
      lines: z.number().optional().describe("Number of lines from end of file to read (default: 50)"),
    },
    async ({ path: filePath, lines }) => {
      try {
        const res = await tailFileContent(filePath, lines);
        return {
          content: [
            {
              type: "text",
              text: res.content || `(File is empty: ${res.filePath})`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Tail failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 15. File Hash (SHA-256, MD5, SHA-1)
  registerTracedTool(
    server,
    "file_hash",
    {
      path: z.string().describe("Target file path to compute hash"),
      algorithm: z.enum(["sha256", "md5", "sha1"]).optional().describe("Hash algorithm to use (default: sha256)"),
    },
    async ({ path: filePath, algorithm }) => {
      try {
        const res = await hashFile(filePath, algorithm || "sha256");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Hash calculation failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // MCP UI / Preview Resource (registered if profile permits)
  const profile = ConfigManager.getInstance().getConfig().profile || "full";
  const profileDef = PROFILES[profile] || PROFILES.full;
  if (profileDef.includesResource) {
    server.registerResource(
      "file-preview",
      "preview://file",
      {
        mimeType: "text/html;profile=mcp-app",
        description: "Interactive HTML preview for files on Windows host",
      },
      async (uri) => {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/html;profile=mcp-app",
              text: "WinHelm Web Preview is active. View files in your browser at http://localhost:8788/preview?path=<filepath>",
            },
          ],
        };
      }
    );
  }
}
