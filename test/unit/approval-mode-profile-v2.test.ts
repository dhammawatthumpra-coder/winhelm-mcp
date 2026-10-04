import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  applyApprovalMode,
  applyLegacyMigrationApplication,
  applyProfilePreset,
  getProfileStatus,
  previewApprovalModeApplication,
  previewLegacyMigrationApplication,
  previewProfileApplication,
  ProfileServiceError,
} from "../../src/config/profile-service.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";

async function withConfig(
  raw: Record<string, unknown>,
  fn: (manager: ConfigManager, configFile: string, root: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-approval-profile-"));
  const configFile = path.join(root, "winhelm.config.json");
  await fs.writeFile(configFile, JSON.stringify(raw, null, 2), "utf8");

  try {
    const manager = ConfigManager.resetInstance(configFile);
    await manager.init(configFile);
    await fn(manager, configFile, root);
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("Approval Mode profile and migration semantics", () => {
  it("previews legacy schema-v2 mode migration without persistence and writes only approval.mode on apply", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-mode-workspace-"));
    try {
      const config = buildPresetConfig("balanced", { folders: [workspace] });
      delete config.approval.mode;
      const beforePolicy = structuredClone(config.toolPolicy);
      const beforeTerminal = structuredClone(config.terminal);

      await withConfig(config as unknown as Record<string, unknown>, async (manager, configFile) => {
        const beforeFile = await fs.readFile(configFile, "utf8");
        const beforeStatus = getProfileStatus(manager);
        assert.strictEqual(beforeStatus.approvalMode, null);
        assert.strictEqual(beforeStatus.approvalBehavior, "legacy");
        assert.strictEqual(beforeStatus.modified, false);

        const preview = previewApprovalModeApplication({ mode: "smart" }, manager);
        assert.strictEqual(preview.currentMode, null);
        assert.strictEqual(preview.targetMode, "smart");
        assert.strictEqual(preview.legacyBehavior, true);
        assert.strictEqual(preview.requiresTypedConfirmation, false);
        assert.strictEqual(await fs.readFile(configFile, "utf8"), beforeFile);

        const result = await applyApprovalMode({ mode: "smart" }, manager);
        assert.strictEqual(result.status.approvalMode, "smart");
        assert.strictEqual(result.status.approvalBehavior, "explicit");
        assert.strictEqual(result.status.modified, false);
        assert.deepStrictEqual(manager.getConfig().toolPolicy, beforePolicy);
        assert.deepStrictEqual(manager.getConfig().terminal, beforeTerminal);

        const persisted = JSON.parse(await fs.readFile(configFile, "utf8"));
        assert.strictEqual(persisted.approval.mode, "smart");
        assert.deepStrictEqual(persisted.toolPolicy, beforePolicy);
        assert.deepStrictEqual(persisted.terminal, beforeTerminal);
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation before selecting Trusted or reducing prompting", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-mode-trusted-"));
    try {
      const config = buildPresetConfig("balanced", { folders: [workspace] });

      await withConfig(config as unknown as Record<string, unknown>, async (manager) => {
        const trustedPreview = previewApprovalModeApplication(
          { mode: "trusted" },
          manager
        );
        assert.strictEqual(trustedPreview.requiresTypedConfirmation, true);

        await assert.rejects(
          () => applyApprovalMode({ mode: "trusted" }, manager),
          (err: unknown) =>
            err instanceof ProfileServiceError &&
            err.code === "TYPED_CONFIRMATION_REQUIRED"
        );

        const trusted = await applyApprovalMode(
          { mode: "trusted", confirmation: "confirm" },
          manager
        );
        assert.strictEqual(trusted.status.approvalMode, "trusted");
        assert.strictEqual(trusted.status.modified, false);

        const manual = await applyApprovalMode({ mode: "manual" }, manager);
        assert.strictEqual(manual.status.approvalMode, "manual");

        const smartPreview = previewApprovalModeApplication(
          { mode: "smart" },
          manager
        );
        assert.strictEqual(smartPreview.requiresTypedConfirmation, true);
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires confirmation for capability expansion but not for an unchanged reapply", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-profile-expand-"));
    try {
      const safe = buildPresetConfig("safe", { folders: [workspace] });

      await withConfig(safe as unknown as Record<string, unknown>, async (manager) => {
        const preview = previewProfileApplication(
          {
            preset: "balanced",
            folders: [{ path: workspace, alias: "workspace" }],
          },
          manager
        );
        assert.strictEqual(preview.requiresTypedConfirmation, true);
        assert.ok(preview.authorityExpansionReasons.length > 0);
        assert.ok(
          preview.authorityExpansionReasons.some((reason) =>
            reason.includes("readwrite")
          )
        );

        await assert.rejects(
          () =>
            applyProfilePreset(
              {
                preset: "balanced",
                folders: [{ path: workspace, alias: "workspace" }],
              },
              manager
            ),
          (err: unknown) =>
            err instanceof ProfileServiceError &&
            err.code === "TYPED_CONFIRMATION_REQUIRED"
        );

        const applied = await applyProfilePreset(
          {
            preset: "balanced",
            folders: [{ path: workspace, alias: "workspace" }],
            confirmation: "confirm",
          },
          manager
        );
        assert.strictEqual(applied.status.preset, "balanced");
        assert.strictEqual(applied.status.approvalMode, "smart");
        assert.strictEqual(applied.status.modified, false);

        const unchanged = previewProfileApplication(
          {
            preset: "balanced",
            folders: [{ path: workspace, alias: "workspace" }],
          },
          manager
        );
        assert.strictEqual(unchanged.requiresTypedConfirmation, false);
        assert.deepStrictEqual(unchanged.authorityExpansionReasons, []);
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("re-applying a product preset on legacy schema-v2 preserves v1.3 confirmation floors", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-legacy-v2-preset-")
    );
    try {
      const config = buildPresetConfig("balanced", { folders: [workspace] });
      delete config.approval.mode;
      config.terminal.mode = "ask";

      for (const tool of [
        "http_ping",
        "http_request",
        "clipboard_get",
        "clipboard_set",
        "screen_capture",
        "system_open",
        "process_kill",
        "service_control",
      ]) {
        config.toolPolicy[tool] = "ask";
      }

      if (config.profileState) {
        config.profileState.appliedSnapshot.terminal = {
          ...config.terminal,
        };
        config.profileState.appliedSnapshot.toolPolicy = {
          ...config.toolPolicy,
        };
      }

      await withConfig(
        config as unknown as Record<string, unknown>,
        async (manager) => {
          const before = getProfileStatus(manager);
          assert.strictEqual(before.approvalBehavior, "legacy");
          assert.strictEqual(before.modified, false);

          const preview = previewProfileApplication(
            {
              preset: "balanced",
              folders: [{ path: workspace, alias: "workspace" }],
            },
            manager
          );
          assert.strictEqual(preview.approvalMode, "smart");
          assert.strictEqual(preview.terminalMode, "ask");
          assert.strictEqual(preview.toolPolicy.http_request, "ask");
          assert.strictEqual(preview.toolPolicy.clipboard_get, "ask");
          assert.strictEqual(preview.toolPolicy.process_kill, "off");
          assert.strictEqual(preview.toolPolicy.service_control, "off");
          assert.strictEqual(preview.requiresTypedConfirmation, false);

          const result = await applyProfilePreset(
            {
              preset: "balanced",
              folders: [{ path: workspace, alias: "workspace" }],
            },
            manager
          );

          assert.strictEqual(result.status.approvalMode, "smart");
          assert.strictEqual(result.status.approvalBehavior, "explicit");
          assert.strictEqual(result.status.terminalMode, "ask");
          assert.strictEqual(
            manager.getConfig().toolPolicy?.http_request,
            "ask"
          );
          assert.strictEqual(
            manager.getConfig().toolPolicy?.clipboard_get,
            "ask"
          );
          assert.strictEqual(
            manager.getConfig().toolPolicy?.process_kill,
            "off"
          );
          assert.strictEqual(
            manager.getConfig().toolPolicy?.service_control,
            "off"
          );
          assert.strictEqual(result.status.modified, false);
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("proposes Manual conservatively for legacy v1.2.1 migration and does not persist on preview", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-legacy-manual-"));
    try {
      await withConfig(
        {
          profile: "core",
          allowedDirectories: [workspace],
          readOnly: false,
        },
        async (manager, configFile) => {
          const before = await fs.readFile(configFile, "utf8");
          const preview = previewLegacyMigrationApplication({}, manager);
          assert.strictEqual(preview.status, "ready");
          assert.strictEqual(preview.candidate?.approval.mode, "manual");
          assert.strictEqual(await fs.readFile(configFile, "utf8"), before);

          const result = await applyLegacyMigrationApplication({}, manager);
          assert.strictEqual(result.status.approvalMode, "manual");
          assert.strictEqual(result.status.approvalBehavior, "explicit");
        }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
