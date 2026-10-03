import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { ServerConfig } from "../../src/types/index.js";
import { buildSchemaV2CliPermissionUpdates } from "../../src/config/runtime-overrides.js";

function currentConfig(): ServerConfig {
  return {
    blockedCommands: [],
    allowedDirectories: [],
    fileReadLineLimit: 2000,
    defaultTimeoutMs: 60_000,
    telemetryEnabled: false,
    schemaVersion: 2,
    profilePreset: "balanced",
    folders: [
      {
        path: "D:\\Workspace",
        alias: "workspace",
        permission: "readwrite",
      },
      {
        path: "D:\\Docs",
        alias: "docs",
        permission: "readwrite",
      },
    ],
    terminal: {
      mode: "ask",
      approvalTtlSeconds: 77,
    },
    toolPolicy: {
      system_info: "auto",
      http_request: "ask",
    },
    approval: {
      channels: ["dashboard", "cli"],
      blockHoldMs: 45_000,
      jobTtlMs: 120_000,
      maxPending: 4,
    },
    network: { allowLoopback: true },
    ui: { language: "th" },
    profileState: {
      preset: "balanced",
      appliedAt: "2026-10-03T00:00:00.000Z",
      appliedSnapshot: {
        folders: [
          {
            path: "D:\\Workspace",
            alias: "workspace",
            permission: "readwrite",
          },
          {
            path: "D:\\Docs",
            alias: "docs",
            permission: "readwrite",
          },
        ],
        terminal: { mode: "ask" },
        toolPolicy: {
          system_info: "auto",
          http_request: "ask",
        },
      },
    },
  };
}

describe("schema-v2 CLI permission overrides", () => {
  it("replaces folders as readwrite and preserves aliases for matching paths", () => {
    const updates = buildSchemaV2CliPermissionUpdates(
      currentConfig(),
      {
        allowedDirectories: [
          "D:\\Workspace",
          "D:\\NewProject",
        ],
      }
    );

    assert.deepStrictEqual(updates, {
      folders: [
        {
          path: path.resolve("D:\\Workspace"),
          alias: "workspace",
          permission: "readwrite",
        },
        {
          path: path.resolve("D:\\NewProject"),
          permission: "readwrite",
        },
      ],
    });
  });

  it("maps --read-only to read folders and terminal off while preserving terminal options", () => {
    const updates = buildSchemaV2CliPermissionUpdates(
      currentConfig(),
      { readOnly: true }
    );

    assert.deepStrictEqual(updates.folders, [
      {
        path: "D:\\Workspace",
        alias: "workspace",
        permission: "read",
      },
      {
        path: "D:\\Docs",
        alias: "docs",
        permission: "read",
      },
    ]);
    assert.deepStrictEqual(updates.terminal, {
      mode: "off",
      approvalTtlSeconds: 77,
    });
    assert.strictEqual(updates.profileState, undefined);
    assert.strictEqual(updates.toolPolicy, undefined);
    assert.strictEqual(updates.approval, undefined);
    assert.strictEqual(updates.network, undefined);
    assert.strictEqual(updates.ui, undefined);
  });

  it("lets CLI folders override an ENV-derived folder set and applies CLI read-only last", () => {
    const envDerived = currentConfig();
    envDerived.folders = [
      {
        path: "D:\\EnvFolder",
        permission: "read",
      },
    ];
    envDerived.terminal = { mode: "off" };

    const updates = buildSchemaV2CliPermissionUpdates(
      envDerived,
      {
        allowedDirectories: ["D:\\CliFolder"],
        readOnly: true,
      }
    );

    assert.deepStrictEqual(updates.folders, [
      {
        path: path.resolve("D:\\CliFolder"),
        permission: "read",
      },
    ]);
    assert.deepStrictEqual(updates.terminal, {
      mode: "off",
    });
  });

  it("never revives legacy wildcard access in schema-v2", () => {
    const updates = buildSchemaV2CliPermissionUpdates(
      currentConfig(),
      {
        allowedDirectories: ["*"],
      }
    );

    assert.deepStrictEqual(updates.folders, []);
    assert.strictEqual(updates.terminal, undefined);
  });

  it("returns no changes when no schema-v2 permission CLI override was supplied", () => {
    assert.deepStrictEqual(
      buildSchemaV2CliPermissionUpdates(
        currentConfig(),
        {}
      ),
      {}
    );
  });
});
