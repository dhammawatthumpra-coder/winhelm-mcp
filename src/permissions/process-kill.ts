export interface ProcessKillArguments {
  pid?: number;
  name?: string;
}

export interface ProcessOwnershipLookup {
  ownsRunningPid(pid: number): boolean;
}

/**
 * process_kill may execute without a new approval only when the caller targets
 * one concrete, currently-running PID that WinHelm itself started.
 *
 * Name-based termination is always treated as external because it can match
 * multiple processes and cannot be bound safely to one owned PID.
 */
export function processKillNeedsExternalApproval(
  args: ProcessKillArguments,
  ownership: ProcessOwnershipLookup
): boolean {
  if (
    typeof args.pid === "number" &&
    Number.isInteger(args.pid) &&
    args.pid > 0 &&
    !args.name
  ) {
    return !ownership.ownsRunningPid(args.pid);
  }

  return true;
}
