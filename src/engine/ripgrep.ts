import { execFile, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { ConfigManager } from "../config/config-manager.js";
import { searchInFiles } from "./filesystem.js";
import type { RipgrepMatch, RipgrepSearchResult } from "../types/index.js";

const execFileAsync = promisify(execFile);

let cachedRgPath: string | null = null;

/**
 * Locate ripgrep executable (rg.exe) with multi-path resolution
 */
export function findRipgrepPath(): string | null {
  if (cachedRgPath && existsSync(cachedRgPath)) {
    return cachedRgPath;
  }

  // Strategy 1: System PATH via where.exe
  try {
    const whereOut = execSync("where.exe rg.exe", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0];
    if (whereOut && existsSync(whereOut)) {
      cachedRgPath = whereOut;
      return whereOut;
    }
  } catch {
    // Not found in PATH
  }

  // Strategy 2: Common Windows installation paths (WinGet, Scoop, Cargo, Program Files)
  const home = os.homedir();
  const commonPaths = [
    path.join(home, "scoop", "apps", "ripgrep", "current", "rg.exe"),
    path.join(home, ".cargo", "bin", "rg.exe"),
    "C:\\Program Files\\Ripgrep\\rg.exe",
    "C:\\Program Files (x86)\\Ripgrep\\rg.exe",
  ];

  for (const candidate of commonPaths) {
    if (existsSync(candidate)) {
      cachedRgPath = candidate;
      return candidate;
    }
  }

  return null;
}

export interface RipgrepOptions {
  query: string;
  searchPath?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  isRegex?: boolean;
  page?: number;
  pageSize?: number;
  contextLines?: number;
}

/**
 * Execute paginated high-speed codebase search using ripgrep with fallback
 */
export async function searchCodebase(
  options: RipgrepOptions
): Promise<RipgrepSearchResult> {
  const configManager = ConfigManager.getInstance();
  const targetPath = options.searchPath ? path.resolve(options.searchPath) : process.cwd();

  const pathCheck = configManager.isPathAllowed(targetPath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const page = Math.max(1, options.page || 1);
  const pageSize = Math.max(1, Math.min(200, options.pageSize || 50));
  const rgPath = findRipgrepPath();

  if (!rgPath) {
    // Fallback to internal Node.js filesystem search
    const fallbackResults = await searchInFiles(
      options.query,
      targetPath,
      options.filePattern
    );

    const matches: RipgrepMatch[] = fallbackResults.map((m) => ({
      file: m.file,
      line: m.line,
      column: 1,
      text: m.text,
    }));

    const startIndex = (page - 1) * pageSize;
    const paginatedMatches = matches.slice(startIndex, startIndex + pageSize);

    return {
      query: options.query,
      engine: "fallback",
      totalMatches: matches.length,
      page,
      pageSize,
      hasMore: startIndex + pageSize < matches.length,
      matches: paginatedMatches,
    };
  }

  // Build ripgrep arguments
  const args: string[] = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color=never",
    "--max-columns=300",
  ];

  if (options.caseSensitive) {
    args.push("-s");
  } else {
    args.push("-i");
  }

  if (!options.isRegex) {
    args.push("-F"); // Fixed string literal mode
  }

  if (options.filePattern) {
    args.push("-g", options.filePattern);
  }

  if (options.contextLines && options.contextLines > 0) {
    args.push("-C", String(options.contextLines));
  }

  args.push("--", options.query, targetPath);

  try {
    const { stdout } = await execFileAsync(rgPath, args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB
      encoding: "utf-8",
      windowsHide: true,
    });

    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const allMatches: RipgrepMatch[] = [];

    for (const line of lines) {
      // Format: <filepath>:<line>:<column>:<text>
      // Note: Windows file paths begin with drive letter like D:\path\...
      // Regex matches: Drive:\... or relative path, followed by :line:column:
      const match = line.match(/^([a-zA-Z]:[^\:]+|\.?[^:]+):(\d+):(\d+):(.*)$/);
      if (match) {
        allMatches.push({
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          text: match[4].trim(),
        });
      } else {
        // Fallback split for unconventional paths
        const parts = line.split(":");
        if (parts.length >= 4) {
          const filePart = parts.slice(0, parts.length - 3).join(":");
          const lineNum = parseInt(parts[parts.length - 3], 10);
          const colNum = parseInt(parts[parts.length - 2], 10);
          const textPart = parts[parts.length - 1];
          if (!isNaN(lineNum) && !isNaN(colNum)) {
            allMatches.push({
              file: filePart,
              line: lineNum,
              column: colNum,
              text: textPart.trim(),
            });
          }
        }
      }
    }

    const startIndex = (page - 1) * pageSize;
    const paginatedMatches = allMatches.slice(startIndex, startIndex + pageSize);

    return {
      query: options.query,
      engine: "ripgrep",
      totalMatches: allMatches.length,
      page,
      pageSize,
      hasMore: startIndex + pageSize < allMatches.length,
      matches: paginatedMatches,
    };
  } catch (err: any) {
    // ripgrep exits with code 1 when no matches are found
    if (err.code === 1) {
      return {
        query: options.query,
        engine: "ripgrep",
        totalMatches: 0,
        page,
        pageSize,
        hasMore: false,
        matches: [],
      };
    }
    throw new Error(`Ripgrep search failed: ${err.message || err}`);
  }
}
