import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  guardedActiveBackendMarkerCommitAcknowledge,
  guardedActiveBackendMarkerCommitBegin,
  GuardedMarkerCommitValidationError,
} from "../../src/runtime/guarded-marker-commit.js";
import {
  getNativeBoundary,
  trustedNativeAddonPath,
} from "../../src/native/boundary.js";
import { ALL_V14_TOOL_NAMES } from "../../src/tools/registry.js";
import { writeFileAtomic } from "../../src/engine/atomic-file.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { buildPresetConfig } from "../../src/permissions/presets.js";

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test(
  "internal guarded active-backend marker runtime wrapper",
  { skip: !fs.existsSync(trustedNativeAddonPath()) },
  async (t) => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "winhelm-runtime-marker-"),
    );
    t.after(async () => {
      await fs.promises.rm(root, { recursive: true, force: true });
    });

    await t.test("validates marker shape and retains native protection", async () => {
      const markerPath = path.join(root, "winhelm.active-backend.json");
      const current = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          backendRoot: path.join(root, "old-backend"),
          configPath: path.join(root, "old-backend", "winhelm.config.json"),
          expectedHead: "1".repeat(40),
        }),
      );
      await fs.promises.writeFile(markerPath, current);

      const native = getNativeBoundary();
      const held = native.stableReadOpen(markerPath);
      const expected = held.snapshot();
      held.close();

      const replacement = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          backendRoot: path.join(root, "new-backend"),
          configPath: path.join(root, "new-backend", "winhelm.config.json"),
          expectedHead: "a".repeat(40),
        }),
      );
      const result = guardedActiveBackendMarkerCommitBegin({
        markerPath,
        replacementJson: replacement,
        expectedCurrent: {
          sha256: expected.sha256,
          volumeSerialNumber: expected.volumeSerialNumber,
          fileIndexHigh: expected.fileIndexHigh,
          fileIndexLow: expected.fileIndexLow,
        },
      });
      try {
        assert.equal(result.outcome, "SUCCESS");
        assert.equal(result.sha256, sha256(replacement));
        await assert.rejects(
          fs.promises.writeFile(markerPath, "blocked-before-ack"),
        );
      } finally {
        assert.deepEqual(
          guardedActiveBackendMarkerCommitAcknowledge(result.transactionId),
          { acknowledged: true },
        );
      }
      assert.deepEqual(await fs.promises.readFile(markerPath), replacement);
    });

    await t.test("rejects non-marker paths and malformed marker data", () => {
      const expectedCurrent = {
        sha256: "0".repeat(64),
        volumeSerialNumber: 0,
        fileIndexHigh: 0,
        fileIndexLow: 0,
      };
      assert.throws(
        () =>
          guardedActiveBackendMarkerCommitBegin({
            markerPath: path.join(root, "other.json"),
            replacementJson: "{}",
            expectedCurrent,
          }),
        GuardedMarkerCommitValidationError,
      );
      assert.throws(
        () =>
          guardedActiveBackendMarkerCommitBegin({
            markerPath: path.join(root, "winhelm.active-backend.json"),
            replacementJson: JSON.stringify({ schemaVersion: 1 }),
            expectedCurrent,
          }),
        (error: unknown) =>
          error instanceof GuardedMarkerCommitValidationError &&
          error.code === "INVALID_ARGUMENT",
      );
    });

    await t.test("requires explicit current authority instead of snapshotting", () => {
      assert.throws(
        () =>
          guardedActiveBackendMarkerCommitBegin({
            markerPath: path.join(root, "winhelm.active-backend.json"),
            replacementJson: JSON.stringify({
              schemaVersion: 1,
              backendRoot: root,
              configPath: path.join(root, "winhelm.config.json"),
              expectedHead: "b".repeat(40),
            }),
            expectedCurrent: undefined,
          } as never),
        GuardedMarkerCommitValidationError,
      );
    });

    await t.test("does not expand the public MCP registry", () => {
      assert.equal(ALL_V14_TOOL_NAMES.length, 56);
      assert.equal(new Set(ALL_V14_TOOL_NAMES).size, 56);
      assert.equal(
        ALL_V14_TOOL_NAMES.includes("guarded_marker_commit"),
        false,
      );
    });

    await t.test("preserves generic file_write_atomic behavior", async () => {
      const config = buildPresetConfig("balanced", {
        folders: [root],
        approvalMode: "smart",
      });
      const manager = ConfigManager.resetInstance();
      await manager.updateConfig(config as any, false);
      const regularFile = path.join(root, "regular-file.txt");
      const writeResult = await writeFileAtomic(
        { path: regularFile, content: "generic-atomic-payload\n" },
        "test-session-generic",
      );
      assert.equal(writeResult.success, true);
      assert.equal(
        await fs.promises.readFile(regularFile, "utf8"),
        "generic-atomic-payload\n",
      );
    });
  },
);
