import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getControlRegistryDir,
  LocalControlServer,
  type ControlMetadata,
} from "../../src/cli/control-server.js";
import { sendControlCommand } from "../../src/cli/control-client.js";
import { resetApprovalEngine } from "../../src/approval/runtime.js";
import { resetAdminAuthManager } from "../../src/admin/runtime.js";

function registryName(instanceId: string): string {
  return (
    crypto
      .createHash("sha256")
      .update(instanceId, "utf8")
      .digest("hex") + ".json"
  );
}

async function writeRecord(
  registryDir: string,
  filename: string,
  record: unknown
): Promise<void> {
  await fs.writeFile(
    path.join(registryDir, filename),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

async function withPoisonedPrimary(
  run: (ctx: {
    metadataPath: string;
    registryDir: string;
    live: ControlMetadata;
  }) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "winhelm-control-registry-validation-")
  );
  const metadataPath = path.join(dir, "control.json");
  const server = new LocalControlServer({
    metadataPath,
    instanceId: "validation-live-instance",
  });
  resetApprovalEngine();
  resetAdminAuthManager();

  try {
    const live = await server.start();
    const registryDir = getControlRegistryDir(metadataPath);

    // Force the client to leave the primary pointer and inspect registry
    // candidates. Keep PID live so this is a transport failure, not a
    // dead-PID shortcut.
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          pipeName: `\\\\.\\pipe\\winhelm-validation-dead-${Date.now()}`,
          capability: "stale-primary-capability",
          pid: process.pid,
          createdAt: new Date(Date.now() + 60_000).toISOString(),
          instanceId: "validation-stale-primary",
        },
        null,
        2
      ),
      "utf8"
    );

    await run({ metadataPath, registryDir, live });
  } finally {
    await server.close().catch(() => {});
    resetApprovalEngine();
    resetAdminAuthManager();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function expectFallbackSuccess(metadataPath: string): Promise<void> {
  const response = await sendControlCommand(
    { command: "status" },
    { metadataPath, connectTimeoutMs: 250 }
  );
  assert.strictEqual(response.ok, true);
  assert.ok(response.status);
}

describe("Local-control registry strict metadata admission", () => {
  const validBase = (): ControlMetadata => ({
    pipeName: "\\\\.\\pipe\\winhelm-malformed-placeholder",
    capability: "malformed-capability",
    pid: process.pid,
    createdAt: new Date(Date.now() + 120_000).toISOString(),
    instanceId: "malformed-instance",
  });

  it("skips a canonical registry record with empty pipeName before connect", async () => {
    await withPoisonedPrimary(async ({ metadataPath, registryDir }) => {
      const record = { ...validBase(), pipeName: "" };
      await writeRecord(
        registryDir,
        registryName(record.instanceId),
        record
      );
      await expectFallbackSuccess(metadataPath);
    });
  });

  it("skips a canonical registry record with empty capability", async () => {
    await withPoisonedPrimary(async ({ metadataPath, registryDir }) => {
      const record = { ...validBase(), capability: "" };
      await writeRecord(
        registryDir,
        registryName(record.instanceId),
        record
      );
      await expectFallbackSuccess(metadataPath);
    });
  });

  it("skips a canonical registry record with invalid createdAt", async () => {
    await withPoisonedPrimary(async ({ metadataPath, registryDir }) => {
      const record = { ...validBase(), createdAt: "not-a-date" };
      await writeRecord(
        registryDir,
        registryName(record.instanceId),
        record
      );
      await expectFallbackSuccess(metadataPath);
    });
  });

  it("skips registry records with missing or empty instanceId", async () => {
    await withPoisonedPrimary(async ({ metadataPath, registryDir }) => {
      const missing = { ...validBase() } as Partial<ControlMetadata>;
      delete missing.instanceId;
      await writeRecord(
        registryDir,
        registryName("filename-without-instance-id"),
        missing
      );

      const empty = { ...validBase(), instanceId: "" };
      await writeRecord(
        registryDir,
        registryName(""),
        empty
      );

      await expectFallbackSuccess(metadataPath);
    });
  });

  it("skips a valid-looking registry record whose filename does not bind to instanceId", async () => {
    await withPoisonedPrimary(async ({ metadataPath, registryDir }) => {
      const record = {
        ...validBase(),
        instanceId: "filename-bound-instance",
      };
      await writeRecord(
        registryDir,
        registryName("different-instance"),
        record
      );
      await expectFallbackSuccess(metadataPath);
    });
  });
});
