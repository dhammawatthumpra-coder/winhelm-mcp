import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getDashboardHtml } from "../../src/gateway/dashboard-html.js";

describe("Dashboard Rendered Script Syntax (UAT-DASH-01)", () => {
  it("should render inline script blocks that are syntactically valid JavaScript", () => {
    const html = getDashboardHtml("full", { schemaMode: "v2" });
    const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];

    assert.ok(scriptMatches.length > 0, "Expected at least one inline <script> block in rendered Dashboard HTML");

    for (let i = 0; i < scriptMatches.length; i++) {
      const scriptCode = scriptMatches[i][1];
      assert.ok(scriptCode.trim().length > 0, `Inline script ${i} should not be empty`);

      // Real JS parser verification using vm.Script and new Function
      assert.doesNotThrow(() => {
        new vm.Script(scriptCode, { filename: `dashboard-rendered-${i}.js` });
      }, `Inline script ${i} failed vm.Script syntax validation`);

      assert.doesNotThrow(() => {
        new Function(scriptCode);
      }, `Inline script ${i} failed new Function syntax validation`);
    }
  });

  it("should preserve expected escape literals without raw line breaks inside string/regex literals", () => {
    const html = getDashboardHtml("full", { schemaMode: "v2" });
    const script = html.match(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/i)?.[1] || "";

    // Pinned literal preservation checks
    assert.match(script, /\.split\(\/\\r\?\\n\/\)/, "Rendered script must contain literal regex /\\r?\\n/");
    assert.match(script, /\.join\('\\n'\)/, "Rendered script must contain literal .join('\\n')");
    assert.match(script, /'\\nApplied successfully\.'/, "Rendered script must contain literal '\\nApplied successfully.'");
    assert.match(script, /'\\nBackup created: '/, "Rendered script must contain literal '\\nBackup created: '");
    assert.match(script, /'\\nReconnect the MCP client/, "Rendered script must contain literal '\\nReconnect the MCP client'");
  });
});
