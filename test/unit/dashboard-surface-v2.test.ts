import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, getDashboardHtml } from "../../src/gateway/dashboard-html.js";
import { PROFILES } from "../../src/config/profiles.js";
import { translate } from "../../src/i18n/messages.js";
import {
  ALL_TOOL_NAMES,
  ALL_V13_TOOL_NAMES,
  RECOVERY_TOOL_NAMES,
  SCHEMA_V2_TOOL_NAMES,
} from "../../src/tools/registry.js";

function renderedToolNames(html: string): string[] {
  return [...html.matchAll(/data-tool-name="([^"]+)"/g)].map(
    (match) => match[1]
  );
}

describe("Dashboard canonical tool surface", () => {
  it("renders the schema-v2 surface from the canonical 41-tool registry", () => {
    const html = getDashboardHtml("full", {
      schemaMode: "v2",
      preset: "balanced",
      modified: false,
      terminalMode: "ask",
    });

    assert.ok(html.includes("BALANCED"));
    assert.ok(
      html.includes(`${ALL_V13_TOOL_NAMES.length} SCHEMAS`),
      "schema-v2 header must derive its count from the registry"
    );

    const names = renderedToolNames(html);
    assert.strictEqual(names.length, ALL_V13_TOOL_NAMES.length);
    for (const name of ALL_V13_TOOL_NAMES) {
      assert.ok(names.includes(name), `${name} must be rendered`);
    }

    assert.ok(html.includes("Terminal adapter"));
    assert.ok(html.includes("Recovery tools"));
    // Every v2 schema is exposed, so nothing is greyed out as inactive.
    assert.strictEqual(html.includes('class="tool-item inactive"'), false);
  });

  it("labels command_run with the active terminal mode", () => {
    const ask = getDashboardHtml("full", {
      schemaMode: "v2",
      preset: "balanced",
      terminalMode: "ask",
    });
    assert.ok(
      ask.includes(
        `${SCHEMA_V2_TOOL_NAMES.COMMAND_RUN} · terminal=ask`
      )
    );

    const off = getDashboardHtml("full", {
      schemaMode: "v2",
      preset: "safe",
      terminalMode: "off",
    });
    assert.ok(
      off.includes(
        `${SCHEMA_V2_TOOL_NAMES.COMMAND_RUN} · terminal=off`
      )
    );
  });

  it("keeps the legacy surface at 38 tools plus grouped recovery tools", () => {
    const html = getDashboardHtml("core", { schemaMode: "legacy" });

    const names = renderedToolNames(html);
    assert.strictEqual(
      names.length,
      ALL_TOOL_NAMES.length + RECOVERY_TOOL_NAMES.length
    );
    for (const name of RECOVERY_TOOL_NAMES) {
      assert.ok(names.includes(name), `${name} must be rendered`);
    }

    // command_run is a schema-v2 addition and must not appear in legacy mode.
    assert.strictEqual(names.includes(SCHEMA_V2_TOOL_NAMES.COMMAND_RUN), false);

    const exposedCount =
      PROFILES.core.tools.length + RECOVERY_TOOL_NAMES.length;
    assert.ok(
      html.includes(
        `Registered Tools (${exposedCount} Exposed / ${names.length} Available)`
      ),
      "legacy header must count the active profile plus recovery tools"
    );
    assert.ok(html.includes("Recovery tools"));

    // Profile membership still greys out tools that are not loaded.
    assert.ok(html.includes('class="tool-item inactive"'));
  });

  it("marks an invalid schema-v2 configuration explicitly", () => {
    const html = getDashboardHtml("full", {
      schemaMode: "invalid",
      terminalMode: null,
    });

    assert.ok(
      html.includes(`SCHEMA-V2 INVALID · ${ALL_V13_TOOL_NAMES.length} SCHEMAS`)
    );
    assert.ok(html.includes("Configuration unavailable."));
  });

  it("shows a permanent red banner while full terminal access is active", () => {
    const html = getDashboardHtml("full", {
      schemaMode: "v2",
      preset: "power",
      terminalMode: "full",
    });

    assert.ok(
      html.includes(
        '<div id="runtimeRiskBanner" class="risk-banner danger">'
      )
    );
    // The baseline 7.6 message is the banner text, in the configured locale.
    assert.ok(
      html.includes(escapeHtml(translate("mode.full.warn", {}, "en")))
    );
    assert.match(
      html,
      /banner\.classList\.add\('danger'\);\s*banner\.textContent\s*=\s*DASHBOARD_MESSAGES\.fullWarn;/
    );
  });

  it("discloses a legacy configuration and hides the disclosure under schema-v2", () => {
    const legacy = getDashboardHtml("full", { schemaMode: "legacy" });
    assert.ok(
      legacy.includes(
        'id="legacyConfigBanner" class="risk-banner warning" style="display:block;"'
      ),
      "legacy config must be disclosed visibly"
    );
    assert.ok(
      legacy.includes("Legacy configuration — upgrade available.")
    );
    // The live profile refresh must keep the disclosure in sync.
    assert.match(
      legacy,
      /legacyBanner\.style\.display\s*=\s*profile\.schemaMode === 'legacy' \? 'block' : 'none';/
    );

    const v2 = getDashboardHtml("full", {
      schemaMode: "v2",
      preset: "balanced",
      terminalMode: "ask",
    });
    assert.ok(
      v2.includes(
        'id="legacyConfigBanner" class="risk-banner warning" style="display:none;"'
      )
    );
  });

  it("hides the banner when terminal access is not unrestricted", () => {
    const html = getDashboardHtml("full", {
      schemaMode: "v2",
      preset: "balanced",
      terminalMode: "ask",
    });

    assert.ok(
      html.includes(
        '<div id="runtimeRiskBanner" class="risk-banner" style="display:none;"></div>'
      )
    );
    // The message still lives in the live-update script, but no visible
    // full-access banner may be server-rendered in ask mode.
    assert.strictEqual(
      html.includes(
        `class="risk-banner danger"><strong>${escapeHtml(
          translate("mode.full.warn", {}, "en")
        )}`
      ),
      false
    );
  });
});
