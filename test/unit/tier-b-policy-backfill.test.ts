import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  validateSchemaV2Config,
  validatePolicyCoverage,
  type SchemaV2PermissionConfig,
} from "../../src/config/schema-v2.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../src/tools/index.js";
import {
  ALL_V14_TOOL_NAMES,
  SPEC_34_TIER_B_TOOL_NAMES,
} from "../../src/tools/registry.js";
import {
  buildToolPolicyForPreset,
  productProfileAllowsTool,
  R0_TOOLS,
} from "../../src/permissions/presets.js";
import { evaluateSchemaV2ToolAccess } from "../../src/permissions/tool-access.js";
import { buildRuntimeStatusSnapshot } from "../../src/status/runtime-status.js";
import {
  inspectPolicyCoverage,
  normalizeToolPolicyCoverage,
  normalizeToolPolicyCoverageWithReport,
} from "../../src/permissions/policy-coverage.js";
import { evaluateToolPolicy } from "../../src/permissions/policy.js";

describe("Work Order D2 — Tier-B Policy Coverage & Persisted-Config Backfill Corrective", () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    ConfigManager.resetInstance();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      tempRoot = null;
    }
  });

  function createPreTierBPolicy(): Record<string, "auto" | "ask" | "off"> {
    const policy: Record<string, "auto" | "ask" | "off"> = {};
    const excluded = new Set<string>([
      ...SPEC_34_TIER_B_TOOL_NAMES,
      "command_run",
      "terminal_run",
      "terminal_task_start",
      "terminal_task_send",
      "terminal_task_kill",
    ]);

    for (const tool of ALL_V14_TOOL_NAMES) {
      if (!excluded.has(tool)) {
        policy[tool] = "auto";
      }
    }
    return policy;
  }

  it("1. Defect reproduction: un-normalized config evaluates missing Tier-B policy as POLICY_OFF", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-defect-"));
    const preTierBPolicy = createPreTierBPolicy();

    // Verify 6 Tier-B tools are completely omitted
    for (const tool of SPEC_34_TIER_B_TOOL_NAMES) {
      assert.strictEqual(tool in preTierBPolicy, false, `${tool} must be absent from pre-Tier-B policy`);
    }

    const unnormalizedConfig: SchemaV2PermissionConfig = {
      schemaVersion: 2,
      profilePreset: "balanced",
      folders: [{ path: tempRoot, permission: "readwrite" }],
      terminal: { mode: "full" },
      toolPolicy: preTierBPolicy,
      approval: { channels: ["dashboard", "toast"], blockHoldMs: 60000, jobTtlMs: 180000, maxPending: 5 },
      network: { allowLoopback: false },
    };

    // Before normalization, evaluateToolPolicy on un-normalized policy returns POLICY_OFF
    for (const tool of SPEC_34_TIER_B_TOOL_NAMES) {
      assert.strictEqual(unnormalizedConfig.toolPolicy[tool], undefined);
      const evalPolicy = evaluateToolPolicy(unnormalizedConfig.toolPolicy[tool]);
      assert.strictEqual(evalPolicy.decision, "deny");
      assert.strictEqual(evalPolicy.code, "POLICY_OFF");
      assert.strictEqual(evalPolicy.reason, "Tool policy is disabled or missing.");

      const result = evaluateSchemaV2ToolAccess(tool, {}, unnormalizedConfig);
      assert.strictEqual(result.decision, "deny", `${tool} evaluated against un-normalized config must deny`);
      assert.strictEqual(result.code, "POLICY_OFF", `${tool} missing key must result in POLICY_OFF`);
      assert.strictEqual(result.reason, "Tool policy is disabled or missing.");
    }

    // Product presets intend AUTO for Tier B across safe, balanced, and power
    for (const preset of ["safe", "balanced", "power"] as const) {
      const presetPolicy = buildToolPolicyForPreset(preset);
      for (const tool of SPEC_34_TIER_B_TOOL_NAMES) {
        assert.ok(R0_TOOLS.has(tool));
        assert.strictEqual(productProfileAllowsTool(preset, tool), true);
        assert.strictEqual(presetPolicy[tool], "auto");
      }
    }
  });

  it("2. Safe persisted config missing Tier B -> six entries backfilled auto, R1-R4 remain off", () => {
    const rawPolicy = createPreTierBPolicy();
    const config = {
      schemaVersion: 2,
      profilePreset: "safe",
      folders: [{ path: "D:\\SafeWork", permission: "read" as const }],
      terminal: { mode: "off" as const },
      toolPolicy: rawPolicy,
    };

    const validation = validateSchemaV2Config(config);
    assert.strictEqual(validation.valid, true);

    const normalizedPolicy = validation.value.toolPolicy;
    for (const tool of SPEC_34_TIER_B_TOOL_NAMES) {
      assert.strictEqual(normalizedPolicy[tool], "auto", `Tier-B ${tool} must be backfilled to auto in safe`);
    }

    // In Safe, file_write (R1), http_request (R2), screen_capture (R3), process_kill (R4) must remain off
    const safePreset = buildToolPolicyForPreset("safe");
    assert.strictEqual(safePreset.file_write, "off");
    assert.strictEqual(safePreset.http_request, "off");
    assert.strictEqual(safePreset.screen_capture, "off");
    assert.strictEqual(safePreset.process_kill, "off");
  });

  it("3. Balanced persisted config missing Tier B -> six entries backfilled auto", () => {
    const rawPolicy = createPreTierBPolicy();
    const config = {
      schemaVersion: 2,
      profilePreset: "balanced",
      folders: [{ path: "D:\\BalancedWork", permission: "readwrite" as const }],
      terminal: { mode: "full" as const },
      toolPolicy: rawPolicy,
    };

    const validation = validateSchemaV2Config(config);
    assert.strictEqual(validation.valid, true);

    const normalizedPolicy = validation.value.toolPolicy;
    for (const tool of SPEC_34_TIER_B_TOOL_NAMES) {
      assert.strictEqual(normalizedPolicy[tool], "auto", `Tier-B ${tool} must be backfilled to auto in balanced`);
    }
    assert.strictEqual(validation.policyCoverage?.status, "backfilled");
    assert.strictEqual(validation.policyCoverage?.missing_policy_tools.length, 0);
  });

  it("4. Power persisted config missing Tier B -> six entries backfilled auto", () => {
    const rawPolicy = createPreTierBPolicy();
    const config = {
      schemaVersion: 2,
      profilePreset: "power",
      folders: [{ path: "D:\\PowerWork", permission: "readwrite" as const }],
      terminal: { mode: "full" as const },
      toolPolicy: rawPolicy,
    };

    const validation = validateSchemaV2Config(config);
    assert.strictEqual(validation.valid, true);

    const normalizedPolicy = validation.value.toolPolicy;
    for (const tool of SPEC_34_TIER_B_TOOL_NAMES) {
      assert.strictEqual(normalizedPolicy[tool], "auto", `Tier-B ${tool} must be backfilled to auto in power`);
    }
  });

  it("5. Explicit off Tier-B entry remains off (Rule 1 & 3: preserved)", () => {
    const rawPolicy = createPreTierBPolicy();
    // Explicitly set one Tier-B tool to "off"
    rawPolicy.memory_info = "off";
    rawPolicy.git_status_structured = "off";

    const config = {
      schemaVersion: 2,
      profilePreset: "power",
      folders: [{ path: "D:\\PowerWork", permission: "readwrite" as const }],
      terminal: { mode: "full" as const },
      toolPolicy: rawPolicy,
    };

    const validation = validateSchemaV2Config(config);
    assert.strictEqual(validation.valid, true);

    const normalizedPolicy = validation.value.toolPolicy;
    assert.strictEqual(normalizedPolicy.memory_info, "off", "explicit off MUST remain off");
    assert.strictEqual(normalizedPolicy.git_status_structured, "off", "explicit off MUST remain off");
    // Other omitted Tier-B tools are backfilled to auto
    assert.strictEqual(normalizedPolicy.json_parse_strict, "auto");
    assert.strictEqual(normalizedPolicy.json_canonical_hash, "auto");
  });

  it("6. Explicit ask Tier-B entry remains ask (Rule 1: preserved)", () => {
    const rawPolicy = createPreTierBPolicy();
    rawPolicy.process_resource_monitor = "ask";

    const config = {
      schemaVersion: 2,
      profilePreset: "balanced",
      folders: [{ path: "D:\\BalancedWork", permission: "readwrite" as const }],
      terminal: { mode: "full" as const },
      toolPolicy: rawPolicy,
    };

    const validation = validateSchemaV2Config(config);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.value.toolPolicy.process_resource_monitor, "ask", "explicit ask MUST remain ask");
  });

  it("7. Legacy/unknown profile missing entries remain fail-closed", () => {
    // A. Legacy named preset (minimal): Tier B tools were not in v1.2.1 minimal profile -> backfilled to "off"
    const rawPolicy = createPreTierBPolicy();
    const minimalConfig = {
      schemaVersion: 2,
      profilePreset: "minimal",
      folders: [{ path: "D:\\MinimalWork", permission: "readwrite" as const }],
      terminal: { mode: "ask" as const },
      toolPolicy: rawPolicy,
    };

    const minimalValidation = validateSchemaV2Config(minimalConfig);
    assert.strictEqual(minimalValidation.valid, true);
    for (const tool of SPEC_34_TIER_B_TOOL_NAMES) {
      assert.strictEqual(minimalValidation.value.toolPolicy[tool], "off", `${tool} in legacy minimal must be off`);
    }

    // B. Unknown profile preset (omitted profilePreset) -> cannot synthesize authority
    const unclassifiedConfig = {
      schemaVersion: 2,
      folders: [{ path: "D:\\Work", permission: "readwrite" as const }],
      terminal: { mode: "off" as const },
      toolPolicy: { file_read: "auto" as const },
    };

    const coverage = inspectPolicyCoverage(unclassifiedConfig);
    assert.strictEqual(coverage.status, "incomplete");
    assert.ok(coverage.missing_policy_tools.length > 0);
    for (const tool of SPEC_34_TIER_B_TOOL_NAMES) {
      assert.ok(coverage.missing_policy_tools.includes(tool));
    }
  });

  it("8. Repeated normalization is idempotent (Rule 6)", () => {
    const rawPolicy = createPreTierBPolicy();
    const config = {
      schemaVersion: 2,
      profilePreset: "balanced" as const,
      folders: [{ path: "D:\\Work", permission: "readwrite" as const }],
      terminal: { mode: "full" as const },
      toolPolicy: rawPolicy,
    };

    const once = normalizeToolPolicyCoverage(config);
    const twice = normalizeToolPolicyCoverage(once);
    const thrice = normalizeToolPolicyCoverage(twice);

    assert.deepStrictEqual(once, twice);
    assert.deepStrictEqual(twice, thrice);
  });

  it("9. No unrelated config fields or secrets change (Rule 8)", () => {
    const rawPolicy = createPreTierBPolicy();
    const customConfig = {
      schemaVersion: 2,
      profilePreset: "balanced" as const,
      folders: [{ path: "D:\\Work", alias: "my-alias", permission: "readwrite" as const }],
      terminal: { mode: "full" as const, approvalTtlSeconds: 120 },
      toolPolicy: rawPolicy,
      approval: {
        mode: "smart" as const,
        channels: ["dashboard" as const, "toast" as const],
        blockHoldMs: 45000,
        jobTtlMs: 240000,
        maxPending: 7,
      },
      network: { allowLoopback: true },
      ui: { language: "th" as const },
      development: { installRootAccess: "read" as const },
      secretApiKey: "SECRET_TOKEN_DO_NOT_CORRUPT",
      customArbitraryField: 12345,
    };

    const normalized = normalizeToolPolicyCoverage(customConfig);
    assert.strictEqual(normalized.secretApiKey, "SECRET_TOKEN_DO_NOT_CORRUPT");
    assert.strictEqual(normalized.customArbitraryField, 12345);
    assert.deepStrictEqual(normalized.folders, customConfig.folders);
    assert.deepStrictEqual(normalized.terminal, customConfig.terminal);
    assert.deepStrictEqual(normalized.approval, customConfig.approval);
    assert.deepStrictEqual(normalized.network, customConfig.network);
    assert.deepStrictEqual(normalized.ui, customConfig.ui);
    assert.deepStrictEqual(normalized.development, customConfig.development);
  });

  it("10. Full 56-tool coverage invariant (derived from registry, not hardcoded)", () => {
    const preset = "balanced" as const;
    const rawPolicy = createPreTierBPolicy();
    const config = {
      schemaVersion: 2,
      profilePreset: preset,
      folders: [{ path: "D:\\Work", permission: "readwrite" as const }],
      terminal: { mode: "full" as const },
      toolPolicy: rawPolicy,
    };

    const { coverage } = normalizeToolPolicyCoverageWithReport(config);

    // Derived from registry
    assert.strictEqual(coverage.registered_public_tool_count, ALL_V14_TOOL_NAMES.length);
    assert.strictEqual(coverage.policy_covered_public_tool_count, ALL_V14_TOOL_NAMES.length);
    assert.deepStrictEqual(coverage.missing_policy_tools, []);

    // Current acceptance baseline is 56
    assert.strictEqual(coverage.registered_public_tool_count, 56);
    assert.strictEqual(coverage.policy_covered_public_tool_count, 56);
    assert.strictEqual(coverage.status, "backfilled");
    assert.strictEqual(coverage.backfilled_policy_tools.length, 6);
    assert.deepStrictEqual(coverage.backfilled_policy_tools.sort(), [...SPEC_34_TIER_B_TOOL_NAMES].sort());

    const validation = validatePolicyCoverage(config);
    assert.strictEqual(validation.valid, true);
    assert.deepStrictEqual(validation.errors, []);
  });

  it("11. Tier-B path authorization still applies after policy backfill", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-path-"));
    const allowedSub = path.join(tempRoot, "allowed");
    await fs.mkdir(allowedSub, { recursive: true });
    const allowedFile = path.join(allowedSub, "data.json");
    await fs.writeFile(allowedFile, '{"hello":"world"}', "utf8");

    const outsideFile = path.join(tempRoot, "outside.json");
    await fs.writeFile(outsideFile, '{"forbidden":"data"}', "utf8");

    const config: SchemaV2PermissionConfig = {
      schemaVersion: 2,
      profilePreset: "balanced",
      folders: [{ path: allowedSub, permission: "readwrite" }],
      terminal: { mode: "full" },
      toolPolicy: buildToolPolicyForPreset("balanced"),
      approval: { mode: "smart", channels: ["dashboard", "toast"], blockHoldMs: 60000, jobTtlMs: 180000, maxPending: 5 },
      network: { allowLoopback: false },
    };

    // 1. json_parse_strict with allowed path -> allowed
    const allowRes = evaluateSchemaV2ToolAccess(
      "json_parse_strict",
      { source: { path: allowedFile } },
      config
    );
    assert.strictEqual(allowRes.decision, "allow");

    // 2. json_parse_strict with outside path -> denied by path security gate (not bypassed by tool policy auto)
    const denyRes = evaluateSchemaV2ToolAccess(
      "json_parse_strict",
      { source: { path: outsideFile } },
      config
    );
    assert.strictEqual(denyRes.decision, "deny");
    assert.strictEqual(denyRes.code, "FOLDER_NOT_APPROVED");

    // 3. git_status_structured with outside path -> denied by path security gate
    const gitDeny = evaluateSchemaV2ToolAccess(
      "git_status_structured",
      { repo_path: path.join(tempRoot, "outside-repo") },
      config
    );
    assert.strictEqual(gitDeny.decision, "deny");
    assert.strictEqual(gitDeny.code, "FOLDER_NOT_APPROVED");
  });

  it("12. Validation & runtime status truthfully report coverage and distinguish explicit vs backfilled vs unresolved", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-status-"));
    const configFile = path.join(tempRoot, "winhelm.config.json");

    // Persisted config with balanced profile missing Tier-B tools
    const persisted = {
      schemaVersion: 2,
      profilePreset: "balanced",
      folders: [{ path: tempRoot, permission: "readwrite" }],
      terminal: { mode: "full" },
      toolPolicy: createPreTierBPolicy(),
    };
    await fs.writeFile(configFile, JSON.stringify(persisted, null, 2), "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    const snapshot = buildRuntimeStatusSnapshot(manager);

    // Machine-testable fields exposed
    assert.strictEqual(snapshot.registered_public_tool_count, 56);
    assert.strictEqual(snapshot.policy_covered_public_tool_count, 56);
    assert.deepStrictEqual(snapshot.missing_policy_tools, []);

    const policyCoverage = snapshot.policyCoverage as any;
    assert.ok(policyCoverage);
    assert.strictEqual(policyCoverage.registered_public_tool_count, 56);
    assert.strictEqual(policyCoverage.policy_covered_public_tool_count, 56);
    assert.deepStrictEqual(policyCoverage.missing_policy_tools, []);
    assert.strictEqual(policyCoverage.status, "backfilled");
    assert.strictEqual(policyCoverage.backfilled_policy_tools.length, 6);

    const configStatus = snapshot.config as any;
    assert.strictEqual(configStatus.valid, true);

    // MCP tool winhelm_status exposes this truthful status
    const server = new McpServer({ name: "status-test", version: "1.0.0" });
    registerAllTools(server);
    const tools = (server as any)._registeredTools;
    const res = await tools.winhelm_status.handler({}, {});
    const payload = JSON.parse(res.content[0].text);

    assert.strictEqual(payload.registered_public_tool_count, 56);
    assert.strictEqual(payload.policy_covered_public_tool_count, 56);
    assert.deepStrictEqual(payload.missing_policy_tools, []);
    assert.strictEqual(payload.policyCoverage.status, "backfilled");
  });

  it("13. Truthfully reports incomplete status when unresolved missing policy is present", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-incomplete-"));
    const configFile = path.join(tempRoot, "winhelm.config.json");

    // Missing profilePreset + empty toolPolicy -> completely unresolved coverage
    const incompleteConfig = {
      schemaVersion: 2,
      folders: [{ path: tempRoot, permission: "readwrite" }],
      terminal: { mode: "off" },
      toolPolicy: {},
    };
    await fs.writeFile(configFile, JSON.stringify(incompleteConfig, null, 2), "utf8");

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    const snapshot = buildRuntimeStatusSnapshot(manager);
    const coverage = snapshot.policyCoverage as any;

    assert.strictEqual(coverage.status, "incomplete");
    assert.ok(coverage.missing_policy_tools.length > 0);
    // 56 registered - 5 terminal = 51 non-terminal missing
    assert.strictEqual(coverage.missing_policy_tools.length, 51);
    assert.strictEqual(coverage.policy_covered_public_tool_count, 5); // only 5 terminal tools covered

    // Status truthfully refuses to report fully healthy
    const configStatus = snapshot.config as any;
    assert.strictEqual(configStatus.valid, false, "Config with unresolved policy must not report valid=true");
    assert.ok(configStatus.validationErrors.some((e: string) => e.includes("Missing deliberate policy coverage")));
    assert.ok(configStatus.userAction);

    // Internal validatePolicyCoverage helper also returns valid=false
    const check = validatePolicyCoverage(incompleteConfig);
    assert.strictEqual(check.valid, false);
    assert.ok(check.errors.length > 0);
  });

  it("14. process_resource_monitor ownership denial still applies even when policy is auto", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tier-b-proc-"));
    const configFile = path.join(tempRoot, "winhelm.config.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 2,
        profilePreset: "balanced",
        folders: [{ path: tempRoot, permission: "readwrite" }],
        terminal: { mode: "full" },
        toolPolicy: createPreTierBPolicy(),
      }),
      "utf8"
    );

    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);

    const server = new McpServer({ name: "proc-test", version: "1.0.0" });
    registerAllTools(server);
    const tools = (server as any)._registeredTools;

    // Tool policy is auto (backfilled)
    assert.strictEqual(manager.getConfig().toolPolicy.process_resource_monitor, "auto");

    // Executing with an unknown or unauthorized run_id still fails closed with error (not bypassed by tool policy auto)
    const res = await tools.process_resource_monitor.handler(
      { run_id: "unknown_run_999" },
      { sessionId: "session_a" }
    );
    assert.ok(res.isError);
    const errorPayload = JSON.parse(res.content[0].text);
    assert.ok(errorPayload.error);
    assert.strictEqual(errorPayload.error.code, "RUN_NOT_FOUND");
  });
});
