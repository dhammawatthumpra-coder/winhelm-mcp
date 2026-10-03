import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/config/default-config.js";
import {
  proposeLegacyMigration,
} from "../../src/config/migrate.js";
import {
  diffGovernedState,
  fingerprintGovernedState,
} from "../../src/permissions/profile-state.js";
import {
  validateSchemaV2Config,
} from "../../src/config/schema-v2.js";
import type { ServerConfig } from "../../src/types/index.js";

function legacy(
  overrides: Partial<ServerConfig> = {}
): ServerConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
}

describe("Legacy v1.2.1 -> schema-v2 migration proposal", () => {
  it("maps explicit allowedDirectories to aliased readwrite folders", () => {
    const proposal = proposeLegacyMigration(
      legacy({
        profile: "core",
        allowedDirectories: [
          "D:\\Work\\alpha",
          "D:\\Work\\beta",
        ],
      }),
      "2026-10-03T00:00:00.000Z"
    );

    assert.strictEqual(proposal.status, "ready");
    assert.strictEqual(proposal.suggestedPreset, "core");
    assert.ok(proposal.candidate);
    assert.deepStrictEqual(proposal.candidate!.folders, [
      {
        path: "D:\\Work\\alpha",
        alias: "alpha",
        permission: "readwrite",
      },
      {
        path: "D:\\Work\\beta",
        alias: "beta",
        permission: "readwrite",
      },
    ]);
    assert.strictEqual(proposal.candidate!.terminal.mode, "ask");
    assert.strictEqual(
      validateSchemaV2Config(proposal.candidate as any).valid,
      true
    );
  });

  it("maps allowedDirectories=[] to folders=[] without opening access", () => {
    const proposal = proposeLegacyMigration(
      legacy({
        profile: "core",
        allowedDirectories: [],
      })
    );

    assert.strictEqual(proposal.status, "ready");
    assert.deepStrictEqual(proposal.candidate?.folders, []);
    assert.ok(
      proposal.notes.some((note) => note.includes("fail-closed"))
    );
  });

  it("does not auto-migrate wildcard legacy access", () => {
    const proposal = proposeLegacyMigration(
      legacy({
        profile: "full",
        allowedDirectories: ["*"],
      })
    );

    assert.strictEqual(
      proposal.status,
      "folder-selection-required"
    );
    assert.strictEqual(proposal.candidate, null);
    assert.strictEqual(proposal.suggestedPreset, "full");
    assert.ok(
      proposal.warnings.some((warning) =>
        warning.includes("not migrated automatically")
      )
    );
  });

  it("maps readOnly=true conservatively to read folders, terminal off, and destructive tools off", () => {
    const proposal = proposeLegacyMigration(
      legacy({
        profile: "full",
        allowedDirectories: ["D:\\ReadOnly"],
        readOnly: true,
      })
    );

    const candidate = proposal.candidate!;
    assert.strictEqual(candidate.folders[0].permission, "read");
    assert.strictEqual(candidate.terminal.mode, "off");
    assert.strictEqual(candidate.toolPolicy.file_write, "off");
    assert.strictEqual(candidate.toolPolicy.http_request, "off");
    assert.strictEqual(candidate.toolPolicy.process_kill, "off");
    assert.strictEqual(candidate.toolPolicy.system_info, "auto");
    assert.ok(
      proposal.warnings.some((warning) =>
        warning.includes("readOnly=true")
      )
    );
  });

  it("maps a legacy named full profile without silently enabling terminal full", () => {
    const proposal = proposeLegacyMigration(
      legacy({
        profile: "full",
        allowedDirectories: ["D:\\Work"],
      }),
      "2026-10-03T00:00:00.000Z"
    );

    const candidate = proposal.candidate!;
    assert.strictEqual(candidate.profilePreset, "full");
    assert.strictEqual(candidate.terminal.mode, "ask");
    assert.ok(candidate.profileState);

    const diff = diffGovernedState(
      candidate.profileState!.appliedSnapshot,
      candidate
    );
    assert.strictEqual(diff.modified, true);
    assert.deepStrictEqual(diff.fields, ["terminal.mode"]);
    assert.strictEqual(
      candidate.profileState!.appliedFingerprint,
      fingerprintGovernedState(
        candidate.profileState!.appliedSnapshot
      )
    );
  });

  it("maps customTools to explicit toolPolicy without creating a named Custom Profile", () => {
    const proposal = proposeLegacyMigration(
      legacy({
        profile: "custom",
        customTools: ["file_read", "file_write"],
        allowedDirectories: ["D:\\Custom"],
      })
    );

    const candidate = proposal.candidate!;
    assert.strictEqual(proposal.sourceProfile, "custom");
    assert.strictEqual(proposal.suggestedPreset, null);
    assert.strictEqual(candidate.profilePreset, undefined);
    assert.strictEqual(candidate.profileState, undefined);
    assert.strictEqual(candidate.toolPolicy.file_read, "auto");
    assert.strictEqual(candidate.toolPolicy.file_write, "auto");
    assert.strictEqual(candidate.toolPolicy.system_info, "off");
    assert.strictEqual(candidate.toolPolicy.winhelm_status, "auto");
    assert.strictEqual(
      candidate.toolPolicy.winhelm_job_status,
      "auto"
    );
    assert.strictEqual(candidate.terminal.mode, "off");
    assert.ok(
      proposal.warnings.some((warning) =>
        warning.includes("does not create a named Custom Profile")
      )
    );
  });

  it("uses terminal ask when migrated customTools contained a legacy terminal execution tool", () => {
    const proposal = proposeLegacyMigration(
      legacy({
        profile: "custom",
        customTools: ["file_read", "terminal_run"],
        allowedDirectories: ["D:\\Custom"],
      })
    );

    assert.strictEqual(
      proposal.candidate?.terminal.mode,
      "ask"
    );
  });

  it("does not propose migration for a schema-v2 config", () => {
    const proposal = proposeLegacyMigration(
      {
        ...legacy(),
        schemaVersion: 2,
        folders: [],
        terminal: { mode: "ask" },
        toolPolicy: {},
      }
    );

    assert.strictEqual(proposal.status, "not-legacy");
    assert.strictEqual(proposal.candidate, null);
  });
});
