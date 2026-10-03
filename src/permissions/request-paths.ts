import path from "node:path";
import type { FolderPermission } from "../config/schema-v2.js";

export interface FolderDescriptor {
  alias: string | null;
  path: string;
  permission: FolderPermission["permission"];
}

export type RequestPathResolution =
  | { ok: true; path: string; alias: string | null }
  | {
      ok: false;
      code: "AMBIGUOUS_PATH" | "FOLDER_OUTSIDE_ALLOWED";
      reason: string;
      folders: FolderDescriptor[];
    };

export function describeFolders(
  folders: FolderPermission[] | undefined
): FolderDescriptor[] {
  return (folders ?? [])
    .filter(
      (folder) =>
        typeof folder.path === "string" && folder.path.trim().length > 0
    )
    .map((folder) => ({
      alias:
        typeof folder.alias === "string" && folder.alias.trim().length > 0
          ? folder.alias
          : null,
      path: folder.path,
      permission: folder.permission,
    }));
}

function normalizeAlias(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/**
 * Resolve one schema-v2 request path before authorization.
 *
 * The baseline allows a full path or `@alias/...`. A relative path is only
 * unambiguous while exactly one folder is configured; otherwise the request is
 * refused with AMBIGUOUS_PATH plus the folder list, because resolving it
 * against the server working directory would silently pick a location the
 * caller never named.
 */
export function resolveRequestPath(
  value: string,
  folders: FolderPermission[] | undefined
): RequestPathResolution {
  const raw = value.normalize("NFKC").trim();
  const configured = (folders ?? []).filter(
    (folder) =>
      typeof folder.path === "string" && folder.path.trim().length > 0
  );

  if (raw.startsWith("@")) {
    const withoutSigil = raw.slice(1);
    const separator = withoutSigil.search(/[\\/]/);
    const aliasName = normalizeAlias(
      separator < 0 ? withoutSigil : withoutSigil.slice(0, separator)
    );
    const remainder =
      separator < 0 ? "" : withoutSigil.slice(separator + 1);

    const match = aliasName
      ? configured.find(
          (folder) =>
            typeof folder.alias === "string" &&
            normalizeAlias(folder.alias) === aliasName
        )
      : undefined;

    if (!match) {
      return {
        ok: false,
        code: "FOLDER_OUTSIDE_ALLOWED",
        reason: `Unknown WinHelm folder alias: ${raw}`,
        folders: describeFolders(configured),
      };
    }

    return {
      ok: true,
      path: remainder
        ? path.resolve(match.path, remainder)
        : path.resolve(match.path),
      alias: match.alias ?? null,
    };
  }

  if (path.isAbsolute(raw)) {
    return { ok: true, path: path.resolve(raw), alias: null };
  }

  if (configured.length === 0) {
    return {
      ok: false,
      code: "FOLDER_OUTSIDE_ALLOWED",
      reason:
        "No WinHelm folder is configured, so a relative path cannot be resolved.",
      folders: [],
    };
  }

  if (configured.length === 1) {
    return {
      ok: true,
      path: path.resolve(configured[0].path, raw),
      alias: configured[0].alias ?? null,
    };
  }

  return {
    ok: false,
    code: "AMBIGUOUS_PATH",
    reason: `Relative path "${raw}" is ambiguous while ${configured.length} WinHelm folders are configured.`,
    folders: describeFolders(configured),
  };
}
