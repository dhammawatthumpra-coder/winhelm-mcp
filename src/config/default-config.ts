import type { ServerConfig } from "../types/index.js";

export const DEFAULT_BLOCKED_PATTERNS: string[] = [
  "\\bdiskpart(\\b|\\.exe)",
  "\\binitialize-disk\\b",
  "\\bclear-disk\\b",
  "\\bformat-volume\\b",
  "\\bformat-disk\\b",
  "\\breg(\\s+|\\.exe\\s+)delete\\s+hklm",
  "\\bbcdedit(\\b|\\.exe)",
  "\\bbootrec(\\b|\\.exe)",
  "\\bnet(\\s+|\\.exe\\s+)user\\s+.*\\/add",
  "\\btakeown(\\s+|\\.exe\\s+).*(/f|-f)",
  "\\bicacls(\\s+|\\.exe\\s+).*(\\/grant|-grant)",
  "\\bmimikatz",
  "\\bprocdump.*lsass",
  "comsvcs\\.dll",
  "\\bformat(\\s+|\\.com\\s+)[a-zA-Z]:",
  "\\brmdir(\\s+|\\.exe\\s+).*[\\/\\-]s",
  "\\bdel(\\s+|\\.exe\\s+).*[\\/\\-]s.*[\\/\\-]q.*[a-zA-Z]:\\\\",
  "\\bremove-item\\b.*-recurse.*-force.*[a-zA-Z]:\\\\",
];

export const DEFAULT_CONFIG: ServerConfig = {
  blockedCommands: [
    "format-volume",
    "format-disk",
    "clear-disk",
    "stop-computer",
    "restart-computer",
    "rmdir /s /q c:\\",
    "del /f /s /q c:\\",
    "remove-item -recurse -force c:\\",
  ],
  blockedCommandPatterns: [...DEFAULT_BLOCKED_PATTERNS],
  allowedDirectories: [], // Empty means unrestricted access
  allowSystemExecution: true, // Allows invoking runtimes on C: (Python/Node/Git) while restricting workspace file writes
  fileReadLineLimit: 2000,
  defaultTimeoutMs: 60000,
  telemetryEnabled: false,
  authToken: null,
  readOnly: false,
  rateLimitPerMinute: 120,
  profile: "full",
  searchExcludeDirs: ["dist", "logs", "build", "out"],
  preferPwsh: true,
};

