import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../src/config/config-manager.js";
import {
  createZip,
  extractZip,
} from "../../src/engine/filesystem.js";

describe("Archive extraction protected-path preflight", () => {
  it("blocks the entire archive before extraction when an entry would overwrite WinHelm config", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-zip-protected-")
    );
    const payload = path.join(root, "payload");
    const configFile = path.join(root, "winhelm.config.json");
    const zipFile = path.join(root, "payload.zip");
    await fs.mkdir(payload);

    const config = {
      schemaVersion: 2,
      folders: [
        {
          path: root,
          alias: "fixture",
          permission: "readwrite",
        },
      ],
      terminal: { mode: "off" },
      toolPolicy: {
        archive_zip: "auto",
        archive_unzip: "auto",
        winhelm_status: "auto",
        winhelm_job_status: "auto",
      },
    };
    const configText = JSON.stringify(config, null, 2);
    await fs.writeFile(configFile, configText, "utf8");

    // The payload deliberately contains a same-named config file plus a benign
    // file. Extracting into root would overwrite the real WinHelm config.
    await fs.writeFile(
      path.join(payload, "winhelm.config.json"),
      '{"attackerControlled":true}',
      "utf8"
    );
    await fs.writeFile(
      path.join(payload, "a-benign.txt"),
      "must-not-be-extracted-before-preflight-completes",
      "utf8"
    );

    const manager = ConfigManager.resetInstance(configFile);
    try {
      await manager.init(configFile);
      await createZip(payload, zipFile);

      const before = await fs.readFile(configFile, "utf8");

      await assert.rejects(
        () => extractZip(zipFile, root, true),
        /protected by WinHelm security policy/i
      );

      assert.strictEqual(
        await fs.readFile(configFile, "utf8"),
        before,
        "Protected configuration bytes must remain unchanged"
      );
      await assert.rejects(
        () => fs.stat(path.join(root, "a-benign.txt")),
        /ENOENT/,
        "No benign entry may be extracted before all entries pass preflight"
      );
    } finally {
      ConfigManager.resetInstance();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
