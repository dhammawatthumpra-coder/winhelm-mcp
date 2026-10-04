import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ConfigManager } from "../../src/config/config-manager.js";
import { createServer } from "../../src/gateway/server.js";
import {
  getAdminAuthManager,
  resetAdminAuthManager,
} from "../../src/admin/runtime.js";
import {
  initializeApprovalPersistence,
  resetApprovalEngine,
} from "../../src/approval/runtime.js";
import { resetCrossProcessInstanceId } from "../../src/approval/cross-process.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "../../src");
const HARNESS = path.join(HERE, "harness", "cross-process-owner.mjs");

interface OwnerHandle {
  child: ReturnType<typeof spawn>;
  result: Promise<any>;
}

function startOwner(markerPath: string, journalPath: string): OwnerHandle {
  const outPath = path.join(
    path.dirname(journalPath),
    `owner-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", HARNESS, "own", markerPath, "30000", outPath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WINHELM_SRC_DIR: SRC_DIR,
        WINHELM_APPROVAL_JOURNAL_PATH: journalPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const result = new Promise<any>((resolve, reject) => {
    child.on("exit", (code) => {
      try {
        resolve(JSON.parse(fs.readFileSync(outPath, "utf8")));
      } catch {
        reject(new Error("owner harness exit=" + code));
      }
    });
    child.on("error", reject);
  });
  return { child, result };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 90000
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition not reached within timeout");
}

function markerCount(markerPath: string): number {
  try {
    return fs
      .readFileSync(markerPath, "utf8")
      .split("\n")
      .filter((l) => l === "E").length;
  } catch {
    return 0;
  }
}

describe("DEF-02 Dashboard cross-process approval", () => {
  it("lists a foreign client's job and routes approve/deny to its owning process", async () => {
    const root = await fsp.mkdtemp(
      path.join(os.tmpdir(), "winhelm-def02-dash-")
    );
    const journalPath = path.join(root, "approval-jobs.json");
    const configFile = path.join(root, "winhelm.config.json");
    await fsp.writeFile(
      configFile,
      JSON.stringify({ profile: "full" }, null, 2),
      "utf8"
    );

    process.env.WINHELM_APPROVAL_JOURNAL_PATH = journalPath;
    ConfigManager.resetInstance(configFile);
    resetAdminAuthManager();
    resetCrossProcessInstanceId();
    // The Dashboard process enables the same cross-process coordination the
    // production bootstrap does.
    initializeApprovalPersistence(journalPath, { crossProcess: true });

    const instance = createServer({
      port: 0,
      host: "127.0.0.1",
      authToken: "mcp-secret",
    });
    const server = await instance.start();
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const markerApprove = path.join(root, "marker-approve.txt");
    const markerDeny = path.join(root, "marker-deny.txt");
    const ownerA = startOwner(markerApprove, journalPath);
    const ownerB = startOwner(markerDeny, journalPath);

    try {
      const exchange = await fetch(`${base}/admin/auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ code: getAdminAuthManager().issueCode().code }),
      });
      assert.strictEqual(exchange.status, 200);
      const cookie = (exchange.headers.get("set-cookie") as string).split(
        ";"
      )[0];
      const csrf = ((await exchange.json()) as any).csrfToken as string;

      // The Dashboard must see BOTH foreign jobs over its real HTTP admin
      // plane, carrying owner-computed client identity and risk metadata.
      let jobs: any[] = [];
      await waitFor(async () => {
        const res = await fetch(`${base}/admin/approvals`, {
          headers: { Cookie: cookie },
        });
        jobs = (await res.json()).jobs ?? [];
        return jobs.length >= 2;
      });
      const withClient = jobs.filter((j) => j.clientInfo?.name);
      assert.ok(
        withClient.length >= 1,
        "expected owner-computed clientInfo, got " +
          JSON.stringify(jobs.map((j) => j.clientInfo))
      );
      assert.equal(withClient[0].source, "remote");
      assert.ok(withClient[0].risk, "expected risk presentation on remote job");

      const [approveTarget, denyTarget] = jobs;

      const approveRes = await fetch(
        `${base}/admin/approvals/${encodeURIComponent(approveTarget.id)}/approve`,
        {
          method: "POST",
          headers: { Cookie: cookie, Origin: base, "x-winhelm-csrf": csrf },
        }
      );
      assert.strictEqual(approveRes.status, 200);
      const approveBody = (await approveRes.json()) as any;
      assert.strictEqual(approveBody.success, true);
      assert.equal(approveBody.source, "remote");

      const denyRes = await fetch(
        `${base}/admin/approvals/${encodeURIComponent(denyTarget.id)}/deny`,
        {
          method: "POST",
          headers: { Cookie: cookie, Origin: base, "x-winhelm-csrf": csrf },
        }
      );
      assert.strictEqual(denyRes.status, 200);
      assert.strictEqual(((await denyRes.json()) as any).success, true);

      // The owning processes — not the Dashboard — perform the transitions.
      const ownerAResult = await ownerA.result;
      const ownerBResult = await ownerB.result;
      const executed = [ownerAResult, ownerBResult].filter(
        (r) => r.state === "completed"
      );
      const denied = [ownerAResult, ownerBResult].filter(
        (r) => r.state === "denied"
      );
      assert.equal(executed.length, 1, "exactly one owner executes");
      assert.equal(denied.length, 1, "exactly one owner is denied");
      assert.equal(executed[0].executionCount, 1);
      assert.equal(denied[0].executionCount, 0);
      assert.equal(
        markerCount(markerApprove) + markerCount(markerDeny),
        1,
        "exactly one side effect across both owners"
      );
    } finally {
      ownerA.child.kill("SIGKILL");
      ownerB.child.kill("SIGKILL");
      await instance.stop(server);
      resetApprovalEngine();
      resetAdminAuthManager();
      ConfigManager.resetInstance();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});