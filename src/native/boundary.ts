/**
 * WinHelm repository-owned native boundary loader.
 *
 * Production code loads ONLY the repository-owned addon from one deterministic
 * location: `native/build/<Configuration>/<Configuration>/winhelm_native.node`
 * relative to the package root, produced by the pinned
 * `scripts/build-native-boundary.ps1` with `-BuildRoot native/build`.
 *
 * There is deliberately no caller-controlled addon path, no addon search path,
 * no runtime download, and no silent fallback to weaker Node behavior: every
 * normative Tier A consumer receives a structured fail-closed error when the
 * trusted addon is absent or incompatible.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  WinHelmNativeBoundary,
} from "../../native/index.js";

export class NativeBoundaryUnavailableError extends Error {
  constructor(
    public readonly code:
      | "NATIVE_BOUNDARY_UNAVAILABLE"
      | "NATIVE_BOUNDARY_INCOMPATIBLE",
    message: string,
    public readonly details: Record<string, unknown>
  ) {
    super(message);
    this.name = "NativeBoundaryUnavailableError";
  }
}

function packageRoot(): string {
  // dist/native/boundary.js (built) or src/native/boundary.ts (tsx) both sit
  // two levels below the package root.
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".."
  );
}

export function trustedNativeAddonPath(
  configuration: "Release" | "Debug" = "Release"
): string {
  const root = packageRoot();
  return path.join(
    root,
    "native",
    "build",
    configuration,
    configuration,
    "winhelm_native.node"
  );
}

function validateAddonShape(value: unknown): WinHelmNativeBoundary {
  const addon = value as Partial<WinHelmNativeBoundary> | null | undefined;
  const missing: string[] = [];
  if (!addon || typeof addon !== "object") {
    throw new NativeBoundaryUnavailableError(
      "NATIVE_BOUNDARY_INCOMPATIBLE",
      "The trusted native addon did not export an object.",
      { addonPath: trustedNativeAddonPath() }
    );
  }
  for (const key of [
    "stableReadOpen",
    "createExclusive",
    "atomicReplace",
    "spawnContained",
  ] as const) {
    if (typeof addon[key] !== "function") missing.push(key);
  }
  if (addon.abi !== "node-api") missing.push("abi=node-api");
  if (addon.napiVersion !== 10) missing.push("napiVersion=10");
  if (missing.length > 0) {
    throw new NativeBoundaryUnavailableError(
      "NATIVE_BOUNDARY_INCOMPATIBLE",
      `The trusted native addon is incompatible: missing or invalid ${missing.join(", ")}.`,
      { addonPath: trustedNativeAddonPath(), missing }
    );
  }
  return addon as WinHelmNativeBoundary;
}

let cachedBoundary: WinHelmNativeBoundary | null = null;
let cachedFailure: NativeBoundaryUnavailableError | null = null;

/**
 * Load the trusted native boundary. Throws a structured
 * NativeBoundaryUnavailableError when it cannot be used; callers convert that
 * into the tool's structured fail-closed error. Never falls back to weaker
 * pure-Node behavior.
 */
export function getNativeBoundary(): WinHelmNativeBoundary {
  if (cachedBoundary) return cachedBoundary;
  if (cachedFailure) throw cachedFailure;

  const addonPath = trustedNativeAddonPath();
  if (!existsSync(addonPath)) {
    cachedFailure = new NativeBoundaryUnavailableError(
      "NATIVE_BOUNDARY_UNAVAILABLE",
      "The WinHelm native boundary addon is not built. Run " +
        "scripts/build-native-boundary.ps1 -BuildRoot native/build on the " +
        "qualified Windows target; normative native paths stay fail-closed.",
      { addonPath }
    );
    throw cachedFailure;
  }

  try {
    const require = createRequire(import.meta.url);
    cachedBoundary = validateAddonShape(require(addonPath));
    return cachedBoundary;
  } catch (err) {
    if (err instanceof NativeBoundaryUnavailableError) {
      cachedFailure = err;
      throw cachedFailure;
    }
    cachedFailure = new NativeBoundaryUnavailableError(
      "NATIVE_BOUNDARY_INCOMPATIBLE",
      `The trusted native addon could not be loaded: ${(err as Error).message}`,
      { addonPath }
    );
    throw cachedFailure;
  }
}

/** True when the trusted native boundary is loaded and validated. */
export function isNativeBoundaryAvailable(): boolean {
  try {
    getNativeBoundary();
    return true;
  } catch {
    return false;
  }
}

/** Test-only reset so injectable fixtures can reload the cached state. */
export function resetNativeBoundaryCache(): void {
  cachedBoundary = null;
  cachedFailure = null;
}
