import fs from "node:fs/promises";
import { existsSync, createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ArchiveResult,
  DirectoryEntry,
  FileCopyResult,
  FileDeleteResult,
  FileEditResult,
  FileHashResult,
  FileMoveResult,
  FileReadResult,
  FileTailResult,
  FileWriteResult,
  SearchMatch,
} from "../types/index.js";
import { ConfigManager } from "../config/config-manager.js";
import { runPowerShell } from "./powershell-runner.js";

/**
 * Read file with optional line range and line limit safeguard
 */
export async function readFileContent(
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<FileReadResult> {
  const configManager = ConfigManager.getInstance();
  const pathCheck = configManager.isPathAllowed(filePath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const resolved = path.resolve(filePath);
  const data = await fs.readFile(resolved, "utf-8");
  const lines = data.split(/\r?\n/);
  const total = lines.length;

  const config = configManager.getConfig();
  const maxLimit = config.fileReadLineLimit || 2000;

  if (startLine !== undefined || endLine !== undefined) {
    const s = Math.max(1, startLine || 1);
    const e = Math.min(total, endLine || total);
    const count = e - s + 1;

    if (count > maxLimit) {
      throw new Error(
        `Requested line count (${count}) exceeds fileReadLineLimit (${maxLimit}). Please specify a smaller range.`
      );
    }

    const sliced = lines.slice(s - 1, e);
    const numbered = sliced.map((line, idx) => `${s + idx}: ${line}`).join("\n");
    return {
      content: numbered,
      totalLines: total,
      startLine: s,
      endLine: e,
      filePath: resolved,
    };
  }

  if (total > maxLimit) {
    // If the file is very large and no range specified, truncate to maxLimit with notice
    const sliced = lines.slice(0, maxLimit);
    const numbered = sliced.map((line, idx) => `${idx + 1}: ${line}`).join("\n");
    return {
      content: `${numbered}\n\n[Note: Output truncated at line ${maxLimit} of ${total}. Use start_line and end_line to inspect further lines.]`,
      totalLines: total,
      startLine: 1,
      endLine: maxLimit,
      filePath: resolved,
    };
  }

  return {
    content: data,
    totalLines: total,
    startLine: 1,
    endLine: total,
    filePath: resolved,
  };
}

/**
 * Write file, creating parent directories if needed
 */
export async function writeFileContent(
  filePath: string,
  content: string
): Promise<FileWriteResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("File write operation is blocked: Server is operating in read-only mode.");
  }

  const pathCheck = configManager.isPathAllowed(filePath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf-8");
  return {
    success: true,
    filePath: resolved,
    bytesWritten: Buffer.byteLength(content, "utf-8"),
  };
}

/**
 * Surgical file edit - replace unique occurrence of oldText with newText
 */
export async function editFileContent(
  filePath: string,
  oldText: string,
  newText: string
): Promise<FileEditResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("File edit operation is blocked: Server is operating in read-only mode.");
  }

  const pathCheck = configManager.isPathAllowed(filePath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const resolved = path.resolve(filePath);
  const content = await fs.readFile(resolved, "utf-8");

  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error(`old_text not found in file: ${resolved}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `old_text found ${occurrences} times. Please provide more surrounding lines/context to make it unique.`
    );
  }

  const updated = content.replace(oldText, newText);
  await fs.writeFile(resolved, updated, "utf-8");
  return { success: true, filePath: resolved };
}

/**
 * List files and directories
 */
export async function listDirectory(
  dirPath = ".",
  recursive = false
): Promise<DirectoryEntry[]> {
  const configManager = ConfigManager.getInstance();
  const pathCheck = configManager.isPathAllowed(dirPath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const resolved = path.resolve(dirPath);

  async function scan(currentDir: string, depth = 0): Promise<DirectoryEntry[]> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const results: DirectoryEntry[] = [];

    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      const isDir = entry.isDirectory();
      let size: number | null = null;
      let mtime: Date | null = null;

      try {
        const stat = await fs.stat(full);
        size = stat.size;
        mtime = stat.mtime;
      } catch {
        // ignore inaccessible files
      }

      results.push({
        name: entry.name,
        path: full,
        type: isDir ? "directory" : "file",
        sizeBytes: isDir ? null : size,
        modifiedAt: mtime ? mtime.toISOString() : null,
      });

      if (
        recursive &&
        isDir &&
        depth < 3 &&
        entry.name !== "node_modules" &&
        entry.name !== ".git"
      ) {
        const sub = await scan(full, depth + 1);
        results.push(...sub);
      }
    }
    return results;
  }

  return await scan(resolved);
}

/**
 * Search text inside files (simple & fast recursive search)
 */
export async function searchInFiles(
  query: string,
  targetPath = ".",
  filePattern = ""
): Promise<SearchMatch[]> {
  const configManager = ConfigManager.getInstance();
  const pathCheck = configManager.isPathAllowed(targetPath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const resolved = path.resolve(targetPath);
  const matches: SearchMatch[] = [];

  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        if (filePattern && !entry.name.includes(filePattern.replace("*", ""))) {
          continue;
        }
        try {
          const content = await fs.readFile(full, "utf-8");
          const lines = content.split(/\r?\n/);
          lines.forEach((line, idx) => {
            if (line.toLowerCase().includes(query.toLowerCase())) {
              matches.push({
                file: full,
                line: idx + 1,
                text: line.trim(),
              });
            }
          });
        } catch {
          // ignore binary / unreadable files
        }
      }
    }
  }

  await walk(resolved);
  return matches.slice(0, 100); // cap to 100 matches
}

/**
 * Safely delete a file or directory by sending it to the Windows Recycle Bin
 */
export async function deleteFileToRecycleBin(targetPath: string): Promise<FileDeleteResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("Operation blocked: Server is running in read-only mode.");
  }

  const pathCheck = configManager.isPathAllowed(targetPath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const resolved = path.resolve(targetPath);
  if (!existsSync(resolved)) {
    throw new Error(`Path not found: ${targetPath}`);
  }

  const stat = await fs.stat(resolved);
  const isDir = stat.isDirectory();
  const safePath = resolved.replace(/'/g, "''");

  const psCmd = isDir
    ? `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${safePath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
    : `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${safePath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;

  await runPowerShell(psCmd, { timeoutMs: 15000 });
  return {
    success: true,
    path: resolved,
    movedToRecycleBin: true,
  };
}

/**
 * Move or rename a file or directory
 */
export async function moveFile(
  sourcePath: string,
  destPath: string,
  overwrite = false
): Promise<FileMoveResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("Operation blocked: Server is running in read-only mode.");
  }

  const srcCheck = configManager.isPathAllowed(sourcePath);
  if (!srcCheck.allowed) {
    throw new Error(srcCheck.reason);
  }

  const dstCheck = configManager.isPathAllowed(destPath);
  if (!dstCheck.allowed) {
    throw new Error(dstCheck.reason);
  }

  const resolvedSource = path.resolve(sourcePath);
  const resolvedDest = path.resolve(destPath);

  if (!existsSync(resolvedSource)) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }
  if (existsSync(resolvedDest) && !overwrite) {
    throw new Error(`Destination already exists: ${destPath}`);
  }

  await fs.mkdir(path.dirname(resolvedDest), { recursive: true });

  try {
    await fs.rename(resolvedSource, resolvedDest);
  } catch (err: any) {
    // Cross-partition fallback (EXDEV)
    if (err?.code === "EXDEV") {
      await fs.cp(resolvedSource, resolvedDest, { recursive: true, force: overwrite });
      await fs.rm(resolvedSource, { recursive: true, force: true });
    } else {
      throw err;
    }
  }

  return {
    success: true,
    from: resolvedSource,
    to: resolvedDest,
  };
}

/**
 * Copy a file or directory recursively
 */
export async function copyFileOrDir(
  sourcePath: string,
  destPath: string,
  overwrite = true
): Promise<FileCopyResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("Operation blocked: Server is running in read-only mode.");
  }

  const srcCheck = configManager.isPathAllowed(sourcePath);
  if (!srcCheck.allowed) {
    throw new Error(srcCheck.reason);
  }

  const dstCheck = configManager.isPathAllowed(destPath);
  if (!dstCheck.allowed) {
    throw new Error(dstCheck.reason);
  }

  const resolvedSource = path.resolve(sourcePath);
  const resolvedDest = path.resolve(destPath);

  if (!existsSync(resolvedSource)) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }

  await fs.mkdir(path.dirname(resolvedDest), { recursive: true });
  await fs.cp(resolvedSource, resolvedDest, { recursive: true, force: overwrite });

  return {
    success: true,
    from: resolvedSource,
    to: resolvedDest,
  };
}

/**
 * Compress a directory into a .zip file using native .NET
 */
export async function createZip(sourceDir: string, zipPath: string): Promise<ArchiveResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("Operation blocked: Server is running in read-only mode.");
  }

  const srcCheck = configManager.isPathAllowed(sourceDir);
  if (!srcCheck.allowed) {
    throw new Error(srcCheck.reason);
  }

  const dstCheck = configManager.isPathAllowed(zipPath);
  if (!dstCheck.allowed) {
    throw new Error(dstCheck.reason);
  }

  const resolvedSource = path.resolve(sourceDir);
  const resolvedZip = path.resolve(zipPath);

  if (!existsSync(resolvedSource)) {
    throw new Error(`Source path not found: ${sourceDir}`);
  }

  await fs.mkdir(path.dirname(resolvedZip), { recursive: true });
  if (existsSync(resolvedZip)) {
    await fs.unlink(resolvedZip);
  }

  const safeSource = resolvedSource.replace(/'/g, "''");
  const safeZip = resolvedZip.replace(/'/g, "''");
  const psCmd = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${safeSource}', '${safeZip}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`;

  const res = await runPowerShell(psCmd, { timeoutMs: 30000 });
  if (res.exitCode !== 0 && res.stderr) {
    throw new Error(`Failed to create zip archive: ${res.stderr}`);
  }

  return {
    success: true,
    zipPath: resolvedZip,
    targetPath: resolvedSource,
    action: "create",
  };
}

/**
 * Extract a .zip archive to a target directory using native PowerShell Expand-Archive
 */
export async function extractZip(
  zipPath: string,
  targetDir: string,
  overwrite = true
): Promise<ArchiveResult> {
  const configManager = ConfigManager.getInstance();
  if (configManager.isReadOnly()) {
    throw new Error("Operation blocked: Server is running in read-only mode.");
  }

  const zipCheck = configManager.isPathAllowed(zipPath);
  if (!zipCheck.allowed) {
    throw new Error(zipCheck.reason);
  }

  const dstCheck = configManager.isPathAllowed(targetDir);
  if (!dstCheck.allowed) {
    throw new Error(dstCheck.reason);
  }

  const resolvedZip = path.resolve(zipPath);
  const resolvedTarget = path.resolve(targetDir);

  if (!existsSync(resolvedZip)) {
    throw new Error(`Zip archive not found: ${zipPath}`);
  }

  await fs.mkdir(resolvedTarget, { recursive: true });

  const safeZip = resolvedZip.replace(/'/g, "''");
  const safeTarget = resolvedTarget.replace(/'/g, "''");
  const psCmd = `Expand-Archive -LiteralPath '${safeZip}' -DestinationPath '${safeTarget}' ${overwrite ? "-Force" : ""}`;

  const res = await runPowerShell(psCmd, { timeoutMs: 30000 });
  if (res.exitCode !== 0 && res.stderr) {
    throw new Error(`Failed to extract zip archive: ${res.stderr}`);
  }

  return {
    success: true,
    zipPath: resolvedZip,
    targetPath: resolvedTarget,
    action: "extract",
  };
}

/**
 * Read the last N lines of a file with line numbers
 */
export async function tailFileContent(
  filePath: string,
  linesCount = 50
): Promise<FileTailResult> {
  const configManager = ConfigManager.getInstance();
  const pathCheck = configManager.isPathAllowed(filePath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = statSync(resolved);
  if (stats.isDirectory()) {
    throw new Error(`Target path is a directory, not a file: ${filePath}`);
  }

  const config = configManager.getConfig();
  const maxLimit = config.fileReadLineLimit || 2000;
  const count = Math.min(Math.max(1, linesCount), maxLimit);

  // For very large files (> 512KB), read only the tail chunk
  const CHUNK_SIZE = 512 * 1024;
  let rawText = "";
  if (stats.size > CHUNK_SIZE) {
    const handle = await fs.open(resolved, "r");
    try {
      const buffer = Buffer.alloc(CHUNK_SIZE);
      const position = stats.size - CHUNK_SIZE;
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, position);
      rawText = buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } else {
    rawText = await fs.readFile(resolved, "utf-8");
  }

  const allLines = rawText.split(/\r?\n/);
  if (allLines.length > 1 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  const tailLines = allLines.slice(-count);
  const startIdx = Math.max(1, allLines.length - tailLines.length + 1);
  const content = tailLines
    .map((line, idx) => `${startIdx + idx}: ${line}`)
    .join("\n");

  return {
    filePath: resolved,
    totalLines: allLines.length,
    linesReturned: tailLines.length,
    content,
  };
}

/**
 * Compute cryptographic hash (SHA-256, MD5, SHA-1) of a file via streaming
 */
export async function hashFile(
  filePath: string,
  algorithm: "sha256" | "md5" | "sha1" = "sha256"
): Promise<FileHashResult> {
  const configManager = ConfigManager.getInstance();
  const pathCheck = configManager.isPathAllowed(filePath);
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = statSync(resolved);
  if (stats.isDirectory()) {
    throw new Error(`Target path is a directory, not a file: ${filePath}`);
  }

  const validAlgos = ["sha256", "md5", "sha1"] as const;
  if (!validAlgos.includes(algorithm as any)) {
    throw new Error(`Unsupported hash algorithm '${algorithm}'. Choose from: ${validAlgos.join(", ")}`);
  }

  const hash = await new Promise<string>((resolve, reject) => {
    const hasher = createHash(algorithm);
    const stream = createReadStream(resolved);
    stream.on("data", (chunk) => hasher.update(chunk));
    stream.on("end", () => resolve(hasher.digest("hex")));
    stream.on("error", (err) => reject(err));
  });

  const sizeBytes = stats.size;
  let sizeFormatted = `${sizeBytes} B`;
  if (sizeBytes >= 1024 * 1024) {
    sizeFormatted = `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
  } else if (sizeBytes >= 1024) {
    sizeFormatted = `${(sizeBytes / 1024).toFixed(2)} KB`;
  }

  return {
    filePath: resolved,
    algorithm,
    hash,
    sizeBytes,
    sizeFormatted,
  };
}

