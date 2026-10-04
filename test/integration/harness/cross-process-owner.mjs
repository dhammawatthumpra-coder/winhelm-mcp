// Multi-process approval test harness. Runs as a separate OS process via
// `node --import tsx` so the approval engine instance, its in-memory job map
// and its executor are genuinely foreign to the test (dashboard) process.
// Modes:
//   own <markerPath> <outPath> [ttlMs]
//   die-pending <outPath>
//   die-after-claim <markerPath> <outPath>
//   recover <outPath>
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const SRC = process.env.WINHELM_SRC_DIR;
if (!SRC) throw new Error("WINHELM_SRC_DIR is required");

const mod = async (rel) =>
  await import(pathToFileURL(path.join(SRC, rel)).href);

const runtime = await mod("approval/runtime.ts");

const journalPath = process.env.WINHELM_APPROVAL_JOURNAL_PATH;
if (!journalPath) throw new Error("WINHELM_APPROVAL_JOURNAL_PATH is required");

const mode = process.argv[2];

function writeOut(outPath, payload) {
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
}

function appendMarker(markerPath) {
  fs.appendFileSync(markerPath, "E\n");
}

if (mode === "own") {
  const markerPath = process.argv[3];
  const ttlMs = Number(process.argv[4] ?? 15000);
  const outPath = process.argv[5];
  const t0 = Date.now();
  const log = (m) => console.error(`[own ${process.pid} ${Date.now() - t0}ms] ${m}`);
  log("start");
  runtime.initializeApprovalPersistence(journalPath, {
    crossProcess: true,
    requestMetaProvider: (job) => ({
      clientInfo: { name: "harness-client", version: "1.0" },
      note: "meta-for-" + job.tool,
    }),
  });
  log("initialized");
  const requested = runtime.getApprovalEngine().request({
    tool: "clipboard_set",
    args: { text: "harness-" + process.pid },
    sessionId: "harness-session-" + process.pid,
    ttlMs,
    maxPending: 5,
    execute: async () => {
      appendMarker(markerPath);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { done: true, pid: process.pid };
    },
  });
  log("requested kind=" + requested.kind + " id=" + requested.job.id);
  if (requested.kind !== "created") {
    writeOut(outPath, { error: "not-created", kind: requested.kind });
    process.exit(1);
  }
  const outcome = await runtime
    .getApprovalEngine()
    .waitForTerminalOrReceipt(requested.job.id, Math.max(ttlMs + 5000, 20000));
  log("outcome state=" + outcome.job.state + " kind=" + outcome.kind);
  writeOut(outPath, {
    id: outcome.job.id,
    state: outcome.job.state,
    executionCount: outcome.job.executionCount,
    result: outcome.job.result ?? null,
    kind: outcome.kind,
  });
  log("wrote out, exiting");
  process.exit(0);
}

if (mode === "die-pending") {
  const outPath = process.argv[3];
  runtime.initializeApprovalPersistence(journalPath, { crossProcess: true });
  const requested = runtime.getApprovalEngine().request({
    tool: "clipboard_set",
    args: { text: "dying-" + process.pid },
    sessionId: "harness-session-" + process.pid,
    ttlMs: 30000,
    maxPending: 5,
    execute: async () => {
      throw new Error("must never run");
    },
  });
  writeOut(outPath, { id: requested.job.id, kind: requested.kind });
  // Exit with a live pending job: the owner vanishes before any decision.
  process.exit(0);
}

if (mode === "die-after-claim") {
  const markerPath = process.argv[3];
  const outPath = process.argv[4];
  runtime.initializeApprovalPersistence(journalPath, { crossProcess: true });
  const requested = runtime.getApprovalEngine().request({
    tool: "clipboard_set",
    args: { text: "crashy-" + process.pid },
    sessionId: "harness-session-" + process.pid,
    ttlMs: 30000,
    maxPending: 5,
    execute: async () => {
      appendMarker(markerPath);
      // Die mid-execution: claimed and running, outcome never recorded.
      await new Promise((resolve) => setTimeout(resolve, 250));
      process.exit(1);
    },
  });
  writeOut(outPath, { id: requested.job.id, kind: requested.kind });
  // Stay alive until the decision arrives and the executor starts.
  await new Promise((resolve) => setTimeout(resolve, 30000));
  process.exit(0);
}

if (mode === "recover") {
  const outPath = process.argv[3];
  const status = runtime.initializeApprovalPersistence(journalPath, {
    crossProcess: true,
  });
  // Keep the process alive briefly so the recovery path is deterministic.
  writeOut(outPath, {
    recoveredJobs: status.recoveredJobs,
    unknownRecoveredJobs: status.unknownRecoveredJobs,
    integrityFailure: status.integrityFailure,
  });
  process.exit(0);
}

throw new Error("unknown harness mode: " + mode);
