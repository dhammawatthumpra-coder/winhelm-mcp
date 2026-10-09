/**
 * Spec 3.4 Tier B — governed resource monitoring engine.
 *
 * `memory_info` reads global physical/commit memory directly through the
 * trusted native boundary (`GlobalMemoryStatusEx`); PowerShell and WMI are
 * deliberately never used.
 *
 * `process_resource_monitor` inspects one WinHelm-governed run through the
 * existing Job Object ownership model. Session ownership is enforced with the
 * same run-manager contract as `command_wait`; the observation is bounded and
 * never cancels, waits on, or otherwise mutates the governed run. For
 * completed runs only truthfully retained metrics are reported.
 */
import { getNativeBoundary } from "../native/boundary.js";
import {
  getRunManager,
  RunNotFoundError,
  RunOwnershipError,
} from "./run-manager.js";
import { StructuredToolError } from "../errors/tool-error.js";

const BIGINT_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function integerSafe(value: bigint, field: string): number {
  if (value < 0n) {
    throw new StructuredToolError(
      "RESOURCE_COUNTER_INVALID",
      `The host reported a negative counter for ${field}; refusing to report it.`,
      "Retry the observation; if it persists, report the native boundary issue."
    );
  }
  if (value > BIGINT_MAX_SAFE_INTEGER) {
    throw new StructuredToolError(
      "RESOURCE_COUNTER_OVERFLOW",
      `The host counter ${field} exceeds the JavaScript safe-integer range; the value is reported only as an exact string.`,
      "Use the exact string representation provided in details.",
      { field, exact: value.toString() }
    );
  }
  return Number(value);
}

export interface MemoryInfoResult {
  available_physical_bytes: number;
  total_physical_bytes: number;
  memory_load_percent: number;
  commit_total_bytes: number;
  commit_available_bytes: number;
  commit_used_bytes: number;
  virtual_total_bytes: number;
  virtual_available_bytes: number;
  source: "GlobalMemoryStatusEx";
}

export function readSystemMemoryInfo(): MemoryInfoResult {
  const status = getNativeBoundary().memoryStatus();
  const totalPhysical = integerSafe(status.totalPhysBytes, "total_physical_bytes");
  const availPhysical = integerSafe(status.availPhysBytes, "available_physical_bytes");
  const commitTotal = integerSafe(status.totalPageFileBytes, "commit_total_bytes");
  const commitAvailable = integerSafe(
    status.availPageFileBytes,
    "commit_available_bytes"
  );
  const virtualTotal = integerSafe(status.totalVirtualBytes, "virtual_total_bytes");
  const virtualAvailable = integerSafe(
    status.availVirtualBytes,
    "virtual_available_bytes"
  );
  return {
    available_physical_bytes: availPhysical,
    total_physical_bytes: totalPhysical,
    memory_load_percent: status.memoryLoadPercent,
    commit_total_bytes: commitTotal,
    commit_available_bytes: commitAvailable,
    commit_used_bytes: commitTotal - commitAvailable,
    virtual_total_bytes: virtualTotal,
    virtual_available_bytes: virtualAvailable,
    source: "GlobalMemoryStatusEx",
  };
}

export interface LiveResourceObservation {
  run_id: string;
  run_state: "running";
  source: "job_object";
  session_id: string;
  peak_working_set_bytes: number;
  current_private_bytes: number;
  user_cpu_time_ns: number;
  kernel_cpu_time_ns: number;
  contained_pids: number[];
}

export interface RetainedResourceObservation {
  run_id: string;
  run_state: string;
  source: "retained";
  session_id: string;
  peak_working_set_bytes: number | null;
  current_private_bytes: null;
  user_cpu_time_ns: null;
  kernel_cpu_time_ns: null;
  contained_pids: null;
  started_at_utc?: string;
  ended_at_utc?: string;
  exit_code?: number;
  note: string;
}

export type ResourceMonitorResult =
  | LiveResourceObservation
  | RetainedResourceObservation;

export function monitorGovernedRun(
  runId: string,
  sessionKey: string,
  principalId?: string
): ResourceMonitorResult {
  const manager = getRunManager();
  // Ownership is enforced for live AND terminal records alike; cross-session
  // run_ids are denied with RUN_PERMISSION_DENIED, unknown with RUN_NOT_FOUND.
  const owned = manager.requireOwnedRun(runId, sessionKey, principalId);

  const live = manager.getLive(runId);
  if (live && owned === live) {
    // Non-cancelling observation: the native query only reads counters.
    const info = live.native.resourceInfo();
    return {
      run_id: runId,
      run_state: "running",
      source: "job_object",
      session_id: live.session_id,
      peak_working_set_bytes: integerSafe(
        info.peakWorkingSetBytes,
        "peak_working_set_bytes"
      ),
      current_private_bytes: integerSafe(
        info.currentPrivateBytes,
        "current_private_bytes"
      ),
      user_cpu_time_ns: integerSafe(info.userCpuTimeNs, "user_cpu_time_ns"),
      kernel_cpu_time_ns: integerSafe(
        info.kernelCpuTimeNs,
        "kernel_cpu_time_ns"
      ),
      contained_pids: [...info.pids],
    };
  }

  // Completed run: only metrics truthfully retained by the run manager are
  // reported; unavailable live Job state is reported as null, never fabricated.
  const record = manager.getFinished(runId);
  const retained = manager.getStoredFinalResult(runId);
  return {
    run_id: runId,
    run_state: record?.state ?? "unknown",
    source: "retained",
    session_id: record?.session_id ?? sessionKey,
    peak_working_set_bytes:
      retained && retained.peak_rss_bytes !== null
        ? retained.peak_rss_bytes
        : null,
    current_private_bytes: null,
    user_cpu_time_ns: null,
    kernel_cpu_time_ns: null,
    contained_pids: null,
    ...(record?.started_at_utc ? { started_at_utc: record.started_at_utc } : {}),
    ...(record?.ended_at_utc ? { ended_at_utc: record.ended_at_utc } : {}),
    ...(record?.exit_code !== undefined
      ? { exit_code: record.exit_code }
      : {}),
    note: "The governed run has completed; live Job Object state is no longer available and only retained metrics are reported.",
  };
}

export function resourceMonitorErrorResult(err: unknown): {
  code: string;
  message: string;
  userAction?: string;
} {
  if (err instanceof RunNotFoundError) {
    return {
      code: "RUN_NOT_FOUND",
      message: err.message,
      userAction:
        "Check the run_id from the command_run result of this session.",
    };
  }
  if (err instanceof RunOwnershipError) {
    return {
      code: "RUN_PERMISSION_DENIED",
      message: err.message,
      userAction:
        "process_resource_monitor only accepts run_id values launched by the current session.",
    };
  }
  if (err instanceof StructuredToolError) {
    return {
      code: err.code,
      message: err.message,
      userAction: err.userAction,
    };
  }
  return {
    code: "RESOURCE_MONITOR_FAILED",
    message: err instanceof Error ? err.message : String(err),
  };
}
