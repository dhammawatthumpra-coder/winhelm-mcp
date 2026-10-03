import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ConfigManager } from "../../src/config/config-manager.js";
import { createServer } from "../../src/gateway/server.js";
import {
  getAdminAuthManager,
  resetAdminAuthManager,
} from "../../src/admin/runtime.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";

function cookiePair(setCookie: string | null): string {
  assert.ok(setCookie, "Expected Set-Cookie header");
  return setCookie.split(";")[0];
}

describe("Admin legacy migration API", () => {
  it("previews blocked wildcard migration and applies only after explicit folders + CSRF", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-admin-migration-")
    );
    const workspace = path.join(root, "workspace");
    const configFile = path.join(root, "winhelm.config.json");
    await fs.mkdir(workspace);
    await fs.writeFile(
      configFile,
      JSON.stringify(
        {
          profile: "full",
          allowedDirectories: ["*"],
        },
        null,
        2
      ),
      "utf8"
    );

    ConfigManager.resetInstance(configFile);
    resetAdminAuthManager();
    resetApprovalEngine();

    const instance = createServer({
      port: 0,
      host: "127.0.0.1",
      authToken: "mcp-secret",
    });
    const server = await instance.start();
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const issued = getAdminAuthManager().issueCode();
      const exchange = await fetch(
        `${base}/admin/auth/exchange`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: base,
          },
          body: JSON.stringify({ code: issued.code }),
        }
      );
      assert.strictEqual(exchange.status, 200);
      const adminCookie = cookiePair(
        exchange.headers.get("set-cookie")
      );
      const exchangeBody = (await exchange.json()) as any;
      const csrf = exchangeBody.csrfToken as string;
      assert.ok(csrf);

      const initial = await fetch(
        `${base}/admin/migration`,
        { headers: { Cookie: adminCookie } }
      );
      assert.strictEqual(initial.status, 200);
      const initialBody = (await initial.json()) as any;
      assert.strictEqual(
        initialBody.migration.status,
        "folder-selection-required"
      );
      assert.strictEqual(
        initialBody.migration.candidate,
        null
      );

      const missingCsrfPreview = await fetch(
        `${base}/admin/migration/preview`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
          },
          body: JSON.stringify({
            folders: [{ path: workspace }],
          }),
        }
      );
      assert.strictEqual(missingCsrfPreview.status, 403);

      const preview = await fetch(
        `${base}/admin/migration/preview`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
          body: JSON.stringify({
            folders: [
              { path: workspace, alias: "workspace" },
            ],
          }),
        }
      );
      assert.strictEqual(preview.status, 200);
      const previewBody = (await preview.json()) as any;
      assert.strictEqual(
        previewBody.migration.status,
        "ready"
      );
      assert.strictEqual(
        previewBody.migration.candidate.profilePreset,
        "full"
      );
      assert.strictEqual(
        previewBody.migration.candidate.terminal.mode,
        "ask"
      );
      assert.strictEqual(
        previewBody.migration.candidate.folders[0].alias,
        "workspace"
      );

      const missingCsrfApply = await fetch(
        `${base}/admin/migration/apply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
          },
          body: JSON.stringify({
            folders: [{ path: workspace }],
          }),
        }
      );
      assert.strictEqual(missingCsrfApply.status, 403);

      const applied = await fetch(
        `${base}/admin/migration/apply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
          body: JSON.stringify({
            folders: [
              { path: workspace, alias: "workspace" },
            ],
          }),
        }
      );
      assert.strictEqual(applied.status, 200);
      const appliedBody = (await applied.json()) as any;
      assert.strictEqual(appliedBody.success, true);
      assert.strictEqual(
        appliedBody.profile.schemaMode,
        "v2"
      );
      assert.strictEqual(appliedBody.profile.preset, "full");
      assert.strictEqual(appliedBody.profile.modified, true);
      assert.deepStrictEqual(
        appliedBody.profile.modifiedFields,
        ["terminal.mode"]
      );
      assert.ok(appliedBody.backupPath);
      assert.strictEqual(
        await fs.stat(appliedBody.backupPath).then(() => true),
        true
      );

      const persisted = JSON.parse(
        await fs.readFile(configFile, "utf8")
      );
      assert.strictEqual(persisted.schemaVersion, 2);
      assert.strictEqual(persisted.profilePreset, "full");
      assert.strictEqual(persisted.terminal.mode, "ask");
      assert.strictEqual(
        persisted.folders[0].alias,
        "workspace"
      );

      const repeated = await fetch(
        `${base}/admin/migration/apply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
          body: JSON.stringify({
            folders: [{ path: workspace }],
          }),
        }
      );
      assert.strictEqual(repeated.status, 409);
      const repeatedBody = (await repeated.json()) as any;
      assert.strictEqual(
        repeatedBody.error.code,
        "MIGRATION_NOT_AVAILABLE"
      );
    } finally {
      await instance.stop(server);
      ConfigManager.resetInstance();
      resetAdminAuthManager();
      resetApprovalEngine();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
