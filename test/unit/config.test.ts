import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigManager } from "../../src/config/config-manager.js";

describe("ConfigManager and Security Policy", () => {
  const configManager = ConfigManager.getInstance();

  it("should have default config initialized", () => {
    const config = configManager.getConfig();
    assert.ok(Array.isArray(config.blockedCommands));
    assert.ok(config.fileReadLineLimit > 0);
  });

  it("should block dangerous system commands", () => {
    const testCases = [
      "Format-Volume -DriveLetter C",
      "format-disk -Number 0",
      "clear-disk -Number 1",
      "Stop-Computer -Force",
      "rmdir /s /q C:\\",
      "del /f /s /q c:\\",
    ];

    for (const cmd of testCases) {
      const res = configManager.isCommandAllowed(cmd);
      assert.strictEqual(res.allowed, false, `Expected "${cmd}" to be blocked`);
      assert.ok(res.reason?.includes("blocked pattern"));
    }
  });

  it("should allow safe commands", () => {
    const safeCommands = [
      "Get-Process",
      "Get-ChildItem -Path .",
      'Write-Output "Hello World"',
      "git status",
    ];

    for (const cmd of safeCommands) {
      const res = configManager.isCommandAllowed(cmd);
      assert.strictEqual(res.allowed, true, `Expected "${cmd}" to be allowed`);
    }
  });

  it("should block paths when allowedDirectories is empty (fail-closed by default)", async () => {
    await configManager.updateConfig({ allowedDirectories: [] }, false);
    const check = configManager.isPathAllowed("C:\\AnyPath\\file.txt");
    assert.strictEqual(check.allowed, false);
    assert.ok(check.reason?.includes("no allowedDirectories configured"));
  });

  it("should allow paths when allowedDirectories has wildcard '*'", async () => {
    await configManager.updateConfig({ allowedDirectories: ["*"] }, false);
    const checkC = configManager.isPathAllowed("C:\\AnyPath\\file.txt");
    const checkD = configManager.isPathAllowed("D:\\AnyPath\\file.txt");
    assert.strictEqual(checkC.allowed, true);
    assert.strictEqual(checkD.allowed, true);
  });

  it("should allow paths when allowedDirectories has case-insensitive 'all'", async () => {
    for (const val of ["all", "ALL", "All", "  all  "]) {
      await configManager.updateConfig({ allowedDirectories: [val] }, false);
      assert.strictEqual(configManager.isPathAllowed("C:\\test.txt").allowed, true);
      assert.strictEqual(configManager.isPathAllowed("D:\\test.txt").allowed, true);
    }
    await configManager.updateConfig({ allowedDirectories: ["*"] }, false);
  });

  it("should allow multiple specific drives like D: and F: while blocking C:, E:, W:", async () => {
    const initialConfig = { ...configManager.getConfig() };

    // Configure strictly D: and F: in memory (persist=false) with allowSystemExecution = true
    await configManager.updateConfig(
      { allowedDirectories: ["D:", "F:"], allowSystemExecution: true },
      false
    );

    // Filesystem path validation: C:, E:, W: MUST BE BLOCKED
    assert.strictEqual(configManager.isPathAllowed("D:\\mcp\\file.txt").allowed, true);
    assert.strictEqual(configManager.isPathAllowed("F:\\projects\\app.js").allowed, true);
    assert.strictEqual(configManager.isPathAllowed("C:\\Windows\\system32").allowed, false);
    assert.strictEqual(configManager.isPathAllowed("E:\\games").allowed, false);
    assert.strictEqual(configManager.isPathAllowed("W:\\network_share").allowed, false);

    // Command validation when allowSystemExecution: true (permits runtime tools on C:)
    assert.strictEqual(configManager.isCommandAllowed("Get-ChildItem -Path D:\\").allowed, true);
    assert.strictEqual(configManager.isCommandAllowed("python -m venv .venv").allowed, true);
    assert.strictEqual(configManager.isCommandAllowed("pip install fastapi").allowed, true);
    // Destructive commands on C: must ALWAYS be blocked
    assert.strictEqual(configManager.isCommandAllowed("rmdir /s /q C:\\").allowed, false);
    assert.strictEqual(configManager.isCommandAllowed("Format-Volume -DriveLetter C").allowed, false);

    // When allowSystemExecution is explicitly false: commands targeting unallowed drives are blocked
    await configManager.updateConfig({ allowSystemExecution: false }, false);
    assert.strictEqual(configManager.isCommandAllowed("dir C:\\Windows").allowed, false);
    assert.strictEqual(configManager.isCommandAllowed("type E:\\secret.txt").allowed, false);
    assert.strictEqual(configManager.isCommandAllowed("dir D:\\").allowed, true);

    // Restore initial config in memory
    await configManager.updateConfig(initialConfig, false);
  });

  it("should block dangerous commands matching SECURITY.md regex patterns (Option A)", () => {
    const dangerousCommands = [
      "reg delete HKLM\\Software\\Test",
      "reg.exe delete HKLM\\System /f",
      "diskpart",
      "diskpart.exe /s script.txt",
      "initialize-disk -Number 1",
      "clear-disk -Number 0",
      "bcdedit /set {default} recoveryenabled No",
      "bootrec /fixmbr",
      "net user hacker Password123 /add",
      "takeown /f C:\\Windows\\System32",
      "icacls C:\\Windows /grant Everyone:F",
      "mimikatz privilege::debug",
      "procdump.exe -ma lsass.exe lsass.dmp",
      "rundll32.exe C:\\windows\\System32\\comsvcs.dll, MiniDump",
    ];

    for (const cmd of dangerousCommands) {
      const res = configManager.isCommandAllowed(cmd);
      assert.strictEqual(res.allowed, false, `Expected dangerous command "${cmd}" to be blocked`);
      assert.ok(res.reason?.includes("blocked") || res.reason?.includes("dangerous"));
    }
  });

  it("should load configuration from a custom config path (--config)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const tmpDir = path.resolve("./test_scratch_config");
    await fs.mkdir(tmpDir, { recursive: true });

    const customConfigFile = path.join(tmpDir, "custom-project.json");
    await fs.writeFile(
      customConfigFile,
      JSON.stringify({
        allowedDirectories: ["D:\\custom-project"],
        profile: "core",
        authToken: "custom-token-xyz",
      }),
      "utf-8"
    );

    const customManager = ConfigManager.resetInstance(customConfigFile);
    await customManager.init(customConfigFile);

    const cfg = customManager.getConfig();
    assert.deepStrictEqual(cfg.allowedDirectories, ["D:\\custom-project"]);
    assert.strictEqual(cfg.profile, "core");
    assert.strictEqual(cfg.authToken, "custom-token-xyz");
    assert.strictEqual(customManager.getConfigFilePath(), customConfigFile);

    // Clean up
    await fs.rm(tmpDir, { recursive: true, force: true });
    // Reset to default
    ConfigManager.resetInstance();
  });

  it("should not persist in-memory overrides when persist=false (non-persistence test)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const crypto = await import("node:crypto");
    const tmpDir = path.resolve("./test_scratch_persist");
    await fs.mkdir(tmpDir, { recursive: true });

    const testConfigFile = path.join(tmpDir, "static-config.json");
    const originalContent = JSON.stringify({
      allowedDirectories: ["D:\\original"],
      profile: "minimal",
    }, null, 2);
    await fs.writeFile(testConfigFile, originalContent, "utf-8");

    const hashBefore = crypto.createHash("sha256").update(originalContent).digest("hex");

    const manager = ConfigManager.resetInstance(testConfigFile);
    await manager.init(testConfigFile);

    // Update in-memory with persist = false
    await manager.updateConfig({ allowedDirectories: ["D:\\overridden-in-memory"], profile: "dev" }, false);

    // Manager memory reflects new values
    assert.deepStrictEqual(manager.getConfig().allowedDirectories, ["D:\\overridden-in-memory"]);
    assert.strictEqual(manager.getConfig().profile, "dev");

    // File on disk remains completely untouched
    const contentAfter = await fs.readFile(testConfigFile, "utf-8");
    const hashAfter = crypto.createHash("sha256").update(contentAfter).digest("hex");
    assert.strictEqual(hashBefore, hashAfter, "Config file on disk was modified when persist=false!");

    // Clean up
    await fs.rm(tmpDir, { recursive: true, force: true });
    ConfigManager.resetInstance();
  });

  it("should maintain multi-instance isolation across distinct config files", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const tmpDir = path.resolve("./test_scratch_multi");
    await fs.mkdir(tmpDir, { recursive: true });

    const configPathA = path.join(tmpDir, "project-a.json");
    const configPathB = path.join(tmpDir, "project-b.json");

    await fs.writeFile(configPathA, JSON.stringify({ allowedDirectories: ["D:\\project-a"], profile: "dev" }), "utf-8");
    await fs.writeFile(configPathB, JSON.stringify({ allowedDirectories: ["D:\\project-b"], profile: "minimal" }), "utf-8");

    const instanceA = ConfigManager.resetInstance(configPathA);
    await instanceA.init(configPathA);
    assert.deepStrictEqual(instanceA.getConfig().allowedDirectories, ["D:\\project-a"]);
    assert.strictEqual(instanceA.getConfig().profile, "dev");

    const instanceB = ConfigManager.resetInstance(configPathB);
    await instanceB.init(configPathB);
    assert.deepStrictEqual(instanceB.getConfig().allowedDirectories, ["D:\\project-b"]);
    assert.strictEqual(instanceB.getConfig().profile, "minimal");

    // Clean up
    await fs.rm(tmpDir, { recursive: true, force: true });
    ConfigManager.resetInstance();
  });

  it("should have start.ps1 default to 127.0.0.1 and block non-loopback bindings without auth", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { execSync } = await import("node:child_process");

    const startPs1Path = path.resolve("./start.ps1");
    const content = await fs.readFile(startPs1Path, "utf-8");

    // 1. Verify default parameter is 127.0.0.1
    assert.match(content, /\[string\]\$HostAddr\s*=\s*["']127\.0\.0\.1["']/);

    // 2. Verify security gate exists
    assert.match(content, /\$isLoopback\s*=/);
    assert.match(content, /SECURITY ERROR.*Binding to non-loopback host/);

    // 3. Execute powershell test without auth -> must exit 1
    try {
      execSync("powershell.exe -ExecutionPolicy Bypass -File .\\start.ps1 -HostAddr 0.0.0.0 -Config .\\winhelm.config.json", {
        stdio: "pipe",
        env: { ...process.env, MCP_AUTH_TOKEN: "" },
      });
      assert.fail("Expected start.ps1 with 0.0.0.0 and no auth to exit with non-zero code");
    } catch (err: any) {
      assert.strictEqual(err.status, 1);
      const output = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
      assert.ok(output.includes("SECURITY ERROR"));
    }
  });

  it("should have allowSystemExecution default to false and respect WINHELM_ALLOW_SYSTEM_EXEC env var", async () => {
    const { DEFAULT_CONFIG } = await import("../../src/config/default-config.js");
    assert.strictEqual(DEFAULT_CONFIG.allowSystemExecution, false, "DEFAULT_CONFIG.allowSystemExecution must be false (fail-closed)");

    // Test env variable WINHELM_ALLOW_SYSTEM_EXEC=true
    const origEnv = process.env.WINHELM_ALLOW_SYSTEM_EXEC;
    const origMcpEnv = process.env.MCP_ALLOW_SYSTEM_EXEC;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnings.push(args.join(" "));
      origWarn(...args);
    };

    try {
      process.env.WINHELM_ALLOW_SYSTEM_EXEC = "true";
      delete process.env.MCP_ALLOW_SYSTEM_EXEC;

      const testManager = ConfigManager.resetInstance();
      await testManager.init();
      assert.strictEqual(testManager.getConfig().allowSystemExecution, true);
      assert.ok(warnings.some((w) => w.includes("System execution enabled - Runtime binaries on C: are now accessible")));

      // Test with env var false / disabled
      process.env.WINHELM_ALLOW_SYSTEM_EXEC = "false";
      warnings.length = 0;
      const testManager2 = ConfigManager.resetInstance();
      await testManager2.init();
      assert.strictEqual(testManager2.getConfig().allowSystemExecution, false);

      // Test with MCP_ALLOW_SYSTEM_EXEC=true
      delete process.env.WINHELM_ALLOW_SYSTEM_EXEC;
      process.env.MCP_ALLOW_SYSTEM_EXEC = "true";
      warnings.length = 0;
      const testManager3 = ConfigManager.resetInstance();
      await testManager3.init();
      assert.strictEqual(testManager3.getConfig().allowSystemExecution, true);
    } finally {
      console.warn = origWarn;
      if (origEnv !== undefined) process.env.WINHELM_ALLOW_SYSTEM_EXEC = origEnv;
      else delete process.env.WINHELM_ALLOW_SYSTEM_EXEC;
      if (origMcpEnv !== undefined) process.env.MCP_ALLOW_SYSTEM_EXEC = origMcpEnv;
      else delete process.env.MCP_ALLOW_SYSTEM_EXEC;
      ConfigManager.resetInstance();
    }
  });
});
