import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ApprovalMode,
  SchemaV2PermissionConfig,
} from "../../src/config/schema-v2.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";
import { evaluateSchemaV2ToolAccess } from "../../src/permissions/tool-access.js";
import { evaluateApprovalMode } from "../../src/permissions/approval-model.js";
import { classifyToolMandatoryConfirmation } from "../../src/permissions/mandatory-confirmation.js";
import {
  adminMutationRequiresMandatoryConfirmation,
  isValidLocalConfirmation,
} from "../../src/permissions/admin-confirmation.js";
import { registerTracedTool } from "../../src/tools/tool-wrapper.js";
import {
  getApprovalEngine,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";

function withMode(
  config: SchemaV2PermissionConfig,
  mode: ApprovalMode
): SchemaV2PermissionConfig {
  return {
    ...config,
    approval: {
      ...config.approval,
      mode,
    },
  };
}

const representatives = {
  R0: ["system_info", {}] as const,
  R1: ["notification_send", { title: "test", message: "test" }] as const,
  R2: ["http_ping", { url: "https://example.com" }] as const,
  R3: ["clipboard_get", {}] as const,
  R4: ["service_control", { name: "Spooler", action: "restart" }] as const,
  R5: ["terminal_run", { command: "Write-Output test" }] as const,
};

function decision(
  config: SchemaV2PermissionConfig,
  entry: readonly [string, Record<string, unknown>]
): string {
  return evaluateSchemaV2ToolAccess(entry[0], { ...entry[1] }, config).decision;
}

describe("Approval Model v2 evaluator", () => {
  it("implements the 3 Profiles x 3 Approval Modes representative matrix", () => {
    const modes: ApprovalMode[] = ["manual", "smart", "trusted"];

    for (const mode of modes) {
      const safe = withMode(buildPresetConfig("safe"), mode);
      assert.strictEqual(decision(safe, representatives.R0), "allow", `safe/${mode}/R0`);
      assert.strictEqual(decision(safe, representatives.R1), "deny", `safe/${mode}/R1`);
      assert.strictEqual(decision(safe, representatives.R2), "deny", `safe/${mode}/R2`);
      assert.strictEqual(decision(safe, representatives.R3), "deny", `safe/${mode}/R3`);
      assert.strictEqual(decision(safe, representatives.R4), "deny", `safe/${mode}/R4`);
      assert.strictEqual(decision(safe, representatives.R5), "deny", `safe/${mode}/R5`);
    }

    const balancedManual = withMode(buildPresetConfig("balanced"), "manual");
    assert.strictEqual(decision(balancedManual, representatives.R0), "allow");
    assert.strictEqual(decision(balancedManual, representatives.R1), "ask");
    assert.strictEqual(decision(balancedManual, representatives.R2), "ask");
    assert.strictEqual(decision(balancedManual, representatives.R3), "ask");
    assert.strictEqual(decision(balancedManual, representatives.R4), "deny");
    assert.strictEqual(decision(balancedManual, representatives.R5), "ask");

    const balancedSmart = withMode(buildPresetConfig("balanced"), "smart");
    assert.strictEqual(decision(balancedSmart, representatives.R0), "allow");
    assert.strictEqual(decision(balancedSmart, representatives.R1), "allow");
    assert.strictEqual(decision(balancedSmart, representatives.R2), "ask");
    assert.strictEqual(decision(balancedSmart, representatives.R3), "ask");
    assert.strictEqual(decision(balancedSmart, representatives.R4), "deny");
    assert.strictEqual(decision(balancedSmart, representatives.R5), "ask");

    const balancedTrusted = withMode(buildPresetConfig("balanced"), "trusted");
    assert.strictEqual(decision(balancedTrusted, representatives.R0), "allow");
    assert.strictEqual(decision(balancedTrusted, representatives.R1), "allow");
    assert.strictEqual(decision(balancedTrusted, representatives.R2), "allow");
    assert.strictEqual(decision(balancedTrusted, representatives.R3), "allow");
    assert.strictEqual(decision(balancedTrusted, representatives.R4), "deny");
    assert.strictEqual(decision(balancedTrusted, representatives.R5), "allow");

    const powerManual = withMode(buildPresetConfig("power"), "manual");
    assert.strictEqual(decision(powerManual, representatives.R0), "allow");
    assert.strictEqual(decision(powerManual, representatives.R1), "ask");
    assert.strictEqual(decision(powerManual, representatives.R2), "ask");
    assert.strictEqual(decision(powerManual, representatives.R3), "ask");
    assert.strictEqual(decision(powerManual, representatives.R4), "ask");
    assert.strictEqual(decision(powerManual, representatives.R5), "ask");

    const powerSmart = withMode(buildPresetConfig("power"), "smart");
    assert.strictEqual(decision(powerSmart, representatives.R0), "allow");
    assert.strictEqual(decision(powerSmart, representatives.R1), "allow");
    assert.strictEqual(decision(powerSmart, representatives.R2), "ask");
    assert.strictEqual(decision(powerSmart, representatives.R3), "ask");
    assert.strictEqual(decision(powerSmart, representatives.R4), "ask");
    assert.strictEqual(decision(powerSmart, representatives.R5), "ask");

    const powerTrusted = withMode(buildPresetConfig("power"), "trusted");
    assert.strictEqual(decision(powerTrusted, representatives.R0), "allow");
    assert.strictEqual(decision(powerTrusted, representatives.R1), "allow");
    assert.strictEqual(decision(powerTrusted, representatives.R2), "allow");
    assert.strictEqual(decision(powerTrusted, representatives.R3), "allow");
    assert.strictEqual(decision(powerTrusted, representatives.R4), "ask");
    assert.strictEqual(decision(powerTrusted, representatives.R5), "allow");
  });

  it("preserves legacy v1.3 behavior when approval.mode is absent", () => {
    const config = buildPresetConfig("power");
    delete config.approval.mode;

    config.toolPolicy.http_ping = "auto";
    config.toolPolicy.clipboard_get = "ask";
    config.terminal.mode = "ask";

    assert.strictEqual(decision(config, representatives.R2), "allow");
    assert.strictEqual(decision(config, representatives.R3), "ask");
    assert.strictEqual(decision(config, representatives.R5), "ask");
  });

  it("keeps explicit tool and terminal confirmation floors in Trusted", () => {
    const config = withMode(buildPresetConfig("power"), "trusted");
    config.toolPolicy.notification_send = "ask";
    config.terminal.mode = "ask";

    assert.strictEqual(decision(config, representatives.R1), "ask");
    assert.strictEqual(decision(config, representatives.R5), "ask");
  });

  it("keeps Safe + Trusted read-only", () => {
    const config = withMode(buildPresetConfig("safe"), "trusted");
    assert.strictEqual(decision(config, representatives.R0), "allow");
    assert.strictEqual(
      decision(config, ["terminal_task_list", {}]),
      "allow"
    );
    assert.strictEqual(decision(config, representatives.R1), "deny");
    assert.strictEqual(decision(config, representatives.R5), "deny");
  });

  it("keeps Power + Trusted service mutation under Mandatory Confirmation", () => {
    const config = withMode(buildPresetConfig("power"), "trusted");
    const result = evaluateSchemaV2ToolAccess(
      "service_control",
      { name: "Spooler", action: "restart" },
      config
    );
    assert.strictEqual(result.decision, "ask");
    assert.strictEqual(result.code, "APPROVAL_REQUIRED");
  });

  it("distinguishes owned process termination from external Mandatory Confirmation", () => {
    const owned = {
      ownsRunningPid(pid: number) {
        return pid === 4242;
      },
    };

    const ownedResult = classifyToolMandatoryConfirmation(
      "process_kill",
      { pid: 4242 },
      owned,
      "trusted"
    );
    assert.strictEqual(ownedResult.required, false);

    const external = classifyToolMandatoryConfirmation(
      "process_kill",
      { pid: 9999 },
      owned,
      "trusted"
    );
    assert.strictEqual(external.required, true);
    assert.strictEqual(external.code, "EXTERNAL_PROCESS_TERMINATION");

    const byName = classifyToolMandatoryConfirmation(
      "process_kill",
      { name: "node" },
      owned,
      "trusted"
    );
    assert.strictEqual(byName.required, true);
  });

  it("makes the safe command adapter Manual=ask, Smart/Trusted=allow", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-approval-safe-"));
    try {
      for (const [mode, expected] of [
        ["manual", "ask"],
        ["smart", "allow"],
        ["trusted", "allow"],
      ] as const) {
        const config = withMode(buildPresetConfig("balanced", { folders: [root] }), mode);
        config.terminal.mode = "safe";
        const result = evaluateSchemaV2ToolAccess(
          "command_run",
          { command: "npm", args: ["--version"], cwd: root },
          config
        );
        assert.strictEqual(result.decision, expected, mode);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never creates an approval job for an Absolute Deny", async () => {
    resetApprovalEngine();
    const manager = ConfigManager.resetInstance();
    const config = withMode(buildPresetConfig("safe"), "trusted");
    await manager.updateConfig(config, false);

    let registered: any;
    let executions = 0;
    const server = {
      registerTool(name: string, toolConfig: any, handler: any) {
        registered = { name, toolConfig, handler };
      },
    };

    try {
      registerTracedTool(
        server as any,
        "notification_send",
        {},
        async () => {
          executions += 1;
          return { content: [{ type: "text", text: "unexpected" }] };
        }
      );

      const result = await registered.handler(
        { title: "x", message: "x" },
        { sessionId: "absolute-deny-session", requestId: 901 }
      );

      assert.strictEqual(executions, 0);
      assert.strictEqual(result.isError, true);
      assert.deepStrictEqual(getApprovalEngine().list(), []);
    } finally {
      resetApprovalEngine();
      ConfigManager.resetInstance();
    }
  });

  it("classifies every admin security-floor mutation as mandatory confirmation", () => {
    for (const kind of [
      "authority-expansion",
      "credential-security-mutation",
      "network-exposure-expansion",
      "approval-prompt-reduction",
    ] as const) {
      assert.strictEqual(
        adminMutationRequiresMandatoryConfirmation(kind),
        true,
        kind
      );
    }

    assert.strictEqual(isValidLocalConfirmation("confirm"), true);
    assert.strictEqual(isValidLocalConfirmation(" ยืนยัน "), true);
    assert.strictEqual(isValidLocalConfirmation("yes"), false);
  });

  it("keeps product profiles as hard capability ceilings even after manual policy edits", () => {
    const safe = withMode(buildPresetConfig("safe"), "trusted");
    safe.toolPolicy.notification_send = "auto";
    safe.terminal.mode = "full";
    assert.strictEqual(decision(safe, representatives.R1), "deny");
    assert.strictEqual(decision(safe, representatives.R5), "deny");

    const balanced = withMode(buildPresetConfig("balanced"), "trusted");
    balanced.toolPolicy.service_control = "auto";
    balanced.toolPolicy.process_kill = "auto";
    assert.strictEqual(decision(balanced, representatives.R4), "deny");
    assert.strictEqual(
      evaluateSchemaV2ToolAccess("process_kill", { pid: 4242 }, balanced)
        .decision,
      "deny"
    );

    const power = withMode(buildPresetConfig("power"), "trusted");
    power.toolPolicy.service_control = "auto";
    assert.strictEqual(decision(power, representatives.R4), "ask");
  });

  it("fails closed for an explicitly enabled but unclassified future tool", () => {
    const config = withMode(buildPresetConfig("power"), "trusted");
    config.toolPolicy.future_host_mutator = "auto";
    const result = evaluateSchemaV2ToolAccess(
      "future_host_mutator",
      {},
      config
    );
    assert.strictEqual(result.decision, "deny");
    assert.strictEqual(result.code, "RISK_CLASSIFICATION_REQUIRED");
  });

  it("keeps the pure mode evaluator independent from capability grants", () => {
    const trusted = evaluateApprovalMode("http_ping", "trusted");
    assert.strictEqual(trusted.decision, "allow");

    const floored = evaluateApprovalMode("http_ping", "trusted", {
      explicitConfirmationFloor: true,
    });
    assert.strictEqual(floored.decision, "ask");

    const mandatory = evaluateApprovalMode("service_control", "trusted", {
      mandatoryConfirmation: true,
    });
    assert.strictEqual(mandatory.decision, "ask");
  });
});
