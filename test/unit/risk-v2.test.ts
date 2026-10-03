import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_V13_TOOL_NAMES,
  RECOVERY_TOOL_NAMES,
} from "../../src/tools/registry.js";
import {
  getDesktopDataDisclosure,
  getToolRiskClass,
  getToolRiskPresentation,
  summarizeRuntimeRisk,
} from "../../src/permissions/risk.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";

describe("Approval risk presentation", () => {
  it("maps representative tools to Appendix A R0-R5 classes", () => {
    assert.strictEqual(getToolRiskClass("file_read"), "R0");
    assert.strictEqual(getToolRiskClass("file_write"), "R1");
    assert.strictEqual(getToolRiskClass("http_request"), "R2");
    assert.strictEqual(getToolRiskClass("screen_capture"), "R3");
    assert.strictEqual(getToolRiskClass("process_kill"), "R4");
    assert.strictEqual(getToolRiskClass("terminal_run"), "R5");
    assert.strictEqual(getToolRiskClass("command_run"), "R5");
  });

  it("treats both recovery tools as R0", () => {
    for (const name of RECOVERY_TOOL_NAMES) {
      assert.strictEqual(getToolRiskClass(name), "R0");
      assert.strictEqual(
        getToolRiskPresentation(name).level,
        "low"
      );
    }
  });

  it("classifies all 41 v1.3 tools without falling outside R0-R5", () => {
    const classes = new Set(["R0", "R1", "R2", "R3", "R4", "R5"]);
    for (const name of ALL_V13_TOOL_NAMES) {
      const risk = getToolRiskPresentation(name);
      assert.ok(classes.has(risk.class), name);
      assert.ok(risk.label.trim(), name + " label");
      assert.ok(risk.description.trim(), name + " description");
    }
  });

  it("describes desktop data returned to the AI explicitly", () => {
    assert.match(
      getDesktopDataDisclosure("screen_capture") ?? "",
      /screenshot.*returned to the AI/i
    );
    assert.match(
      getDesktopDataDisclosure("clipboard_get") ?? "",
      /clipboard text.*returned to the AI/i
    );
    assert.match(
      getDesktopDataDisclosure("clipboard_set") ?? "",
      /not returned/i
    );
    assert.strictEqual(
      getDesktopDataDisclosure("file_read"),
      undefined
    );
  });

  it("renders unknown tools fail-conservatively as R5/high", () => {
    const risk = getToolRiskPresentation("future_unknown_tool");
    assert.strictEqual(risk.class, "R5");
    assert.strictEqual(risk.level, "high");
  });

  it("summarizes automatic policy risk separately from terminal execution", () => {
    const safe = summarizeRuntimeRisk(
      buildPresetConfig("safe", { folders: ["D:\\Workspace"] })
    );
    assert.strictEqual(safe.maxAutoPolicyRisk, "R0");
    assert.strictEqual(safe.terminalExecution, "disabled");
    assert.strictEqual(safe.readwriteFolderCount, 0);
    assert.strictEqual(safe.totalFolderCount, 1);

    const balanced = summarizeRuntimeRisk(
      buildPresetConfig("balanced", { folders: ["D:\\Workspace"] })
    );
    assert.strictEqual(balanced.maxAutoPolicyRisk, "R1");
    assert.strictEqual(
      balanced.terminalExecution,
      "approval-required"
    );
    assert.strictEqual(balanced.readwriteFolderCount, 1);

    const power = summarizeRuntimeRisk(
      buildPresetConfig("power", { folders: ["D:\\Workspace"] })
    );
    assert.strictEqual(power.maxAutoPolicyRisk, "R2");
    assert.strictEqual(
      power.terminalExecution,
      "unrestricted-auto"
    );
    assert.ok(power.policyByRisk.R3.ask > 0);
    assert.ok(power.policyByRisk.R4.ask > 0);

    const dangerous = summarizeRuntimeRisk({
      ...buildPresetConfig("power", { folders: ["D:\\Workspace"] }),
      terminal: { mode: "dangerous", dangerousExpiresMinutes: 60 },
    });
    assert.strictEqual(
      dangerous.terminalExecution,
      "dangerous-blocked"
    );
  });
});
