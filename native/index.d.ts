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

export interface ContainedProcess {
  wait(timeoutMs?: number): ContainedWaitResult;
  terminate(exitCode?: number): void;
  isInJob(): boolean;
  pid(): number;
  close(): void;
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
}
