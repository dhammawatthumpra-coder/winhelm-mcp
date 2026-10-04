import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetupCliCommand } from "../../src/cli/setup.js";
import { ConfigManager } from "../../src/config/config-manager.js";
import { getProfileStatus } from "../../src/config/profile-service.js";
import {
  logPermissionChange,
} from "../../src/config/permission-audit.js";
import { auditLogger, type AuditEvent } from "../../src/utils/audit-logger.js";

async function withAuditSpy<T>(
  fn: (events: AuditEvent[]) => Promise<T> | T
): Promise<T> {
  const events: AuditEvent[] = [];
  const original = auditLogger.log.bind(auditLogger);
  (auditLogger as any).log = (event: AuditEvent) => {
    events.push(event);
  };
  try {
    return await fn(events);
  } finally {
    (auditLogger as any).log = original;
  }
}

async function withTempDir(
  prefix: string,
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    ConfigManager.resetInstance();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("Permission change audit", () => {
  it("audits a CLI preset apply with from -> to and the cli channel", async () => {
    await withTempDir("winhelm-cli-audit-", async (dir) => {
      const configFile = path.join(dir, "config.json");
      const answersFile = path.join(dir, "answers.json");
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
      await fs.writeFile(
        answersFile,
        JSON.stringify({ preset: "balanced", folders: [] }, null, 2),
        "utf8"
      );

      await withAuditSpy(async (events) => {
        const result = await runSetupCliCommand([
          "setup",
          "--config",
          configFile,
          "--answers",
          answersFile,
          "--confirm",
          "confirm",
          "--yes",
        ]);
        assert.strictEqual(result.handled, true);
        assert.strictEqual(
          result.exitCode,
          0,
          `setup failed: ${result.error ?? result.output ?? ""}`
        );

        assert.strictEqual(events.length, 1);
        const event = events[0];
        assert.strictEqual(event.event, "PROFILE_PRESET_APPLIED");
        assert.strictEqual(event.outcome, "ALLOWED");
        assert.strictEqual(event.action, "winhelm setup");

        const details = event.details as Record<string, any>;
        assert.strictEqual(details.channel, "cli");
        assert.strictEqual(details.from.schemaMode, "v2");
        assert.strictEqual(details.from.preset, null);
        assert.strictEqual(details.to.preset, "balanced");
        assert.strictEqual(details.to.terminalMode, "ask");
        assert.strictEqual(details.to.approvalMode, "smart");
        assert.strictEqual(typeof details.backupCreated, "boolean");
        assert.strictEqual(
          JSON.stringify(event).includes("authToken"),
          false,
          "no credential material may reach the audit log"
        );
      });
    });
  });

  it("audits a CLI legacy migration with the cli channel", async () => {
    await withTempDir("winhelm-cli-migrate-", async (dir) => {
      const folderDir = path.join(dir, "workspace");
      await fs.mkdir(folderDir, { recursive: true });
      const configFile = path.join(dir, "config.json");
      await fs.writeFile(
        configFile,
        JSON.stringify(
          {
            allowedDirectories: [folderDir],
            profile: "full",
            readOnly: false,
          },
          null,
          2
        ),
        "utf8"
      );

      await withAuditSpy(async (events) => {
        const result = await runSetupCliCommand([
          "setup",
          "--config",
          configFile,
          "--migrate-legacy",
          "--folder",
          folderDir,
          "--yes",
        ]);
        assert.strictEqual(result.handled, true);
        assert.strictEqual(
          result.exitCode,
          0,
          `migration failed: ${result.error ?? result.output ?? ""}`
        );

        assert.strictEqual(events.length, 1);
        const event = events[0];
        assert.strictEqual(event.event, "LEGACY_MIGRATION_APPLIED");
        const details = event.details as Record<string, any>;
        assert.strictEqual(details.channel, "cli");
        assert.strictEqual(details.from.schemaMode, "legacy");
        assert.strictEqual(details.to.schemaMode, "v2");
        assert.strictEqual(typeof details.backupCreated, "boolean");
      });
    });
  });

  it("does not audit a dry run, because nothing changed", async () => {
    await withTempDir("winhelm-cli-dryrun-", async (dir) => {
      const configFile = path.join(dir, "config.json");
      const answersFile = path.join(dir, "answers.json");
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
      await fs.writeFile(
        answersFile,
        JSON.stringify({ preset: "balanced", folders: [] }, null, 2),
        "utf8"
      );

      await withAuditSpy(async (events) => {
        const result = await runSetupCliCommand([
          "setup",
          "--config",
          configFile,
          "--answers",
          answersFile,
          "--dry-run",
        ]);
        assert.strictEqual(
          result.exitCode,
          0,
          `dry run failed: ${result.error ?? result.output ?? ""}`
        );
        assert.match(result.output ?? "", /Dry run only/);
        assert.deepStrictEqual(events, []);
      });
    });
  });

  it("labels the dashboard channel through the same helper", async () => {
    await withTempDir("winhelm-cli-dashboard-", async (dir) => {
      const configFile = path.join(dir, "config.json");
      await fs.writeFile(
        configFile,
        JSON.stringify({
          schemaVersion: 2,
          folders: [],
          terminal: { mode: "off" },
          toolPolicy: {},
        }),
        "utf8"
      );
      const manager = ConfigManager.resetInstance(configFile);
      await manager.init(configFile);
      const status = getProfileStatus(manager);

      await withAuditSpy(async (events) => {
        logPermissionChange({
          event: "PROFILE_PRESET_APPLIED",
          channel: "dashboard",
          action: "POST /admin/profiles/apply",
          from: status,
          to: status,
          ip: "127.0.0.1",
          sessionId: "admin-session-id",
        });

        assert.strictEqual(events.length, 1);
        const details = events[0].details as Record<string, any>;
        assert.strictEqual(details.channel, "dashboard");
        assert.strictEqual(events[0].actor.ip, "127.0.0.1");
        assert.strictEqual(events[0].actor.authType, "session_cookie");
        assert.strictEqual(events[0].actor.sessionId, "admin-session-id");
      });
    });
  });
});
