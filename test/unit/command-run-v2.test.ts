import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSafePackageManagerPlan,
  resolveSafePackageManager,
} from "../../src/engine/command-runner.js";
import {
  evaluateSchemaV2ToolAccess,
} from "../../src/permissions/tool-access.js";
import type {
  FolderPermission,
  SchemaV2PermissionConfig,
  TerminalMode,
} from "../../src/config/schema-v2.js";

async function fixtureRoot(): Promise<{
  root: string;
  cwd: string;
  node: string;
  npmCli: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-command-run-"));
  const cwd = path.join(root, "workspace");
  const nodeRoot = path.join(root, "trusted-node");
  const node = path.join(nodeRoot, "node.exe");
  const npmCli = path.join(
    nodeRoot,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );

  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.dirname(npmCli), { recursive: true });
  await fs.writeFile(node, "fixture", "utf8");
  await fs.writeFile(npmCli, "fixture", "utf8");

  return { root, cwd, node, npmCli };
}

function config(
  mode: TerminalMode,
  folders: FolderPermission[]
): SchemaV2PermissionConfig {
  return {
    schemaVersion: 2,
    folders,
    terminal: { mode },
    toolPolicy: {},
    approval: {
      channels: ["dashboard", "toast"],
      blockHoldMs: 60_000,
      jobTtlMs: 180_000,
      maxPending: 5,
    },
    network: { allowLoopback: false },
  };
}

describe("Safe command_run package-manager adapter", () => {
  it("resolves npm to trusted node.exe + npm-cli.js and injects --ignore-scripts", async () => {
    const f = await fixtureRoot();
    try {
      const plan = buildSafePackageManagerPlan(
        "npm",
        ["install", "left-pad"],
        f.cwd,
        {
          nodeExecutable: f.node,
          pathEnv: "",
          platform: "win32",
        }
      );

      assert.strictEqual(plan.adapter, "npm");
      assert.strictEqual(plan.executable, await fs.realpath(f.node));
      assert.deepStrictEqual(plan.args, [
        await fs.realpath(f.npmCli),
        "install",
        "left-pad",
        "--ignore-scripts",
      ]);
      assert.strictEqual(plan.operation, "install");
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("does not add --ignore-scripts to a pure version query", async () => {
    const f = await fixtureRoot();
    try {
      const plan = buildSafePackageManagerPlan(
        "npm",
        ["--version"],
        f.cwd,
        {
          nodeExecutable: f.node,
          pathEnv: "",
          platform: "win32",
        }
      );

      assert.deepStrictEqual(plan.args, [
        await fs.realpath(f.npmCli),
        "--version",
      ]);
      assert.strictEqual(plan.operation, "version");
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects global/prefix/workspace overrides and attempts to disable ignore-scripts", async () => {
    const f = await fixtureRoot();
    try {
      for (const args of [
        ["install", "-g", "pkg"],
        ["install", "--global", "pkg"],
        ["install", "--prefix=C:\\outside", "pkg"],
        ["install", "--workspace=other", "pkg"],
        ["install", "--ignore-scripts=false", "pkg"],
      ]) {
        assert.throws(
          () =>
            buildSafePackageManagerPlan("npm", args, f.cwd, {
              nodeExecutable: f.node,
              pathEnv: "",
              platform: "win32",
            }),
          /rejected|ignore-scripts/i,
          args.join(" ")
        );
      }
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects arbitrary commands, executable paths, shell metacharacters, and non-install subcommands", async () => {
    const f = await fixtureRoot();
    try {
      assert.throws(
        () =>
          resolveSafePackageManager("git", {
            nodeExecutable: f.node,
            pathEnv: "",
            cwd: f.cwd,
            platform: "win32",
          }),
        /npm, pnpm, yarn, or bun/i
      );

      assert.throws(
        () =>
          resolveSafePackageManager("C:\\Tools\\npm.exe", {
            nodeExecutable: f.node,
            pathEnv: "",
            cwd: f.cwd,
            platform: "win32",
          }),
        /does not accept executable paths/i
      );

      assert.throws(
        () =>
          buildSafePackageManagerPlan(
            "npm",
            ["install", "pkg;whoami"],
            f.cwd,
            {
              nodeExecutable: f.node,
              pathEnv: "",
              platform: "win32",
            }
          ),
        /metacharacters/i
      );

      assert.throws(
        () =>
          buildSafePackageManagerPlan(
            "npm",
            ["run", "build"],
            f.cwd,
            {
              nodeExecutable: f.node,
              pathEnv: "",
              platform: "win32",
            }
          ),
        /version checks and install operations/i
      );
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("never resolves a project-local executable from cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-command-shadow-"));
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "npm.exe"), "shadow", "utf8");
    const missingNode = path.join(root, "missing", "node.exe");

    try {
      assert.throws(
        () =>
          resolveSafePackageManager("npm", {
            nodeExecutable: missingNode,
            pathEnv: cwd,
            cwd,
            platform: "win32",
          }),
        /could not be resolved/i
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves bun.exe only from trusted PATH entries outside cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-command-bun-"));
    const cwd = path.join(root, "workspace");
    const trusted = path.join(root, "trusted");
    const bun = path.join(trusted, "bun.exe");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(trusted, { recursive: true });
    await fs.writeFile(bun, "fixture", "utf8");

    try {
      const plan = resolveSafePackageManager("bun", {
        nodeExecutable: path.join(root, "missing-node.exe"),
        pathEnv: trusted,
        cwd,
        platform: "win32",
      });
      assert.strictEqual(plan.executable, await fs.realpath(bun));
      assert.strictEqual(plan.adapter, "bun");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("command_run terminal-mode policy", () => {
  it("allows Safe only with an explicit readwrite cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-command-policy-"));
    try {
      const readwrite = config("safe", [
        { path: root, permission: "readwrite" },
      ]);
      const readOnly = config("safe", [
        { path: root, permission: "read" },
      ]);

      assert.strictEqual(
        evaluateSchemaV2ToolAccess(
          "command_run",
          { command: "npm", args: ["--version"], cwd: root },
          readwrite
        ).decision,
        "allow"
      );

      const missing = evaluateSchemaV2ToolAccess(
        "command_run",
        { command: "npm", args: ["--version"] },
        readwrite
      );
      assert.strictEqual(missing.decision, "deny");
      assert.strictEqual(missing.code, "SAFE_CWD_REQUIRED");

      const denied = evaluateSchemaV2ToolAccess(
        "command_run",
        { command: "npm", args: ["--version"], cwd: root },
        readOnly
      );
      assert.strictEqual(denied.decision, "deny");
      assert.strictEqual(denied.code, "FOLDER_READ_ONLY");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("maps ask/full/off modes without consulting toolPolicy", () => {
    assert.strictEqual(
      evaluateSchemaV2ToolAccess(
        "command_run",
        { command: "node", args: ["--version"] },
        config("ask", [])
      ).decision,
      "ask"
    );

    assert.strictEqual(
      evaluateSchemaV2ToolAccess(
        "command_run",
        { command: "node", args: ["--version"] },
        config("full", [])
      ).decision,
      "allow"
    );

    const dangerous = evaluateSchemaV2ToolAccess(
      "command_run",
      { command: "node", args: ["--version"] },
      config("dangerous", [])
    );
    assert.strictEqual(dangerous.decision, "deny");
    assert.strictEqual(dangerous.code, "TERMINAL_MODE_REQUIRED");

    const off = evaluateSchemaV2ToolAccess(
      "command_run",
      { command: "node", args: ["--version"] },
      config("off", [])
    );
    assert.strictEqual(off.decision, "deny");
    assert.strictEqual(off.code, "TERMINAL_MODE_REQUIRED");
  });
});
