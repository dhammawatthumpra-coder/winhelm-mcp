import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import { runSetupCliCommand } from "../../src/cli/setup.js";

async function fixture(): Promise<{
  root: string;
  workspace: string;
  configFile: string;
  answersFile: string;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "winhelm-setup-cli-")
  );
  const workspace = path.join(root, "workspace");
  const configFile = path.join(root, "winhelm.config.json");
  const answersFile = path.join(root, "answers.json");
  await fs.mkdir(workspace);
  await fs.writeFile(
    configFile,
    JSON.stringify(
      {
        profile: "core",
        allowedDirectories: [workspace],
      },
      null,
      2
    ),
    "utf8"
  );

  return { root, workspace, configFile, answersFile };
}

describe("winhelm setup CLI", () => {
  it("ignores non-setup commands", async () => {
    const result = await runSetupCliCommand(["jobs"]);
    assert.deepStrictEqual(result, {
      handled: false,
      exitCode: 0,
    });
  });

  it("supports non-interactive dry-run without changing config", async () => {
    const f = await fixture();
    try {
      await fs.writeFile(
        f.answersFile,
        JSON.stringify({
          preset: "balanced",
          folders: [{ path: f.workspace, alias: "workspace" }],
        }),
        "utf8"
      );

      const before = await fs.readFile(f.configFile, "utf8");
      const result = await runSetupCliCommand([
        "setup",
        "--config",
        f.configFile,
        "--answers",
        f.answersFile,
        "--dry-run",
      ]);

      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.output ?? "", /Dry run only/i);
      assert.match(result.output ?? "", /Preset: balanced/i);
      assert.strictEqual(
        await fs.readFile(f.configFile, "utf8"),
        before
      );
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("requires --yes for a non-interactive answer file", async () => {
    const f = await fixture();
    try {
      await fs.writeFile(
        f.answersFile,
        JSON.stringify({
          preset: "balanced",
          folders: [f.workspace],
        }),
        "utf8"
      );

      const result = await runSetupCliCommand([
        "setup",
        "--config",
        f.configFile,
        "--answers",
        f.answersFile,
      ]);

      assert.strictEqual(result.exitCode, 2);
      assert.match(result.error ?? "", /requires --yes/i);

      const persisted = JSON.parse(
        await fs.readFile(f.configFile, "utf8")
      );
      assert.strictEqual(persisted.schemaVersion, undefined);
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("applies Balanced from an answer file and creates a backup", async () => {
    const f = await fixture();
    try {
      await fs.writeFile(
        f.answersFile,
        JSON.stringify({
          preset: "balanced",
          folders: [{ path: f.workspace, alias: "workspace" }],
        }),
        "utf8"
      );

      const result = await runSetupCliCommand([
        "setup",
        "--config",
        f.configFile,
        "--answers",
        f.answersFile,
        "--yes",
      ]);

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.output ?? "", /setup complete/i);
      assert.match(result.output ?? "", /Preset: balanced/i);
      assert.match(result.output ?? "", /Backup:/i);

      const persisted = JSON.parse(
        await fs.readFile(f.configFile, "utf8")
      );
      assert.strictEqual(persisted.schemaVersion, 2);
      assert.strictEqual(persisted.profilePreset, "balanced");
      assert.strictEqual(persisted.terminal.mode, "ask");
      assert.strictEqual(persisted.folders[0].alias, "workspace");
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("requires typed confirmation for Power in non-interactive setup", async () => {
    const f = await fixture();
    try {
      await fs.writeFile(
        f.answersFile,
        JSON.stringify({
          preset: "power",
          folders: [f.workspace],
        }),
        "utf8"
      );

      const denied = await runSetupCliCommand([
        "setup",
        "--config",
        f.configFile,
        "--answers",
        f.answersFile,
        "--yes",
      ]);
      assert.strictEqual(denied.exitCode, 1);
      assert.match(
        denied.error ?? "",
        /TYPED_CONFIRMATION_REQUIRED/
      );

      const applied = await runSetupCliCommand([
        "setup",
        "--config",
        f.configFile,
        "--answers",
        f.answersFile,
        "--confirm",
        "confirm",
        "--yes",
      ]);
      assert.strictEqual(applied.exitCode, 0);

      const persisted = JSON.parse(
        await fs.readFile(f.configFile, "utf8")
      );
      assert.strictEqual(persisted.profilePreset, "power");
      assert.strictEqual(persisted.terminal.mode, "full");
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("lets CLI flags override answer-file preset/folders", async () => {
    const f = await fixture();
    const second = path.join(f.root, "second");
    await fs.mkdir(second);

    try {
      await fs.writeFile(
        f.answersFile,
        JSON.stringify({
          preset: "safe",
          folders: [f.workspace],
        }),
        "utf8"
      );

      const result = await runSetupCliCommand([
        "setup",
        "--config",
        f.configFile,
        "--answers",
        f.answersFile,
        "--preset",
        "balanced",
        "--folder",
        second + "::second",
        "--yes",
      ]);
      assert.strictEqual(result.exitCode, 0);

      const persisted = JSON.parse(
        await fs.readFile(f.configFile, "utf8")
      );
      assert.strictEqual(persisted.profilePreset, "balanced");
      assert.strictEqual(persisted.folders.length, 1);
      assert.strictEqual(
        persisted.folders[0].path,
        path.resolve(second)
      );
      assert.strictEqual(persisted.folders[0].alias, "second");
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
});
