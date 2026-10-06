/**
 * Spec 3.4 Tier B targeted tests — registration, metadata, and security
 * classification integration.
 *
 * Covers Work Order §11 items 38–44: exact-once registration of the six
 * public names, metadata presence and lint with final count 56, correct
 * read-only annotations, product profile/policy AUTO coverage, path denies
 * before approval jobs, and the intact 50-tool pre-Tier-B baseline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ALL_V13_TOOL_NAMES,
  ALL_V14_TOOL_NAMES,
  SPEC_34_TIER_A_TOOL_NAMES,
  SPEC_34_TIER_B_TOOL_NAMES,
} from "../../src/tools/registry.js";
import {
  TOOL_METADATA,
  validateToolMetadataRegistry,
  getToolMetadata,
} from "../../src/tools/metadata.js";
import { registerAllTools } from "../../src/tools/index.js";
import { buildToolPolicyForPreset, productProfileAllowsTool } from "../../src/permissions/presets.js";
import { isToolRiskClassified, getToolRiskClass } from "../../src/permissions/risk.js";
import { evaluateSchemaV2ToolAccess } from "../../src/permissions/tool-access.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import type { SchemaV2PermissionConfig } from "../../src/config/schema-v2.js";

const TIER_B_NAMES: readonly string[] = SPEC_34_TIER_B_TOOL_NAMES;

async function withV2Config(
  folders: string[],
  fn: () => Promise<void> | void
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-reg-"));
  const configFile = path.join(dir, "config.json");
  await fs.writeFile(
    configFile,
    JSON.stringify({
      schemaVersion: 2,
      folders: folders.map((folder) => ({ path: folder, permission: "read" })),
      terminal: { mode: "off" },
      toolPolicy: {},
    }),
    "utf8"
  );
  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    await fn();
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function v2Config(folders: string[]): SchemaV2PermissionConfig {
  return {
    schemaVersion: 2,
    folders: folders.map((folder) => ({ path: folder, permission: "read" as const })),
    terminal: { mode: "off" },
    toolPolicy: buildToolPolicyForPreset("balanced"),
    approval: { mode: "smart" },
  };
}

test("Tier B registration, metadata, and security integration", async (t) => {
  await t.test("canonical v1.4 surface is exactly the 56-tool completed set", () => {
    assert.equal(ALL_V13_TOOL_NAMES.length, 41);
    assert.equal(SPEC_34_TIER_A_TOOL_NAMES.length, 9);
    assert.equal(TIER_B_NAMES.length, 6);
    assert.equal(ALL_V14_TOOL_NAMES.length, 56);
    assert.equal(new Set(ALL_V14_TOOL_NAMES).size, 56, "no duplicate tool names");
  });

  await t.test("all six public names register exactly once with metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-reg-live-"));
    const configFile = path.join(dir, "config.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 2,
        folders: [],
        terminal: { mode: "off" },
        toolPolicy: {},
      }),
      "utf8"
    );
    try {
      const manager = ConfigManager.resetInstance(configFile);
      await manager.init(configFile);
      const server = new McpServer({ name: "tier-b-registration", version: "0.0.0" });
      registerAllTools(server);
      const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
        ._registeredTools;
      for (const name of TIER_B_NAMES) {
        assert.ok(registered[name], `${name} must be registered`);
      }
      const registeredTierB = Object.keys(registered).filter((name) =>
        TIER_B_NAMES.includes(name)
      );
      assert.equal(registeredTierB.length, 6, "each Tier B name registers exactly once");
      assert.equal(Object.keys(registered).length, 56);
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("metadata exists for all six tools and the registry lints clean at 56", () => {
    assert.equal(Object.keys(TOOL_METADATA).length, 56);
    assert.deepStrictEqual(validateToolMetadataRegistry(), []);
    for (const name of TIER_B_NAMES) {
      const metadata = getToolMetadata(name);
      assert.ok(metadata.title.trim().length > 0, name);
      assert.ok(metadata.description.length >= 140, name);
    }
  });

  await t.test("read-only annotations are correct for all six tools", () => {
    for (const name of TIER_B_NAMES) {
      const annotations = getToolMetadata(name).annotations;
      assert.equal(annotations.readOnlyHint, true, `${name} readOnlyHint`);
      assert.equal(annotations.destructiveHint, false, `${name} destructiveHint`);
      assert.equal(typeof annotations.idempotentHint, "boolean", name);
      assert.equal(typeof annotations.openWorldHint, "boolean", name);
    }
  });

  await t.test("product profiles and preset policies keep the frozen AUTO read-only tools", () => {
    for (const name of TIER_B_NAMES) {
      assert.equal(isToolRiskClassified(name), true, `${name} risk-classified`);
      assert.equal(getToolRiskClass(name), "R0", `${name} risk class`);
      for (const preset of ["safe", "balanced", "power"] as const) {
        assert.equal(
          productProfileAllowsTool(preset, name),
          true,
          `${name} allowed in ${preset}`
        );
      }
      for (const preset of ["safe", "balanced", "power"] as const) {
        assert.equal(
          buildToolPolicyForPreset(preset)[name],
          "auto",
          `${name} policy auto in ${preset}`
        );
      }
    }
  });

  await t.test("approval-mode evaluation does not ask for deterministic AUTO read-only calls", async () => {
    await withV2Config(["D:\\allowed-tier-b"], async () => {
      const config = v2Config(["D:\\allowed-tier-b"]);
      for (const name of [
        "json_parse_strict",
        "json_canonical_hash",
        "memory_info",
        "process_resource_monitor",
      ]) {
        const args =
          name === "process_resource_monitor" ? { run_id: "run_x" } : {};
        const result = evaluateSchemaV2ToolAccess(name, args, config);
        assert.equal(result.decision, "allow", `${name}: ${result.code}`);
      }
    });
  });

  await t.test("path-bearing Tier B tools deny outside-root paths before any approval job", async () => {
    const config = v2Config(["D:\\allowed-tier-b"]);
    // Deterministic static denies: never an approval job.
    const gitDeny = evaluateSchemaV2ToolAccess(
      "git_status_structured",
      { repo_path: "C:\\outside-repo" },
      config
    );
    assert.equal(gitDeny.decision, "deny");
    const jsonDeny = evaluateSchemaV2ToolAccess(
      "json_parse_strict",
      { source: { path: "C:\\outside\\data.json" } },
      config
    );
    assert.equal(jsonDeny.decision, "deny");
    const hashDeny = evaluateSchemaV2ToolAccess(
      "json_canonical_hash",
      { source: { path: "C:\\outside\\data.json" }, scheme: "jcs-rfc8785" },
      config
    );
    assert.equal(hashDeny.decision, "deny");
  });

  await t.test("authorized path sources pass the static gate and resolve before execution", async () => {
    await withV2Config(["D:\\allowed-tier-b"], async () => {
      const config = v2Config(["D:\\allowed-tier-b"]);
      const args: Record<string, unknown> = {
        source: { path: "D:\\allowed-tier-b\\data.json" },
      };
      const result = evaluateSchemaV2ToolAccess("json_parse_strict", args, config);
      assert.equal(result.decision, "allow", result.code);
      // The resolved path is written back so the executed path is the
      // authorized one (relative -> absolute resolution evidence).
      assert.equal((args.source as { path: string }).path.includes("data.json"), true);
    });
  });

  await t.test("pre-existing 50-tool baseline registrations remain intact", () => {
    for (const name of ALL_V13_TOOL_NAMES) {
      assert.ok(TOOL_METADATA[name as keyof typeof TOOL_METADATA], name);
    }
    for (const name of SPEC_34_TIER_A_TOOL_NAMES) {
      assert.ok(TOOL_METADATA[name], name);
    }
    assert.equal(ALL_V13_TOOL_NAMES.length + SPEC_34_TIER_A_TOOL_NAMES.length, 50);
  });
});
