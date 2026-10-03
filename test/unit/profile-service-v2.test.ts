import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  applyLegacyMigrationApplication,
  applyProfilePreset,
  getProfileStatus,
  previewLegacyMigrationApplication,
  previewProfileApplication,
  ProfileServiceError,
  validateWizardFolder,
} from "../../src/config/profile-service.js";

async function withLegacyConfig(
  value: Record<string, unknown>,
  fn: (
    manager: ConfigManager,
    configFile: string,
    root: string
  ) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "winhelm-profile-service-")
  );
  const configFile = path.join(root, "winhelm.config.json");
  await fs.writeFile(
    configFile,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    await fn(manager, configFile, root);
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("Schema-v2 profile service", () => {
  it("applies Balanced with a backup and persists authoritative profile state", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-profile-workspace-")
    );

    try {
      await withLegacyConfig(
        {
          profile: "core",
          allowedDirectories: [workspace],
          readOnly: false,
        },
        async (manager, configFile) => {
          const preview = previewProfileApplication(
            {
              preset: "balanced",
              folders: [{ path: workspace, alias: "workspace" }],
            },
            manager
          );
          assert.deepStrictEqual(preview.changedFields, [
            "folders",
            "terminal.mode",
            "toolPolicy",
          ]);
          assert.strictEqual(preview.terminalMode, "ask");
          assert.strictEqual(
            preview.requiresTypedConfirmation,
            false
          );

          const result = await applyProfilePreset(
            {
              preset: "balanced",
              folders: [{ path: workspace, alias: "workspace" }],
            },
            manager
          );

          assert.ok(result.backupPath);
          assert.strictEqual(existsSync(result.backupPath!), true);
          assert.strictEqual(manager.getConfigMode(), "v2");
          assert.strictEqual(result.status.preset, "balanced");
          assert.strictEqual(result.status.modified, false);
          assert.strictEqual(result.status.terminalMode, "ask");
          assert.deepStrictEqual(result.status.folders, [
            {
              path: path.resolve(workspace),
              alias: "workspace",
              permission: "readwrite",
            },
          ]);

          const persisted = JSON.parse(
            await fs.readFile(configFile, "utf8")
          );
          assert.strictEqual(persisted.schemaVersion, 2);
          assert.strictEqual(
            persisted.profileState.preset,
            "balanced"
          );
          assert.match(
            persisted.profileState.appliedFingerprint,
            /^[a-f0-9]{64}$/
          );

          const backup = JSON.parse(
            await fs.readFile(result.backupPath!, "utf8")
          );
          assert.strictEqual(backup.schemaVersion, undefined);
          assert.strictEqual(backup.profile, "core");
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("changes only governed profile fields and preserves v2 approval/network/ui settings", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-profile-preserve-")
    );

    try {
      await withLegacyConfig(
        {
          profile: "core",
          allowedDirectories: [workspace],
        },
        async (manager, configFile) => {
          await applyProfilePreset(
            {
              preset: "balanced",
              folders: [{ path: workspace, alias: "workspace" }],
            },
            manager
          );

          await manager.updateConfig(
            {
              terminal: {
                mode: "ask",
                approvalTtlSeconds: 77,
              },
              approval: {
                channels: ["dashboard", "cli"],
                blockHoldMs: 45_000,
                jobTtlMs: 120_000,
                maxPending: 4,
              },
              network: { allowLoopback: true },
              ui: { language: "th" },
            },
            true
          );

          const applied = await applyProfilePreset(
            {
              preset: "safe",
              folders: [{ path: workspace, alias: "workspace" }],
            },
            manager
          );

          assert.strictEqual(applied.status.preset, "safe");
          assert.strictEqual(applied.status.modified, false);

          const effective = manager.getConfig();
          assert.deepStrictEqual(effective.approval, {
            channels: ["dashboard", "cli"],
            blockHoldMs: 45_000,
            jobTtlMs: 120_000,
            maxPending: 4,
          });
          assert.deepStrictEqual(effective.network, {
            allowLoopback: true,
          });
          assert.deepStrictEqual(effective.ui, {
            language: "th",
          });
          assert.deepStrictEqual(effective.terminal, {
            mode: "off",
            approvalTtlSeconds: 77,
          });

          const persisted = JSON.parse(
            await fs.readFile(configFile, "utf8")
          );
          assert.deepStrictEqual(persisted.approval, {
            channels: ["dashboard", "cli"],
            blockHoldMs: 45_000,
            jobTtlMs: 120_000,
            maxPending: 4,
          });
          assert.deepStrictEqual(persisted.network, {
            allowLoopback: true,
          });
          assert.deepStrictEqual(persisted.ui, {
            language: "th",
          });
          assert.deepStrictEqual(persisted.terminal, {
            mode: "off",
            approvalTtlSeconds: 77,
          });
          assert.deepStrictEqual(
            persisted.profileState.appliedSnapshot.terminal,
            { mode: "off" }
          );
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports Modified from preset after an authoritative permission field changes", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-profile-modified-")
    );

    try {
      await withLegacyConfig(
        {
          profile: "core",
          allowedDirectories: [workspace],
        },
        async (manager) => {
          await applyProfilePreset(
            {
              preset: "balanced",
              folders: [{ path: workspace }],
            },
            manager
          );

          const current = manager.getConfig();
          await manager.updateConfig(
            {
              toolPolicy: {
                ...(current.toolPolicy ?? {}),
                http_request: "off",
              },
            },
            false
          );

          const status = getProfileStatus(manager);
          assert.strictEqual(status.modified, true);
          assert.deepStrictEqual(status.modifiedFields, [
            "toolPolicy",
          ]);
          assert.strictEqual(status.preset, "balanced");
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires local typed confirmation before applying Power/full terminal mode", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-profile-power-")
    );

    try {
      await withLegacyConfig(
        {
          profile: "full",
          allowedDirectories: [workspace],
        },
        async (manager) => {
          const preview = previewProfileApplication(
            {
              preset: "power",
              folders: [{ path: workspace }],
            },
            manager
          );
          assert.strictEqual(
            preview.requiresTypedConfirmation,
            true
          );
          assert.strictEqual(preview.terminalMode, "full");

          await assert.rejects(
            () =>
              applyProfilePreset(
                {
                  preset: "power",
                  folders: [{ path: workspace }],
                },
                manager
              ),
            (err: any) =>
              err instanceof ProfileServiceError &&
              err.code === "TYPED_CONFIRMATION_REQUIRED"
          );
          assert.strictEqual(manager.getConfigMode(), "legacy");

          const applied = await applyProfilePreset(
            {
              preset: "power",
              folders: [{ path: workspace }],
              confirmation: "confirm",
            },
            manager
          );
          assert.strictEqual(applied.status.terminalMode, "full");
          assert.strictEqual(applied.status.preset, "power");
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not silently migrate legacy wildcard access without explicit folder selection", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-profile-wildcard-")
    );

    try {
      await withLegacyConfig(
        {
          profile: "full",
          allowedDirectories: ["*"],
        },
        async (manager) => {
          const preview = previewProfileApplication(
            { preset: "balanced" },
            manager
          );
          assert.strictEqual(
            preview.legacyWildcardRequiresFolderSelection,
            true
          );
          assert.deepStrictEqual(preview.folders, []);

          await assert.rejects(
            () =>
              applyProfilePreset(
                { preset: "balanced" },
                manager
              ),
            (err: any) =>
              err instanceof ProfileServiceError &&
              err.code === "FOLDER_SELECTION_REQUIRED"
          );

          const applied = await applyProfilePreset(
            {
              preset: "balanced",
              folders: [{ path: workspace }],
            },
            manager
          );
          assert.strictEqual(applied.status.schemaMode, "v2");
          assert.strictEqual(applied.status.folders.length, 1);
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("previews and applies an explicit legacy named-profile migration with backup", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-migration-core-")
    );

    try {
      await withLegacyConfig(
        {
          profile: "core",
          allowedDirectories: [workspace],
          readOnly: false,
        },
        async (manager, configFile) => {
          const preview = previewLegacyMigrationApplication(
            {},
            manager
          );
          assert.strictEqual(preview.status, "ready");
          assert.strictEqual(
            preview.candidate?.profilePreset,
            "core"
          );
          assert.strictEqual(
            preview.candidate?.terminal.mode,
            "ask"
          );

          const applied =
            await applyLegacyMigrationApplication(
              {},
              manager
            );

          assert.ok(applied.backupPath);
          assert.strictEqual(
            existsSync(applied.backupPath!),
            true
          );
          assert.strictEqual(manager.getConfigMode(), "v2");
          assert.strictEqual(applied.status.preset, "core");
          assert.strictEqual(applied.status.modified, false);
          assert.strictEqual(
            applied.status.folders[0].path,
            path.resolve(workspace)
          );

          const persisted = JSON.parse(
            await fs.readFile(configFile, "utf8")
          );
          assert.strictEqual(persisted.schemaVersion, 2);
          assert.strictEqual(persisted.profilePreset, "core");
        }
      );
    } finally {
      await fs.rm(workspace, {
        recursive: true,
        force: true,
      });
    }
  });

  it("requires explicit folder selection before applying a wildcard legacy migration", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-migration-wildcard-")
    );

    try {
      await withLegacyConfig(
        {
          profile: "full",
          allowedDirectories: ["*"],
        },
        async (manager) => {
          const blocked = previewLegacyMigrationApplication(
            {},
            manager
          );
          assert.strictEqual(
            blocked.status,
            "folder-selection-required"
          );
          assert.strictEqual(blocked.candidate, null);

          await assert.rejects(
            () =>
              applyLegacyMigrationApplication(
                {},
                manager
              ),
            (err: any) =>
              err instanceof ProfileServiceError &&
              err.code === "FOLDER_SELECTION_REQUIRED"
          );

          const preview = previewLegacyMigrationApplication(
            {
              folders: [
                {
                  path: workspace,
                  alias: "workspace",
                },
              ],
            },
            manager
          );
          assert.strictEqual(preview.status, "ready");
          assert.strictEqual(
            preview.candidate?.folders[0].alias,
            "workspace"
          );
          assert.strictEqual(
            preview.candidate?.terminal.mode,
            "ask"
          );

          const applied =
            await applyLegacyMigrationApplication(
              {
                folders: [
                  {
                    path: workspace,
                    alias: "workspace",
                  },
                ],
              },
              manager
            );

          assert.strictEqual(applied.status.preset, "full");
          assert.strictEqual(applied.status.modified, true);
          assert.deepStrictEqual(
            applied.status.modifiedFields,
            ["terminal.mode"]
          );
        }
      );
    } finally {
      await fs.rm(workspace, {
        recursive: true,
        force: true,
      });
    }
  });

  it("migrates legacy customTools as manual schema-v2 policy without a named Custom Profile", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-migration-custom-")
    );

    try {
      await withLegacyConfig(
        {
          profile: "custom",
          customTools: ["file_read", "file_write"],
          allowedDirectories: [workspace],
        },
        async (manager) => {
          const applied =
            await applyLegacyMigrationApplication(
              {},
              manager
            );

          assert.strictEqual(applied.status.schemaMode, "v2");
          assert.strictEqual(applied.status.preset, null);
          assert.strictEqual(applied.status.modified, null);
          assert.strictEqual(
            manager.getConfig().toolPolicy?.file_read,
            "auto"
          );
          assert.strictEqual(
            manager.getConfig().toolPolicy?.file_write,
            "auto"
          );
          assert.strictEqual(
            manager.getConfig().toolPolicy?.system_info,
            "off"
          );
          assert.strictEqual(
            manager.getConfig().terminal?.mode,
            "off"
          );
        }
      );
    } finally {
      await fs.rm(workspace, {
        recursive: true,
        force: true,
      });
    }
  });

  it("blocks filesystem roots and the user-profile root in wizard folder selection", () => {
    const root = path.parse(path.resolve(os.tmpdir())).root;
    assert.throws(
      () => validateWizardFolder(root),
      (err: any) =>
        err instanceof ProfileServiceError &&
        err.code === "WIZARD_FOLDER_BLOCKED"
    );

    assert.throws(
      () => validateWizardFolder(os.homedir()),
      (err: any) =>
        err instanceof ProfileServiceError &&
        err.code === "WIZARD_FOLDER_BLOCKED"
    );
  });

  it("keeps in-memory config unchanged when persistence fails", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-profile-persist-fail-")
    );
    const blocker = path.join(root, "not-a-directory");
    const configFile = path.join(blocker, "config.json");
    const workspace = path.join(root, "workspace");
    await fs.writeFile(blocker, "block mkdir/write", "utf8");
    await fs.mkdir(workspace);

    try {
      const manager = ConfigManager.resetInstance(configFile);
      assert.strictEqual(manager.getConfigMode(), "legacy");

      await assert.rejects(
        () =>
          applyProfilePreset(
            {
              preset: "balanced",
              folders: [{ path: workspace }],
            },
            manager
          ),
        (err: any) =>
          err instanceof ProfileServiceError &&
          err.code === "CONFIG_PERSIST_FAILED"
      );

      assert.strictEqual(manager.getConfigMode(), "legacy");
      assert.strictEqual(manager.getConfig().schemaVersion, undefined);
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
