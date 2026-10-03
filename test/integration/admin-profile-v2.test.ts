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

describe("Admin profile/permissions API", () => {
  it("previews and applies presets through the isolated admin plane", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-admin-profile-")
    );
    const workspace = path.join(root, "workspace");
    const configFile = path.join(root, "winhelm.config.json");
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
      const exchange = await fetch(`${base}/admin/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ code: issued.code }),
      });
      assert.strictEqual(exchange.status, 200);
      const adminCookie = cookiePair(
        exchange.headers.get("set-cookie")
      );
      const exchangeBody = await exchange.json() as any;
      const csrf = exchangeBody.csrfToken as string;
      assert.ok(csrf);

      const initial = await fetch(`${base}/admin/profile`, {
        headers: { Cookie: adminCookie },
      });
      assert.strictEqual(initial.status, 200);
      const initialBody = await initial.json() as any;
      assert.strictEqual(initialBody.profile.schemaMode, "legacy");
      assert.strictEqual(initialBody.legacy.profile, "core");

      const preview = await fetch(
        `${base}/admin/profiles/preview`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
          body: JSON.stringify({
            preset: "balanced",
            folders: [
              { path: workspace, alias: "workspace" },
            ],
          }),
        }
      );
      assert.strictEqual(preview.status, 200);
      const previewBody = await preview.json() as any;
      assert.strictEqual(
        previewBody.preview.terminalMode,
        "ask"
      );
      assert.deepStrictEqual(
        previewBody.preview.changedFields,
        ["folders", "terminal.mode", "toolPolicy"]
      );

      const missingCsrf = await fetch(
        `${base}/admin/profiles/apply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
          },
          body: JSON.stringify({
            preset: "balanced",
            folders: [{ path: workspace }],
          }),
        }
      );
      assert.strictEqual(missingCsrf.status, 403);

      const applied = await fetch(
        `${base}/admin/profiles/apply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
          body: JSON.stringify({
            preset: "balanced",
            folders: [
              { path: workspace, alias: "workspace" },
            ],
          }),
        }
      );
      assert.strictEqual(applied.status, 200);
      const appliedBody = await applied.json() as any;
      assert.strictEqual(appliedBody.success, true);
      assert.strictEqual(
        appliedBody.profile.schemaMode,
        "v2"
      );
      assert.strictEqual(
        appliedBody.profile.preset,
        "balanced"
      );
      assert.strictEqual(
        appliedBody.profile.modified,
        false
      );
      assert.ok(appliedBody.backupPath);

      const persisted = JSON.parse(
        await fs.readFile(configFile, "utf8")
      );
      assert.strictEqual(persisted.schemaVersion, 2);
      assert.strictEqual(persisted.profilePreset, "balanced");

      const powerWithoutConfirm = await fetch(
        `${base}/admin/profiles/apply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
          body: JSON.stringify({
            preset: "power",
            folders: [{ path: workspace }],
          }),
        }
      );
      assert.strictEqual(powerWithoutConfirm.status, 409);
      const powerRejected = await powerWithoutConfirm.json() as any;
      assert.strictEqual(
        powerRejected.error.code,
        "TYPED_CONFIRMATION_REQUIRED"
      );

      const power = await fetch(
        `${base}/admin/profiles/apply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: adminCookie,
            Origin: base,
            "x-winhelm-csrf": csrf,
          },
          body: JSON.stringify({
            preset: "power",
            folders: [{ path: workspace }],
            confirmation: "confirm",
          }),
        }
      );
      assert.strictEqual(power.status, 200);
      const powerBody = await power.json() as any;
      assert.strictEqual(
        powerBody.profile.terminalMode,
        "full"
      );
      assert.strictEqual(powerBody.profile.preset, "power");

      const finalStatus = await fetch(
        `${base}/admin/profile`,
        { headers: { Cookie: adminCookie } }
      );
      assert.strictEqual(finalStatus.status, 200);
      const finalBody = await finalStatus.json() as any;
      assert.strictEqual(finalBody.profile.schemaMode, "v2");
      assert.strictEqual(finalBody.profile.modified, false);
      assert.strictEqual(finalBody.legacy, null);
    } finally {
      await instance.stop(server);
      ConfigManager.resetInstance();
      resetAdminAuthManager();
      resetApprovalEngine();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
