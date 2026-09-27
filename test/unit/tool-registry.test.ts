import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALL_TOOL_NAMES } from "../../src/tools/registry.js";
import { PROFILES } from "../../src/config/profiles.js";

test("Canonical Tool Registry & Documentation Integrity", async (t) => {
  await t.test("should define exactly 38 tools in TOOL_NAMES", () => {
    assert.equal(ALL_TOOL_NAMES.length, 38);
    const uniqueTools = new Set(ALL_TOOL_NAMES);
    assert.equal(uniqueTools.size, 38, "All tool names must be unique");
  });

  await t.test("should match exact tool counts in all profiles", () => {
    assert.equal(PROFILES.core.tools.length, 15, "Core profile must have exactly 15 tools");
    assert.equal(PROFILES.dev.tools.length, 28, "Dev profile must have exactly 28 tools");
    assert.equal(PROFILES.sysadmin.tools.length, 37, "Sysadmin profile must have exactly 37 tools");
    assert.equal(PROFILES.full.tools.length, 38, "Full profile must have exactly 38 tools");
  });

  await t.test("should ensure every profile tool is declared in ALL_TOOL_NAMES", () => {
    const registrySet = new Set(ALL_TOOL_NAMES);
    for (const [profileName, def] of Object.entries(PROFILES)) {
      for (const tool of def.tools) {
        assert.ok(
          registrySet.has(tool as any),
          `Tool '${tool}' in profile '${profileName}' must exist in TOOL_NAMES registry`
        );
      }
    }
  });

  await t.test("should verify docs/TOOLS.md documents all 38 tools and no phantom tools", () => {
    const toolsDocPath = path.resolve("docs/TOOLS.md");
    assert.ok(fs.existsSync(toolsDocPath), "docs/TOOLS.md must exist");
    const docContent = fs.readFileSync(toolsDocPath, "utf-8");

    // Every tool in registry must have a section header: ### `tool_name`
    for (const tool of ALL_TOOL_NAMES) {
      assert.ok(
        docContent.includes(`### \`${tool}\``),
        `docs/TOOLS.md must contain section header for canonical tool: ### \`${tool}\``
      );
    }

    // Phantom tools must NOT have a section header in docs/TOOLS.md
    const phantomTools = [
      "terminal_task_status",
      "terminal_task_input",
      "terminal_task_stop",
      "file_archive_zip",
      "file_extract_zip",
      "file_recycle_bin",
      "ripgrep_search",
      "windows_service_list",
      "windows_service_action",
      "app_launch",
      "clipboard_read",
      "clipboard_write",
      "system_monitor",
      "log_export",
      "config_view",
      "config_reload",
    ];

    for (const phantom of phantomTools) {
      assert.ok(
        !docContent.includes(`### \`${phantom}\``),
        `docs/TOOLS.md must NOT contain phantom tool section: ### \`${phantom}\``
      );
    }
  });
});
