import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalizeGovernedState,
  diffGovernedState,
  fingerprintGovernedState,
  isModifiedFromAppliedSnapshot,
  type GovernedPermissionState,
} from "../../src/permissions/profile-state.js";

function state(
  folders: GovernedPermissionState["folders"],
  mode: GovernedPermissionState["terminal"]["mode"] = "ask",
  toolPolicy: GovernedPermissionState["toolPolicy"] = {
    file_read: "auto",
    http_request: "ask",
  }
): GovernedPermissionState {
  return {
    folders,
    terminal: { mode, approvalTtlSeconds: 180, dangerousExpiresMinutes: 60 },
    toolPolicy,
  };
}

describe("Schema-v2 Modified-state canonicalization", () => {
  it("treats folder and tool-policy ordering as non-semantic", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-profile-state-"));
    const a = path.join(root, "A");
    const b = path.join(root, "B");
    await fs.mkdir(a);
    await fs.mkdir(b);

    try {
      const applied = state(
        [
          { path: a, alias: "alpha", permission: "read" },
          { path: b, alias: "beta", permission: "readwrite" },
        ],
        "ask",
        { file_read: "auto", http_request: "ask" }
      );
      const current = state(
        [
          { path: b, alias: "beta", permission: "readwrite" },
          { path: a, alias: "alpha", permission: "read" },
        ],
        "ask",
        { http_request: "ask", file_read: "auto" }
      );

      assert.strictEqual(isModifiedFromAppliedSnapshot(applied, current), false);
      assert.deepStrictEqual(diffGovernedState(applied, current), {
        modified: false,
        fields: [],
      });
      assert.strictEqual(
        fingerprintGovernedState(applied),
        fingerprintGovernedState(current)
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores non-governed terminal timing fields and compares terminal.mode only", () => {
    const applied = state([], "ask");
    const current: GovernedPermissionState = {
      folders: [],
      terminal: {
        mode: "ask",
        approvalTtlSeconds: 300,
        dangerousExpiresMinutes: 5,
      },
      toolPolicy: {
        file_read: "auto",
        http_request: "ask",
      },
    };

    assert.strictEqual(isModifiedFromAppliedSnapshot(applied, current), false);
  });

  it("reports a folder permission change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-profile-folder-"));
    try {
      const applied = state([{ path: root, permission: "readwrite" }]);
      const current = state([{ path: root, permission: "read" }]);

      assert.deepStrictEqual(diffGovernedState(applied, current), {
        modified: true,
        fields: ["folders"],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports terminal.mode and toolPolicy independently", () => {
    const applied = state([], "ask", {
      file_read: "auto",
      http_request: "ask",
    });
    const current = state([], "full", {
      file_read: "auto",
      http_request: "off",
    });

    assert.deepStrictEqual(diffGovernedState(applied, current), {
      modified: true,
      fields: ["terminal.mode", "toolPolicy"],
    });
  });

  it("reports tool policy additions and removals", () => {
    const applied = state([], "ask", { file_read: "auto" });
    const added = state([], "ask", {
      file_read: "auto",
      http_request: "ask",
    });
    const removed = state([], "ask", {});

    assert.deepStrictEqual(diffGovernedState(applied, added).fields, [
      "toolPolicy",
    ]);
    assert.deepStrictEqual(diffGovernedState(applied, removed).fields, [
      "toolPolicy",
    ]);
  });

  it("normalizes aliases and canonical paths before comparison", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-profile-canonical-"));
    try {
      const folder = path.join(root, "Folder");
      await fs.mkdir(folder);

      const applied = state([
        { path: path.join(folder, "."), alias: "  workspace  ", permission: "readwrite" },
      ]);
      const current = state([
        { path: folder, alias: "workspace", permission: "readwrite" },
      ]);

      assert.strictEqual(isModifiedFromAppliedSnapshot(applied, current), false);

      if (process.platform === "win32") {
        const caseVariant = state([
          { path: folder.toUpperCase(), alias: "workspace", permission: "readwrite" },
        ]);
        assert.strictEqual(
          isModifiedFromAppliedSnapshot(applied, caseVariant),
          false
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("produces a stable canonical shape containing only governed fields", () => {
    const canonical = canonicalizeGovernedState(
      state(
        [{ path: ".", alias: "here", permission: "read" }],
        "ask",
        { z_tool: "off", a_tool: "auto" }
      )
    );

    assert.deepStrictEqual(Object.keys(canonical), [
      "folders",
      "terminal",
      "toolPolicy",
    ]);
    assert.deepStrictEqual(canonical.terminal, { mode: "ask" });
    assert.deepStrictEqual(Object.keys(canonical.toolPolicy), ["a_tool", "z_tool"]);
  });
});
