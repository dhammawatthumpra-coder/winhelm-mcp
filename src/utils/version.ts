import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

/**
 * Single source of truth for the server version, read dynamically from package.json.
 */
export function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(currentDir, "..", "..", "package.json"),
      path.resolve(currentDir, "..", "package.json"),
      path.resolve(process.cwd(), "package.json"),
    ];
    for (const pkgPath of candidates) {
      if (existsSync(pkgPath)) {
        const raw = readFileSync(pkgPath, "utf-8");
        const cleanRaw = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        const data = JSON.parse(cleanRaw);
        if (data.version && typeof data.version === "string") {
          cachedVersion = data.version;
          return cachedVersion!;
        }
      }
    }
  } catch {
    // Fallback if filesystem read fails
  }
  return "1.2.1";
}

export const SERVER_VERSION = getPackageVersion();
