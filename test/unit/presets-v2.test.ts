import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROFILES } from "../../src/config/profiles.js";
import {
  R0_TOOLS,
  R1_TOOLS,
  R2_TOOLS,
  R3_TOOLS,
  R4_TOOLS,
  R5_TOOLS,
  buildPresetConfig,
  buildToolPolicyForPreset,
} from "../../src/permissions/presets.js";
import { ALL_TOOL_NAMES } from "../../src/tools/registry.js";

function countPolicy(policy: Record<string, string>, value: string): number {
  return Object.values(policy).filter((entry) => entry === value).length;
}

describe("Schema-v2 product preset mapping", () => {
  it("keeps the current 38-tool risk classes complete and disjoint", () => {
    const classified = [
      ...R0_TOOLS,
      ...R1_TOOLS,
      ...R2_TOOLS,
      ...R3_TOOLS,
      ...R4_TOOLS,
      ...R5_TOOLS,
    ];

    assert.strictEqual(classified.length, 38);
    assert.strictEqual(new Set(classified).size, 38);
    assert.deepStrictEqual(
      [...new Set(classified)].sort(),
      [...ALL_TOOL_NAMES].sort()
    );
  });

  it("builds Safe according to Appendix A", () => {
    const policy = buildToolPolicyForPreset("safe");

    assert.strictEqual(policy.file_read, "auto");
    assert.strictEqual(policy.system_info, "auto");
    assert.strictEqual(policy.terminal_task_list, "off");
    assert.strictEqual(policy.file_write, "off");
    assert.strictEqual(policy.http_request, "off");
    assert.strictEqual(policy.screen_capture, "off");
    assert.strictEqual(policy.process_kill, "off");

    // Current 34 policy-controlled tools + 2 future recovery tools.
    assert.strictEqual(countPolicy(policy, "auto"), 17);
    assert.strictEqual(countPolicy(policy, "ask"), 0);
    assert.strictEqual(countPolicy(policy, "off"), 19);

    const config = buildPresetConfig("safe", {
      folders: ["D:\\Workspace"],
      now: "2026-10-03T00:00:00.000Z",
    });
    assert.strictEqual(config.terminal.mode, "off");
    assert.deepStrictEqual(config.folders, [
      { path: "D:\\Workspace", permission: "read" },
    ]);
  });

  it("builds Balanced according to Appendix A", () => {
    const policy = buildToolPolicyForPreset("balanced");

    assert.strictEqual(policy.file_read, "auto");
    assert.strictEqual(policy.file_write, "auto");
    assert.strictEqual(policy.http_request, "ask");
    assert.strictEqual(policy.screen_capture, "ask");
    assert.strictEqual(policy.process_kill, "ask");

    assert.strictEqual(countPolicy(policy, "auto"), 28);
    assert.strictEqual(countPolicy(policy, "ask"), 8);
    assert.strictEqual(countPolicy(policy, "off"), 0);

    const config = buildPresetConfig("balanced", {
      folders: ["D:\\Workspace"],
      now: "2026-10-03T00:00:00.000Z",
    });
    assert.strictEqual(config.terminal.mode, "ask");
    assert.deepStrictEqual(config.folders, [
      { path: "D:\\Workspace", permission: "readwrite" },
    ]);
  });

  it("builds Power according to Appendix A", () => {
    const policy = buildToolPolicyForPreset("power");

    assert.strictEqual(policy.file_write, "auto");
    assert.strictEqual(policy.http_request, "auto");
    assert.strictEqual(policy.clipboard_get, "ask");
    assert.strictEqual(policy.service_control, "ask");

    assert.strictEqual(countPolicy(policy, "auto"), 30);
    assert.strictEqual(countPolicy(policy, "ask"), 6);
    assert.strictEqual(countPolicy(policy, "off"), 0);

    assert.strictEqual(buildPresetConfig("power").terminal.mode, "full");
  });

  it("stores an authoritative appliedSnapshot separate from mutable current fields", () => {
    const config = buildPresetConfig("balanced", {
      folders: ["D:\\Workspace"],
      now: "2026-10-03T00:00:00.000Z",
    });

    assert.ok(config.profileState);
    assert.notStrictEqual(config.profileState!.appliedSnapshot.folders, config.folders);
    assert.notStrictEqual(config.profileState!.appliedSnapshot.toolPolicy, config.toolPolicy);

    config.folders[0].permission = "read";
    config.toolPolicy.http_request = "off";

    assert.strictEqual(
      config.profileState!.appliedSnapshot.folders[0].permission,
      "readwrite"
    );
    assert.strictEqual(
      config.profileState!.appliedSnapshot.toolPolicy.http_request,
      "ask"
    );
  });
});

describe("Schema-v2 legacy-named preset mapping", () => {
  for (const preset of ["minimal", "core", "dev", "sysadmin", "full"] as const) {
    it(`derives ${preset} policy from canonical v1.2.1 membership`, () => {
      const policy = buildToolPolicyForPreset(preset);
      const membership = new Set(PROFILES[preset].tools);

      for (const tool of ALL_TOOL_NAMES) {
        if (R5_TOOLS.has(tool)) continue;

        if (!membership.has(tool)) {
          assert.strictEqual(policy[tool], "off", `${preset}: ${tool} should be off`);
          continue;
        }

        const expected =
          R2_TOOLS.has(tool) || R3_TOOLS.has(tool) || R4_TOOLS.has(tool)
            ? "ask"
            : "auto";
        assert.strictEqual(
          policy[tool],
          expected,
          `${preset}: unexpected policy for ${tool}`
        );
      }
    });
  }

  it("uses ask terminal for minimal/core/dev/sysadmin and full terminal for full", () => {
    for (const preset of ["minimal", "core", "dev", "sysadmin"] as const) {
      assert.strictEqual(buildPresetConfig(preset).terminal.mode, "ask");
    }
    assert.strictEqual(buildPresetConfig("full").terminal.mode, "full");
  });

  it("preserves canonical legacy profile membership counts", () => {
    assert.strictEqual(PROFILES.minimal.tools.length, 6);
    assert.strictEqual(PROFILES.core.tools.length, 15);
    assert.strictEqual(PROFILES.dev.tools.length, 28);
    assert.strictEqual(PROFILES.sysadmin.tools.length, 37);
    assert.strictEqual(PROFILES.full.tools.length, 38);
  });
});
