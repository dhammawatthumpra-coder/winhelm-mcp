import path from "node:path";
import type { ServerConfig } from "../types/index.js";
import { isWildcardAllowAll } from "./config-manager.js";

export interface V2PermissionCliOverrides {
  allowedDirectories?: string[];
  readOnly?: boolean;
}

function comparablePath(value: string): string {
  const resolved = path.normalize(path.resolve(value.normalize("NFKC")));
  return process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

export function buildSchemaV2CliPermissionUpdates(
  current: Readonly<ServerConfig>,
  overrides: V2PermissionCliOverrides
): Partial<ServerConfig> {
  const existingFolders = current.folders ?? [];
  const existingByPath = new Map(
    existingFolders.map((folder) => [
      comparablePath(folder.path),
      folder,
    ])
  );

  let folders = existingFolders.map((folder) => ({
    ...folder,
  }));

  if (overrides.allowedDirectories !== undefined) {
    const explicit = overrides.allowedDirectories
      .map((entry) => entry.normalize("NFKC").trim())
      .filter(Boolean);

    // Schema-v2 never revives legacy wildcard semantics. A wildcard CLI
    // override becomes an empty fail-closed folder set, matching ENV mapping.
    const safePaths = explicit.filter(
      (entry) => !isWildcardAllowAll([entry])
    );

    folders = safePaths.map((folderPath) => {
      const resolved = path.resolve(folderPath);
      const previous = existingByPath.get(
        comparablePath(resolved)
      );
      return {
        path: resolved,
        ...(previous?.alias
          ? { alias: previous.alias }
          : {}),
        permission: overrides.readOnly
          ? "read"
          : "readwrite",
      };
    });
  } else if (overrides.readOnly) {
    folders = folders.map((folder) => ({
      ...folder,
      permission: "read",
    }));
  }

  const updates: Partial<ServerConfig> = {};
  if (overrides.allowedDirectories !== undefined || overrides.readOnly) {
    updates.folders = folders;
  }

  if (overrides.readOnly) {
    updates.terminal = {
      ...(current.terminal ?? { mode: "off" }),
      mode: "off",
    };
  }

  return updates;
}
