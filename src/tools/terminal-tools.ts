import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runPowerShell } from "../engine/powershell-runner.js";
import { taskManager } from "../engine/task-manager.js";
import { registerTracedTool } from "./tool-wrapper.js";

export function registerTerminalTools(server: McpServer): void {
  // 1. Synchronous PowerShell Execution
  registerTracedTool(
    server,
    "terminal_run",
    {
      command: z.string().describe("PowerShell command to execute"),
      cwd: z.string().optional().describe("Working directory for command execution"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Maximum execution time in milliseconds (default: 60000)"),
    },
    async ({ command, cwd, timeout_ms }) => {
      try {
        const res = await runPowerShell(command, { cwd, timeoutMs: timeout_ms });
        let output = "";
        if (res.timedOut) {
          output += `[Command timed out after ${timeout_ms || 60000}ms]\n`;
        }
        if (res.stdout) output += res.stdout;
        if (res.stderr) output += (output ? "\n[STDERR]\n" : "") + res.stderr;
        if (!output) output = `(Command finished with exit code ${res.exitCode} and no output)`;

        return {
          content: [{ type: "text", text: output }],
          isError: res.exitCode !== 0,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Execution failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 2. Start Long-Running Background Task
  registerTracedTool(
    server,
    "terminal_task_start",
    {
      command: z.string().describe("Command to run in background (e.g. dev servers, watcher, long builds)"),
      cwd: z.string().optional().describe("Working directory for task execution"),
    },
    async ({ command, cwd }) => {
      try {
        const task = taskManager.startTask(command, cwd);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message: `Background task started successfully with ID: ${task.id}`,
                  task,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to start background task: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 3. List All Background Tasks
  registerTracedTool(server, "terminal_task_list", {}, async () => {
    try {
      const tasks = taskManager.listTasks();
      return {
        content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to list tasks: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // 4. View Background Task Output Logs
  registerTracedTool(
    server,
    "terminal_task_logs",
    {
      task_id: z.string().describe("Task ID returned from terminal_task_start"),
      tail_lines: z.number().optional().describe("Number of trailing lines to view (default: 100)"),
    },
    async ({ task_id, tail_lines = 100 }) => {
      try {
        const res = taskManager.getTaskLogs(task_id, tail_lines);
        return {
          content: [
            {
              type: "text",
              text: `=== Background Task Logs [${task_id}] (Status: ${res.task.status}) ===\n${res.logs || "(No output produced yet)"}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to get task logs: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 5. Send Input to Background Task
  registerTracedTool(
    server,
    "terminal_task_send",
    {
      task_id: z.string().describe("Task ID of running background process"),
      input: z.string().describe("Text input to send to stdin"),
    },
    async ({ task_id, input }) => {
      try {
        taskManager.sendInput(task_id, input);
        return {
          content: [{ type: "text", text: `Input successfully sent to task ${task_id}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to send input: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 6. Kill Background Task
  registerTracedTool(
    server,
    "terminal_task_kill",
    {
      task_id: z.string().describe("Task ID to terminate"),
    },
    async ({ task_id }) => {
      try {
        taskManager.killTask(task_id);
        return {
          content: [{ type: "text", text: `Background task ${task_id} terminated.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to kill task: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
