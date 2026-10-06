export interface StableReadSnapshot {
  bytes: number;
  sha256: string;
  fileAttributes: number;
  reparseTag: number;
  reparsePoint: boolean;
  volumeSerialNumber: number;
  fileIndexHigh: number;
  fileIndexLow: number;
}

export interface StableReadMetadata {
  fileAttributes: number;
  reparseTag: number;
  reparsePoint: boolean;
  volumeSerialNumber: number;
  fileIndexHigh: number;
  fileIndexLow: number;
}

export interface StableReadHandle {
  snapshot(): StableReadSnapshot;
  metadata(): StableReadMetadata;
  close(): void;
}

export interface AtomicMutationResult {
  bytesWritten: number;
  flushed: true;
  committed: true;
  moveFlags: number;
  tempDirectory: string;
  targetDirectory: string;
}

export interface ContainedWaitResult {
  status: "timeout" | "exited";
  exitCode?: number;
}

export interface ContainedStreamError {
  code: "STREAM_IO_FAILED";
  nativeCode: number;
}

export interface ContainedStreamState {
  retainedBytes: number;
  totalBytes: number;
  truncated: boolean;
  complete: boolean;
  sha256: string | null;
  error: ContainedStreamError | null;
}

export interface ContainedStreamSink {
  path: string;
  mode: "create_new" | "overwrite" | "append";
}

export interface ContainedSpawnOptions {
  environment: Array<{ name: string; value: string }>;
  captureLimitBytes: number;
  stdoutSink?: ContainedStreamSink;
  stderrSink?: ContainedStreamSink;
}

export interface ContainedProcess {
  wait(timeoutMs?: number): ContainedWaitResult;
  terminate(exitCode?: number): void;
  isInJob(): boolean;
  resourceInfo(): ContainedResourceInfo;
  pid(): number;
  close(): void;
}

/**
 * Spec 3.4 Tier B bounded, non-cancelling observation of one governed
 * contained process and its Job Object. Host counters arrive as exact uint64
 * BigInt values; the TS engine owns integer-safe conversion.
 */
export interface ContainedResourceInfo {
  peakWorkingSetBytes: bigint;
  currentPrivateBytes: bigint;
  userCpuTimeNs: bigint;
  kernelCpuTimeNs: bigint;
  pids: number[];
}

export interface NativeMemoryStatus {
  memoryLoadPercent: number;
  totalPhysBytes: bigint;
  availPhysBytes: bigint;
  totalPageFileBytes: bigint;
  availPageFileBytes: bigint;
  totalVirtualBytes: bigint;
  availVirtualBytes: bigint;
}

export interface GovernedContainedProcess extends ContainedProcess {
  waitAsync(timeoutMs?: number): Promise<ContainedWaitResult>;
  streamState(stream: "stdout" | "stderr"): ContainedStreamState;
  streamCapture(stream: "stdout" | "stderr"): Buffer;
  peakRss(): number;
}

export interface WinHelmNativeBoundary {
  readonly abi: "node-api";
  readonly napiVersion: 10;
  stableReadOpen(path: string): StableReadHandle;
  createExclusive(path: string, content: Buffer): {
    created: true;
    bytesWritten: number;
    flushed: true;
  };
  atomicReplace(path: string, content: Buffer): AtomicMutationResult;
  spawnContained(command: string, args: string[], cwd?: string | null): ContainedProcess;
  spawnContained(
    command: string,
    args: string[],
    cwd: string | null | undefined,
    options: ContainedSpawnOptions,
  ): GovernedContainedProcess;
  memoryStatus(): NativeMemoryStatus;
}
