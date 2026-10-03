import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ConfigManager } from "../../src/config/config-manager.js";
import { createServer } from "../../src/gateway/server.js";
import {
  setConfiguredLocale,
  translate,
} from "../../src/i18n/messages.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";

// Ground rules: do NOT bind to 8788; 18791/18792 are used elsewhere.
const TEST_PORT = 18811;

describe("Dashboard locale end to end", () => {
  it("serves the configured locale's baseline messages over HTTP", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "winhelm-dashboard-locale-")
    );
    const configFile = path.join(dir, "config.json");
    await fs.writeFile(
      configFile,
      JSON.stringify(
        {
          schemaVersion: 2,
          folders: [],
          terminal: { mode: "full" },
          toolPolicy: { winhelm_status: "auto" },
          ui: { language: "th" },
        },
        null,
        2
      ),
      "utf8"
    );

    ConfigManager.resetInstance(configFile);
    resetApprovalEngine();
    const instance = createServer({
      port: TEST_PORT,
      host: "127.0.0.1",
    });
    const server = await instance.start();
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(response.status, 200);
      const html = await response.text();

      assert.ok(
        html.includes(translate("mode.full.warn", {}, "th")),
        "the full-access banner must use the configured Thai message"
      );
      assert.ok(
        html.includes(translate("confirm.type", {}, "th").replace(/"/g, "&quot;")),
        "the typed-confirmation hint must use the configured Thai message"
      );
      assert.strictEqual(
        html.includes(translate("mode.full.warn", {}, "en")),
        false
      );
    } finally {
      await instance.stop(server);
      await fs.rm(dir, { recursive: true, force: true });
      ConfigManager.resetInstance();
      resetApprovalEngine();
      setConfiguredLocale(undefined);
    }
  });
});
