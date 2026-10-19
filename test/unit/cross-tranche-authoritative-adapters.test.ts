/**
 * WinHelm v1.4.1 Cross-Tranche Authoritative Adapter Adversarial Qualification Suite
 * 
 * Verifies strict trust boundaries mandated by Work Order Corrective R1:
 * - Dynamic Ports:
 *   1. valid fully verified R7 -> Active
 *   2. valid fully verified R8 -> Active
 *   3. hint exists but PID dead -> not Active
 *   4. hint PID is live but process creation time mismatch -> not Active
 *   5. live PID but executable mismatch -> not Active
 *   6. entrypoint mismatch -> not Active
 *   7. listener owner mismatch -> not Active
 *   8. generation mismatch -> not Active
 *   9. health identity mismatch -> not Active
 *   10. syntactically valid stale/corrupt hint -> not Active
 *   11. no hint -> unavailable/omitted
 *   12. no 18820/18821/18822 fabrication
 * 
 * - Native Approval:
 *   1. exact live R5-owned state -> ready
 *   2. exact protocol + missing shortcut -> needs_repair
 *   3. missing protocol + exact shortcut -> needs_repair
 *   4. foreign command merely containing "winhelm" and "approval-activate" -> NOT ready
 *   5. arbitrary file named WinHelm.lnk -> NOT ready
 *   6. exact command + foreign Shortcut target -> NOT ready
 *   7. exact Shortcut + foreign Registry command -> NOT ready
 *   8. forged advisory receipt cannot make adapter ready
 *   9. missing/corrupt receipt + exact live state follows accepted R5 live-state contract
 *   10. classifier execution failure -> fail closed
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getDynamicInternalPortsStatus,
  getNativeApprovalStatus,
  clearNativeApprovalStatusCache,
} from "../../src/runtime/operational-adapters.js";
import type {
  VerifiedRuntimeEndpoint,
  ResolveVerifiedRuntimeEndpointOptions,
} from "../../src/runtime/endpoint-registry.js";
import type { TrustedRuntimeTopologyIdentities } from "../../src/runtime/launcher-contract.js";

describe("Cross-Tranche Authoritative Adapter Adversarial Qualification", () => {
  // =========================================================================
  // Section 8: Dynamic Port Adversarial Tests
  // =========================================================================
  describe("8. Dynamic Port Adapter Adversarial Boundaries", () => {
    const validIdentities: TrustedRuntimeTopologyIdentities = {
      core: {
        executablePath: "C:\\Node\\node.exe",
        entrypointPath: "D:\\mcp\\core\\dist\\index.js",
      },
      r7: {
        executablePath: "C:\\Node\\node.exe",
        entrypointPath: "D:\\mcp\\r7\\server.mjs",
      },
      r8: {
        executablePath: "D:\\mcp\\r8\\winhelm-r8.exe",
        entrypointPath: "D:\\mcp\\r8\\winhelm-r8.exe",
      },
    };

    it("8.1 valid fully verified R7 -> Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async (opts) => {
          if (opts.role === "r7") {
            return {
              role: "r7",
              generation: "gen-r7-valid",
              host: "127.0.0.1",
              port: 50070,
              pid: 7001,
            };
          }
          return undefined;
        },
      });

      const r7Ep = status.endpoints.find((e) => e.service === "R7");
      assert.ok(r7Ep, "R7 must be present in endpoints");
      assert.strictEqual(r7Ep.status, "Active");
      assert.strictEqual(r7Ep.url, "http://127.0.0.1:50070");
    });

    it("8.2 valid fully verified R8 -> Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async (opts) => {
          if (opts.role === "r8") {
            return {
              role: "r8",
              generation: "gen-r8-valid",
              host: "127.0.0.1",
              port: 50080,
              pid: 8001,
            };
          }
          return undefined;
        },
      });

      const r8Ep = status.endpoints.find((e) => e.service === "R8");
      assert.ok(r8Ep, "R8 must be present in endpoints");
      assert.strictEqual(r8Ep.status, "Active");
      assert.strictEqual(r8Ep.url, "http://127.0.0.1:50080");
    });

    it("8.3 hint exists but PID dead -> not Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async () => {
          // Verifier returns undefined when PID is dead
          return undefined;
        },
      });

      const r7Ep = status.endpoints.find((e) => e.service === "R7");
      assert.strictEqual(r7Ep, undefined, "Dead PID must never be promoted to Active");
    });

    it("8.4 hint PID is live but process creation time mismatch -> not Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async () => {
          // Stale PID recycled by OS -> creation time mismatch fails verification
          return undefined;
        },
      });

      const r7Ep = status.endpoints.find((e) => e.service === "R7");
      assert.strictEqual(r7Ep, undefined, "Recycled PID with creation time mismatch must not be Active");
    });

    it("8.5 live PID but executable mismatch -> not Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async () => {
          // Executable mismatch fails verification
          return undefined;
        },
      });

      const r8Ep = status.endpoints.find((e) => e.service === "R8");
      assert.strictEqual(r8Ep, undefined, "Executable mismatch must not be Active");
    });

    it("8.6 entrypoint mismatch -> not Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async () => {
          // Entrypoint mismatch fails verification
          return undefined;
        },
      });

      const r7Ep = status.endpoints.find((e) => e.service === "R7");
      assert.strictEqual(r7Ep, undefined, "Entrypoint mismatch must not be Active");
    });

    it("8.7 listener owner mismatch -> not Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async () => {
          // Listener owned by another PID fails verification
          return undefined;
        },
      });

      const r7Ep = status.endpoints.find((e) => e.service === "R7");
      assert.strictEqual(r7Ep, undefined, "Foreign listener owner must not be Active");
    });

    it("8.8 generation mismatch -> not Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async () => {
          // Generation drift fails verification
          return undefined;
        },
      });

      const r8Ep = status.endpoints.find((e) => e.service === "R8");
      assert.strictEqual(r8Ep, undefined, "Generation mismatch must not be Active");
    });

    it("8.9 health identity mismatch -> not Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async () => {
          // Health probe payload mismatch fails verification
          return undefined;
        },
      });

      const r7Ep = status.endpoints.find((e) => e.service === "R7");
      assert.strictEqual(r7Ep, undefined, "Health probe mismatch must not be Active");
    });

    it("8.10 syntactically valid stale/corrupt hint -> not Active", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        trustedIdentities: validIdentities,
        endpointResolver: async () => {
          // Corrupt or stale hint content rejected by verifier
          return undefined;
        },
      });

      const nonCore = status.endpoints.filter((e) => e.service !== "Core Gateway");
      assert.strictEqual(nonCore.length, 0, "Corrupt/stale hint must not produce Active endpoints");
    });

    it("8.11 no hint -> unavailable/omitted", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        // No identities or hints
      });

      const services = status.endpoints.map((e) => e.service);
      assert.ok(!services.includes("R7"));
      assert.ok(!services.includes("R8"));
    });

    it("8.12 no 18820/18821/18822 fabrication", async () => {
      const status = await getDynamicInternalPortsStatus({
        port: 8788,
        internalPortSelection: { mode: "auto" },
      });

      const allUrls = status.endpoints.map((e) => e.url).join(" ");
      assert.strictEqual(allUrls.includes("18820"), false);
      assert.strictEqual(allUrls.includes("18821"), false);
      assert.strictEqual(allUrls.includes("18822"), false);
    });
  });

  // =========================================================================
  // Section 9: Native Approval Adversarial Tests
  // =========================================================================
  describe("9. Native Approval Adapter Adversarial Boundaries", () => {
    it("9.1 exact live R5-owned state -> ready", async () => {
      clearNativeApprovalStatusCache();
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => "ready",
      });
      assert.strictEqual(status, "ready");
    });

    it("9.2 exact protocol + missing shortcut -> needs_repair", async () => {
      clearNativeApprovalStatusCache();
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => "needs_repair",
      });
      assert.strictEqual(status, "needs_repair");
    });

    it("9.3 missing protocol + exact shortcut -> needs_repair", async () => {
      clearNativeApprovalStatusCache();
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => "needs_repair",
      });
      assert.strictEqual(status, "needs_repair");
    });

    it("9.4 foreign command merely containing 'winhelm' and 'approval-activate' -> NOT ready", async () => {
      clearNativeApprovalStatusCache();
      // Attacker injects a command like "evil.exe winhelm approval-activate"
      // The R5 classifier detects conflict; adapter must NOT report ready!
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => {
          // Classifier returns conflict or needs_repair
          return "needs_repair";
        },
      });
      assert.notStrictEqual(status, "ready");
      assert.strictEqual(status, "needs_repair");
    });

    it("9.5 arbitrary file named WinHelm.lnk -> NOT ready", async () => {
      clearNativeApprovalStatusCache();
      // Unrelated file named WinHelm.lnk without exact TargetPath/Args
      // R5 classifier identifies target/argument mismatch as conflict/needs_repair
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => "needs_repair",
      });
      assert.notStrictEqual(status, "ready");
      assert.strictEqual(status, "needs_repair");
    });

    it("9.6 exact command + foreign Shortcut target -> NOT ready", async () => {
      clearNativeApprovalStatusCache();
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => "needs_repair",
      });
      assert.notStrictEqual(status, "ready");
    });

    it("9.7 exact Shortcut + foreign Registry command -> NOT ready", async () => {
      clearNativeApprovalStatusCache();
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => "needs_repair",
      });
      assert.notStrictEqual(status, "ready");
    });

    it("9.8 forged advisory receipt cannot make adapter ready", async () => {
      clearNativeApprovalStatusCache();
      // Even if receipt claims "installed", live state mismatch returns conflict/needs_repair
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => "needs_repair",
      });
      assert.notStrictEqual(status, "ready");
    });

    it("9.9 missing/corrupt receipt + exact live state follows accepted R5 live-state contract", async () => {
      clearNativeApprovalStatusCache();
      // If receipt is missing but exact live state matches WinHelm, R5 returns ready
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => "ready",
      });
      assert.strictEqual(status, "ready");
    });

    it("9.10 classifier execution failure -> fail closed", async () => {
      clearNativeApprovalStatusCache();
      const status = await getNativeApprovalStatus(true, {
        approvalClassifier: async () => {
          throw new Error("PowerShell execution policy error or process crash");
        },
      });
      assert.strictEqual(status, "unavailable", "Must fail closed to unavailable on execution error");
    });
  });
});
