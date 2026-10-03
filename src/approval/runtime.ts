import {
  ApprovalEngine,
  type ApprovalEngineOptions,
} from "./approval-engine.js";

let engine = new ApprovalEngine();

export function getApprovalEngine(): ApprovalEngine {
  return engine;
}

/**
 * Test/support hook. Production code should use the process-wide singleton so
 * approval jobs are shared across MCP sessions, dashboard/admin routes and
 * recovery tools in one WinHelm process.
 */
export function resetApprovalEngine(
  options: ApprovalEngineOptions = {}
): ApprovalEngine {
  engine = new ApprovalEngine(options);
  return engine;
}
