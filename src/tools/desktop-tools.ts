import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  captureScreen,
  checkPort,
  controlService,
  getClipboard,
  getGpuInfo,
  getServiceStatus,
  getSystemInfo,
  killProcess,
  listProcesses,
  listServices,
  openTarget,
  queryEventLog,
  sendNotification,
  setClipboard,
} from "../engine/system.js";
import { registerTracedTool } from "./tool-wrapper.js";

export function registerDesktopTools(server: McpServer): void {
  // 1. Clipboard Get
  registerTracedTool(server, "clipboard_get", {}, async () => {
    try {
      const text = await getClipboard();
      return {
        content: [{ type: "text", text: text || "(Clipboard is empty or contains non-text data)" }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to get clipboard: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // 2. Clipboard Set
  registerTracedTool(
    server,
    "clipboard_set",
    {
      text: z.string().describe("Text content to copy to Windows clipboard"),
    },
    async ({ text }) => {
      try {
        await setClipboard(text);
        return {
          content: [
            { type: "text", text: `Successfully copied ${text.length} characters to clipboard` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to set clipboard: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 3. Screen Capture
  registerTracedTool(server, "screen_capture", {}, async () => {
    try {
      const base64 = await captureScreen();
      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: "image/png",
          },
          {
            type: "text",
            text: "Screenshot captured successfully (primary display).",
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Screenshot failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // 4. System Open (URL, Folder, File)
  registerTracedTool(
    server,
    "system_open",
    {
      target: z.string().describe("URL, folder path, or file to open with default application"),
    },
    async ({ target }) => {
      try {
        const res = await openTarget(target);
        return {
          content: [{ type: "text", text: `Opened: ${res.target}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Open failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 5. System Info
  registerTracedTool(server, "system_info", {}, async () => {
    try {
      const info = await getSystemInfo();
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to get system info: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // 6. Process Kill
  registerTracedTool(
    server,
    "process_kill",
    {
      pid: z.number().optional().describe("Process ID to terminate"),
      name: z.string().optional().describe("Process Name (e.g. 'node', 'notepad')"),
    },
    async ({ pid, name }) => {
      try {
        const res = await killProcess(pid, name);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Kill process failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 7. Port Check
  registerTracedTool(
    server,
    "port_check",
    {
      port: z.number().describe("TCP port number to check (e.g. 8788, 3000)"),
    },
    async ({ port }) => {
      try {
        const res = await checkPort(port);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Port check failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
  // 8. GPU Info
  registerTracedTool(server, "gpu_info", {}, async () => {
    try {
      const info = await getGpuInfo();
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to query GPU info: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // 9. Windows Services List
  registerTracedTool(
    server,
    "service_list",
    {
      filter: z.string().optional().describe("Filter services by name substring (e.g. 'docker', 'ssh', 'postgres')"),
    },
    async ({ filter }) => {
      try {
        const services = await listServices(filter);
        return {
          content: [
            {
              type: "text",
              text:
                services.length > 0
                  ? JSON.stringify(services, null, 2)
                  : `No services matching filter "${filter || ""}"`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to list services: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 10. Windows Service Status
  registerTracedTool(
    server,
    "service_status",
    {
      service_name: z.string().describe("Exact name of the Windows service (e.g. 'ssh-agent', 'wslservice')"),
    },
    async ({ service_name }) => {
      try {
        const status = await getServiceStatus(service_name);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to get service status: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 11. Windows Service Control
  registerTracedTool(
    server,
    "service_control",
    {
      service_name: z.string().describe("Exact name of the Windows service to control"),
      action: z.enum(["start", "stop", "restart"]).describe("Action to perform on the service"),
    },
    async ({ service_name, action }) => {
      try {
        const res = await controlService(service_name, action);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to ${action} service: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 12. Process List & Top Processes
  registerTracedTool(
    server,
    "process_list",
    {
      limit: z.number().optional().describe("Maximum number of processes to return (default: 20, max: 100)"),
      sort_by: z.enum(["cpu", "memory", "name", "pid"]).optional().describe("Sort processes by resource or property (default: memory)"),
      filter: z.string().optional().describe("Filter process name or path substring"),
    },
    async ({ limit, sort_by, filter }) => {
      try {
        const procs = await listProcesses({
          limit,
          sortBy: sort_by,
          filter,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(procs, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to list processes: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 13. Windows Event Log Query
  registerTracedTool(
    server,
    "eventlog_query",
    {
      log_name: z.string().optional().describe("Windows Event Log name (e.g. 'Application', 'System', default: 'Application')"),
      level: z.enum(["Critical", "Error", "Warning", "Information", "All"]).optional().describe("Event severity level (default: Error)"),
      hours: z.number().optional().describe("Query events from past N hours (default: 24)"),
      source: z.string().optional().describe("Filter by provider or application source name"),
      limit: z.number().optional().describe("Maximum number of events to return (default: 20, max: 100)"),
    },
    async ({ log_name, level, hours, source, limit }) => {
      try {
        const events = await queryEventLog({
          logName: log_name,
          level,
          hours,
          source,
          limit,
        });
        return {
          content: [
            {
              type: "text",
              text: events.length > 0 ? JSON.stringify(events, null, 2) : "[] (No matching events found)",
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to query event log: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 14. Windows Toast Notification
  registerTracedTool(
    server,
    "notification_send",
    {
      title: z.string().describe("Toast notification title (e.g. 'Task Complete')"),
      message: z.string().describe("Notification body text"),
      sound: z.boolean().optional().describe("Play alert sound with notification (default: true)"),
    },
    async ({ title, message, sound }) => {
      try {
        const res = await sendNotification(title, message, sound !== false);
        return {
          content: [{ type: "text", text: `Notification sent: "${res.title}" - ${res.message}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to send notification: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}

