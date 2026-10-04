import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  initializeApprovalPersistence,
  getCrossProcessApprovalSurface,
  resetApprovalEngine,
  type CrossProcessApprovalSurface,
} from "../../src/approval/runtime.js";
import {
  readJournalJob,
  readRequest,
  resetCrossProcessInstanceId,
} from "../../src/approval/cross-process.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "../../src");
const HARNESS = path.join(HERE, "harness", "cross-process-owner.mjs");

interface HarnessHandle {
  child: any;
  outPath: string;
  result: Promise<any>;
}

function startHarness(
  mode: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv = {}
): HarnessHandle {
  const outPath = path.join(
    env.WINHELM_APPROVAL_JOURNAL_PATH!,
    "..",
    `harness-${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", HARNESS, mode, ...extraArgs, outPath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WINHELM_SRC_DIR: SRC_DIR,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<any>((resolve, reject) => {
    child.on("exit", (code) => {
      try {
        resolve(JSON.parse(fs.readFileSync(outPath, "utf8")));
      } catch (err) {
        reject(
          new Error(
            `harness(${mode}) exit=${code} stderr=${stderr.slice(-800)}`
          )
        );
      }
    });
    child.on("error", reject);
  });
  return { child, outPath, result };
}

async function waitFor(predicate: () => boolean, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached within timeout");
}

async function waitForMarker(markerPath: string, lines: number) {
  await waitFor(() => {
    try {
      return (
        fs.readFileSync(markerPath, "utf8").split("\n").filter((l) => l === "E")
          .length >= lines
      );
    } catch {
      return false;
    }
  });
}

function markerCount(markerPath: string): number {
  try {
    return fs
      .readFileSync(markerPath, "utf8")
      .split("\n").filter((l) => l === "E").length;
  } catch {
    return 0;
  }
}

/**
 * Record a decision and follow a "pending" outcome (possible when the owner
 * process's consumption tick lags under machine load) to its durable
 * terminal state. Asserts the expected terminal state and executionCount.
 */
async function decideAndWait(
  surface: CrossProcessApprovalSurface,
  jobId: string,
  decision: "approved" | "denied",
  expectedState: "completed" | "denied" | "expired",
  expectedExec: number
): Promise<void> {
  const outcome = await surface.decideRemote(jobId, decision, "dashboard");
  if (outcome.kind === "pending") {
    await waitFor(() => {
      const mirror = readRequest(jobId, sandbox.journalPath);
      const job = mirror?.job ?? readJournalJob(jobId, sandbox.journalPath);
      return job !== null && job.state === expectedState;
    });
    return;
  }
  assert.equal(outcome.kind, "applied");
  if (outcome.kind === "applied") {
    assert.equal(outcome.job.state, expectedState);
    assert.equal(outcome.job.executionCount, expectedExec);
  }
}

interface Sandbox {
  root: string;
  journalPath: string;
  surface: CrossProcessApprovalSurface;
}

let sandbox: Sandbox;

beforeEach(async () => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "winhelm-xproc-")
  );
  const journalPath = path.join(root, "approval-jobs.json");
  process.env.WINHELM_APPROVAL_JOURNAL_PATH = journalPath;
  resetCrossProcessInstanceId();
  // The test process plays the Dashboard/Admin role: it lists foreign jobs
  // and records decisions, never executing anyone's callback.
  initializeApprovalPersistence(journalPath, { crossProcess: true });
  const surface = getCrossProcessApprovalSurface();
  if (!surface) throw new Error("cross-process surface unavailable");
  sandbox = { root, journalPath, surface };
});

afterEach(async () => {
  resetApprovalEngine();
  await fsp.rm(sandbox.root, { recursive: true, force: true });
});

describe("DEF-02 cross-process approval coordination", () => {
  it("A+B: a job owned by another process is visible and an approve executes exactly once in the owner", async () => {
    const marker = path.join(sandbox.root, "marker-a.txt");
    const handle = startHarness("own", [marker, "15000"], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });

    let foreign: any = null;
    await waitFor(() => {
      const list = sandbox.surface.listForeignRequests();
      foreign = list.find((r) => r.job.tool === "clipboard_set");
      return Boolean(foreign);
    });
    // Sanitized display metadata from the owner process.
    assert.equal(foreign.display.clientInfo.name, "harness-client");
    assert.equal(foreign.job.state, "awaiting_approval");
    assert.ok(!JSON.stringify(foreign).includes("idempotencyKey"));

    await decideAndWait(
      sandbox.surface,
      foreign.job.id,
      "approved",
      "completed",
      1
    );

    const childResult = await handle.result;
    assert.equal(childResult.state, "completed");
    assert.equal(childResult.executionCount, 1);
    assert.deepEqual(childResult.result, {
      done: true,
      pid: childResult.result.pid,
    });
    assert.equal(markerCount(marker), 1);

    handle.child.kill();
  });

  it("C: a cross-process deny leaves the owner callback unexecuted", async () => {
    const marker = path.join(sandbox.root, "marker-c.txt");
    const handle = startHarness("own", [marker, "15000"], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });
    let jobId = "";
    await waitFor(() => {
      const list = sandbox.surface.listForeignRequests();
      const record = list.find((r) => r.job.tool === "clipboard_set");
      if (record) jobId = record.job.id;
      return Boolean(record);
    });
    await decideAndWait(sandbox.surface, jobId, "denied", "denied", 0);

    const childResult = await handle.result;
    assert.equal(childResult.state, "denied");
    assert.equal(childResult.executionCount, 0);
    assert.equal(markerCount(marker), 0);
    handle.child.kill();
  });

  it("D: expiry is decided by the owner; a late decision cannot execute", async () => {
    const marker = path.join(sandbox.root, "marker-d.txt");
    const handle = startHarness("own", [marker, "700"], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });
    let jobId = "";
    await waitFor(() => {
      const list = sandbox.surface.listForeignRequests();
      const record = list.find((r) => r.job.tool === "clipboard_set");
      if (record) jobId = record.job.id;
      return Boolean(record);
    });
    // Do nothing; the owner's engine expires the job.
    const childResult = await handle.result;
    assert.equal(childResult.state, "expired");
    assert.equal(childResult.executionCount, 0);
    assert.equal(markerCount(marker), 0);

    const late = await sandbox.surface.decideRemote(
      jobId,
      "approved",
      "dashboard"
    );
    assert.equal(late.kind, "conflict");
    assert.equal(markerCount(marker), 0);
  });

  it("E: duplicate concurrent approves produce at most one execution", async () => {
    const marker = path.join(sandbox.root, "marker-e.txt");
    const handle = startHarness("own", [marker, "15000"], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });
    let jobId = "";
    await waitFor(() => {
      const list = sandbox.surface.listForeignRequests();
      const record = list.find((r) => r.job.tool === "clipboard_set");
      if (record) jobId = record.job.id;
      return Boolean(record);
    });
    // Duplicate concurrent approves: at most one valid transition; the
    // winner may still be consumed after decideRemote's wait window, so the
    // terminal state is asserted from the shared view instead.
    const [first, second] = await Promise.all([
      sandbox.surface.decideRemote(jobId, "approved", "dashboard"),
      sandbox.surface.decideRemote(jobId, "approved", "dashboard"),
    ]);
    for (const outcome of [first, second]) {
      assert.ok(
        outcome.kind === "applied" ||
          outcome.kind === "conflict" ||
          outcome.kind === "pending",
        "unexpected outcome: " + JSON.stringify(outcome)
      );
      if (outcome.kind === "applied") {
        assert.equal(outcome.job.state, "completed");
        assert.equal(outcome.job.executionCount, 1);
      }
    }
    await waitFor(() => {
      const mirror = readRequest(jobId, sandbox.journalPath);
      const job = mirror?.job ?? readJournalJob(jobId, sandbox.journalPath);
      return job !== null && job.state === "completed";
    });
    await waitForMarker(marker, 1);
    // Let the owner settle, then verify exactly-once.
    const childResult = await handle.result;
    assert.equal(childResult.state, "completed");
    assert.equal(childResult.executionCount, 1);
    assert.equal(markerCount(marker), 1);
    handle.child.kill();
  });

  it("F: a decision for a dead owner is refused and nothing executes", async () => {
    const handle = startHarness("die-pending", [], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });
    const { id } = await handle.result;
    const durable = readJournalJob(id, sandbox.journalPath);
    assert.ok(durable);
    assert.equal(durable!.state, "awaiting_approval");

    const outcome = await sandbox.surface.decideRemote(
      id,
      "approved",
      "dashboard"
    );
    assert.equal(outcome.kind, "conflict");
    if (outcome.kind === "conflict") {
      assert.equal(outcome.code, "OWNER_UNAVAILABLE");
    }
    // Nothing migrated: the job is still untouched in the journal and no
    // decision file was left behind to execute elsewhere.
    assert.equal(
      readJournalJob(id, sandbox.journalPath)!.state,
      "awaiting_approval"
    );
  });

  it("G: an owner dying after the claim leaves an unknown, non-replayable job", async () => {
    const marker = path.join(sandbox.root, "marker-g.txt");
    const handle = startHarness("die-after-claim", [marker], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });
    // The harness writes its out file at job creation but stays alive (it
    // dies mid-execution later); read the file instead of waiting for
    // process exit, which would outrun the 30s job TTL.
    await waitFor(() => fs.existsSync(handle.outPath));
    const { id } = JSON.parse(fs.readFileSync(handle.outPath, "utf8"));
    const outcome = await sandbox.surface.decideRemote(
      id,
      "approved",
      "dashboard"
    );
    // The owner claims and starts executing, then dies mid-flight; the
    // decision surface never observes a terminal state.
    assert.ok(
      outcome.kind === "pending" || outcome.kind === "applied",
      "unexpected decideRemote outcome: " + JSON.stringify(outcome)
    );
    // Wait for the owner to reach running, then die.
    await waitFor(() => {
      const job = readJournalJob(id, sandbox.journalPath);
      return job?.state === "running";
    });
    await new Promise((resolve) =>
      setTimeout(() => {
        handle.child.kill();
        resolve();
      }, 50)
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(markerCount(marker), 1);

    // A restart of the same instance must not replay the side effect.
    const recover = startHarness("recover", [], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });
    const recovery = await recover.result;
    assert.ok(recovery.unknownRecoveredJobs >= 1);
    assert.equal(markerCount(marker), 1);
  });

  it("H: two owning processes are listed and routed independently", async () => {
    const markerA = path.join(sandbox.root, "marker-ha.txt");
    const markerB = path.join(sandbox.root, "marker-hb.txt");
    const handleA = startHarness("own", [markerA, "15000"], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });
    const handleB = startHarness("own", [markerB, "15000"], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
    });
    let idA = "";
    let idB = "";
    // Pair each job with its owning child by the mirror's pid; list order is
    // not a reliable owner indicator.
    await waitFor(() => {
      const list = sandbox.surface
        .listForeignRequests()
        .filter((r) => r.job.tool === "clipboard_set");
      const mineA = list.find((r) => r.pid === handleA.child.pid);
      const mineB = list.find((r) => r.pid === handleB.child.pid);
      if (mineA && mineB) {
        idA = mineA.job.id;
        idB = mineB.job.id;
        return true;
      }
      return false;
    });
    assert.notEqual(idA, idB);

    const [approved, denied] = await Promise.all([
      sandbox.surface.decideRemote(idA, "approved", "dashboard"),
      sandbox.surface.decideRemote(idB, "denied", "dashboard"),
    ]);
    // Under heavy machine load the owner's consumption tick can lag past the
    // decideRemote wait window; the durable guarantee is what matters, so a
    // "pending" outcome is followed to its terminal state in the journal.
    for (const [outcome, expectedState] of [
      [approved, "completed"],
      [denied, "denied"],
    ] as const) {
      if (outcome.kind === "applied") {
        assert.equal(outcome.job.state, expectedState);
      } else if (outcome.kind === "pending") {
        await waitFor(() => {
          const job = readJournalJob(outcome.jobId, sandbox.journalPath);
          return job !== null && job.state === expectedState;
        });
      } else {
        assert.fail("unexpected outcome: " + JSON.stringify(outcome));
      }
    }

    const childA = await handleA.result;
    const childB = await handleB.result;
    assert.equal(childA.state, "completed");
    assert.equal(childA.executionCount, 1);
    assert.equal(childB.state, "denied");
    assert.equal(childB.executionCount, 0);
    assert.equal(markerCount(markerA), 1);
    assert.equal(markerCount(markerB), 0);
    handleA.child.kill();
    handleB.child.kill();
  });

  it("I: approval routing ignores stale control metadata entirely", async () => {
    const marker = path.join(sandbox.root, "marker-i.txt");
    const handle = startHarness("own", [marker, "15000"], {
      WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
      // Poison the legacy single-slot control pointer: the cross-process
      // approval path must not consult it at all.
      WINHELM_CONTROL_METADATA_PATH: path.join(
        sandbox.root,
        "stale-control.json"
      ),
    });
    fs.writeFileSync(
      path.join(sandbox.root, "stale-control.json"),
      JSON.stringify({
        pipeName: "\\\\.\\pipe\\winhelm-dead-0000",
        capability: "stale",
        pid: 999999,
      })
    );
    let jobId = "";
    await waitFor(() => {
      const list = sandbox.surface.listForeignRequests();
      const record = list.find((r) => r.job.tool === "clipboard_set");
      if (record) jobId = record.job.id;
      return Boolean(record);
    });
    // Routing must ignore the poisoned control pointer entirely.
    const outcome = await sandbox.surface.decideRemote(
      jobId,
      "approved",
      "dashboard"
    );
    if (outcome.kind === "applied") {
      assert.equal(outcome.job.state, "completed");
      assert.equal(outcome.job.executionCount, 1);
    } else if (outcome.kind === "pending") {
      await waitFor(() => {
        const mirror = readRequest(jobId, sandbox.journalPath);
        const job = mirror?.job ?? readJournalJob(jobId, sandbox.journalPath);
        return job !== null && job.state === "completed";
      });
    } else {
      assert.fail("unexpected outcome: " + JSON.stringify(outcome));
    }
    await waitForMarker(marker, 1);
    handle.child.kill();
  });

  it("CLI approve keeps the interactive-terminal gate for non-TTY callers", async () => {
    const cli = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "approve", "job_nonexistent"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WINHELM_APPROVAL_JOURNAL_PATH: sandbox.journalPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stderr = "";
    cli.stderr.setEncoding("utf8");
    cli.stderr.on("data", (c: string) => (stderr += c));
    await new Promise((resolve) => cli.on("exit", resolve));
    assert.match(stderr, /interactive local terminal/);
  });

  it("J: a real stdio client's announced clientInfo reaches the shared mirror", async () => {
    // A stdio MCP client (Claude Desktop / Cursor) announces clientInfo in
    // its initialize handshake. Before DEF-02 the stdio path never published
    // it, so approval surfaces reported clientInfo: null. This drives a real
    // stdio server process and asserts the owning process mirrors the name.
    const journalPath = path.join(sandbox.root, "stdio-journal.json");
    const stdioConfigPath = path.join(sandbox.root, "stdio-config.json");
    await fsp.writeFile(
      stdioConfigPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          folders: [
            { path: sandbox.root, permission: "readwrite", alias: "smoke" },
          ],
          terminal: { mode: "ask" },
          toolPolicy: { clipboard_set: "ask" },
        },
        null,
        2
      ),
      "utf8"
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "--stdio", "--config", stdioConfigPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WINHELM_APPROVAL_JOURNAL_PATH: journalPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    const sawInitializeResult = () =>
      stdout
        .split("\n")
        .some((line) => {
          try {
            const msg = JSON.parse(line);
            return msg.id === 1 && msg.result !== undefined;
          } catch {
            return false;
          }
        });

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "Claude Desktop", version: "9.9.9" },
        },
      });
      await waitFor(sawInitializeResult, 30000);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "clipboard_set", arguments: { text: "def02-j" } },
      });
      // Read the mirror straight off disk: the announced name must be there.
      let mirrored: any = null;
      await waitFor(() => {
        const records = readRequestsFromDir(journalPath);
        mirrored = records[0] ?? null;
        return Boolean(mirrored);
      });
      assert.equal(mirrored.display.clientInfo.name, "Claude Desktop");
      assert.equal(mirrored.display.clientInfo.version, "9.9.9");
      assert.equal(mirrored.job.state, "awaiting_approval");
    } catch (err) {
      throw new Error(
        (err as Error).message +
          " | stdout=" +
          stdout.slice(-400) +
          " | stderr=" +
          stderr.slice(-400)
      );
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("exit", resolve));
    }
  });
});

function readRequestsFromDir(journalPath: string): any[] {
  const dir = path.join(path.dirname(journalPath), "approval-requests");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  } catch {
    return [];
  }
}
