/**
 * Baseline 5.2 tool-surface lint.
 *
 * Checks the central metadata registry (title, description length, mandated
 * guidance, annotations) and the live zod schemas (parameter descriptions for
 * the exact 41-tool schema-v2 surface). It also reports the tools/list payload
 * size in BYTES; converting bytes into a token count would be a guess, so no
 * token number is printed.
 *
 * Usage: npm run lint:tools
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigManager } from "../src/config/config-manager.js";
import { registerAllTools } from "../src/tools/index.js";
import { ALL_V13_TOOL_NAMES } from "../src/tools/registry.js";
import {
  TOOL_METADATA,
  validateToolMetadataRegistry,
} from "../src/tools/metadata.js";
import { collectParameterDescriptionIssues } from "../src/tools/metadata-lint.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-tool-lint-"));
const configFile = path.join(dir, "config.json");
await fs.writeFile(
  configFile,
  JSON.stringify(
    {
      schemaVersion: 2,
      folders: [],
      terminal: { mode: "off" },
      toolPolicy: {},
    },
    null,
    2
  ),
  "utf8"
);

try {
  const manager = ConfigManager.resetInstance(configFile);
  await manager.init(configFile);

  const server = new McpServer({
    name: "winhelm-tool-lint",
    version: "0.0.0",
  });
  registerAllTools(server);
  const registered = (server as any)._registeredTools as Record<string, any>;

  const issues: string[] = [
    ...validateToolMetadataRegistry(),
    ...collectParameterDescriptionIssues(registered),
  ];

  for (const name of ALL_V13_TOOL_NAMES) {
    if (!registered[name]) {
      issues.push(`tool missing from the schema-v2 surface: ${name}`);
    }
  }

  const payload = ALL_V13_TOOL_NAMES.map((name) => ({
    name,
    title: TOOL_METADATA[name].title,
    description: TOOL_METADATA[name].description,
    annotations: TOOL_METADATA[name].annotations,
  }));

  console.log(`tools checked: ${ALL_V13_TOOL_NAMES.length}`);
  console.log(
    `metadata projection bytes: ${Buffer.byteLength(JSON.stringify(payload), "utf8")} (name/title/description/annotations only; excludes JSON input schemas, which this script does not serialize; bytes, not a token count)`
  );

  if (issues.length > 0) {
    console.error(`tool metadata lint failed with ${issues.length} issue(s):`);
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    process.exitCode = 1;
  } else {
    console.log("tool metadata lint: OK");
  }
} finally {
  ConfigManager.resetInstance();
  await fs.rm(dir, { recursive: true, force: true });
}
