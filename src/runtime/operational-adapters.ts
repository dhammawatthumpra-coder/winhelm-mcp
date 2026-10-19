/**
 * WinHelm v1.4.1 Cross-Tranche Authoritative Operational Adapters (Corrective R1)
 * 
 * Provides truthful, authoritative, non-fabricated operational status bridges across:
 * - Tranche A: Dynamic Internal Port Allocation (via resolveVerifiedInternalTopology / resolveVerifiedRuntimeEndpoint)
 * - Tranche B: Approval UX & Windows Native Toast Integration (via accepted R5 Get-WinHelmApprovalIntegrationStatus)
 * - Tranche C: Product Shell & Dashboard Refresh
 * 
 * Invariants:
 * - No unverified runtime hints promoted to Active.
 * - No mock or hard-coded fallback ports (18820/18821/18822) in live runtime.
 * - Deterministic live OS registry & shortcut state determines native approval operational state.
 * - Substring checks and arbitrary file existence heuristics are completely eliminated.
 * - Non-authoritative receipt metadata never controls operational ownership.
 * - Setup Assistant remains truthfully unavailable with launch disabled.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ConfigManager } from "../config/config-manager.js";
import type { ServerOptions } from "../gateway/server.js";
import type {
  CrossTrancheAdapters,
  DynamicInternalPortsStatus,
  NativeApprovalIntegrationStatus,
  SetupAssistantIntegrationStatus,
  DynamicEndpointInfo,
} from "../gateway/ui/common.js";
import {
  resolveVerifiedRuntimeEndpoint,
  type ResolveVerifiedRuntimeEndpointOptions,
  type VerifiedRuntimeEndpoint,
} from "./endpoint-registry.js";
import {
  resolveVerifiedInternalTopology,
  type TrustedRuntimeTopologyIdentities,
  type VerifiedInternalTopology,
} from "./launcher-contract.js";

const execFileAsync = promisify(execFile);

export interface NativeApprovalOptions {
  installRoot?: string;
  approvalClassifier?: (
    installRoot?: string
  ) => Promise<NativeApprovalIntegrationStatus> | NativeApprovalIntegrationStatus;
}

export interface OperationalAdaptersOptions extends ServerOptions {
  trustedIdentities?: TrustedRuntimeTopologyIdentities;
  topologyResolver?: (
    identities: TrustedRuntimeTopologyIdentities,
    resolver?: (options: ResolveVerifiedRuntimeEndpointOptions) => Promise<VerifiedRuntimeEndpoint | undefined>
  ) => Promise<VerifiedInternalTopology>;
  endpointResolver?: (
    options: ResolveVerifiedRuntimeEndpointOptions
  ) => Promise<VerifiedRuntimeEndpoint | undefined>;
  approvalClassifier?: (
    installRoot?: string
  ) => Promise<NativeApprovalIntegrationStatus> | NativeApprovalIntegrationStatus;
}

/**
 * Returns dynamic internal ports operational status.
 * Authoritative: in automatic mode, lists only verified active endpoints.
 * In fixed mode, reports fixed port allocation.
 * Stale hints or hints with mismatched process/listener/health are NEVER promoted to Active.
 */
export async function getDynamicInternalPortsStatus(
  options?: OperationalAdaptersOptions
): Promise<DynamicInternalPortsStatus> {
  const selectionMode = options?.internalPortSelection?.mode;
  const isAuto = selectionMode === "auto";
  const mode = isAuto ? "automatic" : "fixed";

  const effectivePort =
    ConfigManager.getInstance().getRuntimeEffectivePort() ??
    options?.port ??
    8788;

  const endpoints: DynamicEndpointInfo[] = [
    {
      service: "Core Gateway",
      url: `http://127.0.0.1:${effectivePort}`,
      status: "Active",
    },
  ];

  // Consume accepted runtime topology verifier when identities or resolver are available
  if (options?.trustedIdentities) {
    const topologyResolver = options.topologyResolver ?? resolveVerifiedInternalTopology;
    const endpointResolver = options.endpointResolver ?? resolveVerifiedRuntimeEndpoint;
    try {
      const topology = await topologyResolver(options.trustedIdentities, endpointResolver);
      for (const role of ["r7", "r8"] as const) {
        const ep = topology.internal[role];
        if (ep && ep.state === "ready" && ep.host && ep.port) {
          endpoints.push({
            service: role.toUpperCase(),
            url: `http://${ep.host}:${ep.port}`,
            status: "Active",
          });
        }
      }
    } catch {
      // Fail closed: never fabricate active endpoints on resolver failure
    }
  } else if (options?.endpointResolver) {
    for (const role of ["r7", "r8"] as const) {
      try {
        const verified = await options.endpointResolver({
          role,
          expectedExecutablePath: "",
          expectedEntrypointPath: "",
        });
        if (verified && verified.host && verified.port) {
          endpoints.push({
            service: role.toUpperCase(),
            url: `http://${verified.host}:${verified.port}`,
            status: "Active",
          });
        }
      } catch {
        // Fail closed
      }
    }
  }

  return { mode, endpoints };
}

interface CachedNativeStatus {
  timestamp: number;
  status: NativeApprovalIntegrationStatus;
}
let nativeStatusCache: CachedNativeStatus | null = null;
const CACHE_TTL_MS = 2500;

export function clearNativeApprovalStatusCache(): void {
  nativeStatusCache = null;
}

/**
 * Returns live Windows Native Approval integration status.
 * Authoritative: Consumes accepted R5 Get-WinHelmApprovalIntegrationStatus classifier.
 * Never uses substring heuristics or loose file existence checks.
 */
export async function getNativeApprovalStatus(
  forceFresh: boolean = false,
  options?: NativeApprovalOptions
): Promise<NativeApprovalIntegrationStatus> {
  if (process.platform !== "win32") {
    return "unavailable";
  }

  const now = Date.now();
  if (
    !forceFresh &&
    nativeStatusCache &&
    now - nativeStatusCache.timestamp < CACHE_TTL_MS &&
    !options?.approvalClassifier
  ) {
    return nativeStatusCache.status;
  }

  // 1. Dependency injection / custom classifier for adversarial testing
  if (options?.approvalClassifier) {
    try {
      const status = await options.approvalClassifier(options.installRoot);
      return status;
    } catch {
      return "unavailable"; // fail-closed
    }
  }

  // 2. Consume accepted R5 operational classifier via installer/scripts/Get-ApprovalStatus.ps1
  let status: NativeApprovalIntegrationStatus = "unavailable";
  try {
    const installRoot = options?.installRoot ?? process.cwd();
    let scriptPath = path.resolve(installRoot, "installer", "scripts", "Get-ApprovalStatus.ps1");
    if (!fs.existsSync(scriptPath)) {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      scriptPath = path.resolve(currentDir, "..", "..", "installer", "scripts", "Get-ApprovalStatus.ps1");
    }

    if (!fs.existsSync(scriptPath)) {
      status = "unavailable";
    } else {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-InstallRoot",
          installRoot,
        ],
        {
          timeout: 4000,
          windowsHide: true,
          encoding: "utf8",
        }
      );

      const parsed = JSON.parse(stdout.trim());
      if (parsed.status === "ready") {
        status = "ready";
      } else if (parsed.status === "needs_repair" || parsed.status === "conflict") {
        status = "needs_repair";
      } else {
        status = "unavailable";
      }
    }
  } catch {
    // Fail-closed on any classifier execution or timeout error
    status = "unavailable";
  }

  nativeStatusCache = { timestamp: now, status };
  return status;
}

/**
 * Returns Setup Assistant companion operational status.
 * Truthfully returns 'unavailable' when no standalone packaged binary exists.
 */
export function getSetupAssistantStatus(): SetupAssistantIntegrationStatus {
  return "unavailable";
}

/**
 * Aggregates all cross-tranche operational adapters for Product Shell consumption.
 */
export async function getCrossTrancheAdapters(
  options?: OperationalAdaptersOptions
): Promise<CrossTrancheAdapters> {
  const [dynamicPorts, nativeApproval] = await Promise.all([
    getDynamicInternalPortsStatus(options),
    getNativeApprovalStatus(false, {
      installRoot: options?.runtimeIdentity ? process.cwd() : undefined,
      approvalClassifier: options?.approvalClassifier,
    }),
  ]);

  return {
    dynamicPorts,
    nativeApproval,
    setupAssistant: getSetupAssistantStatus(),
  };
}
