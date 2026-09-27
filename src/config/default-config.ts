import type { ServerConfig } from "../types/index.js";

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
  allowedDirectories: [], // Empty means unrestricted access
  allowSystemExecution: true, // Allows invoking runtimes on C: (Python/Node/Git) while restricting workspace file writes
  fileReadLineLimit: 2000,
  defaultTimeoutMs: 60000,
  telemetryEnabled: false,
  authToken: null,
  readOnly: false,
  rateLimitPerMinute: 120,
  profile: "full",
};

