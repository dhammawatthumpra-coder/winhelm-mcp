import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import * as tunnel from "../../src/integrations/chatgpt-tunnel.js";
import { TunnelLifecycleError, stopManagedTunnel } from "../../src/integrations/chatgpt-tunnel.js";

/**
 * M3A-P2 R2: managed-identity fail-closed proof.
 *
 * The identity predicate must be conjunctive: PID + executable path + creation
 * time must ALL be positively proven before any managed process may be
 * stopped. A missing or malformed field on either side leaves identity
 * UNPROVEN (fail closed, never kill) — "field unavailable" must never be
 * interpreted as "field matched".
 */

type ProvePredicate = (input: {
  observedExists: boolean;
  observedExecutablePath?: string;
  observedCreatedAtIso?: string;
  persistedPid: number;
  persistedExecutablePath?: string;
  persistedProcessCreatedAt?: string;
}) => boolean;

function getPredicate(): ProvePredicate {
  const prove = (
    tunnel as unknown as { isManagedIdentityProven?: ProvePredicate }
  ).isManagedIdentityProven;
  assert.ok(
    typeof prove === "function",
    "isManagedIdentityProven must be exported for direct fail-closed proof testing"
  );
  return prove as ProvePredicate;
}

const PROVEN_EXE = "C:\\tools\\tunnel-client.exe";
const PROVEN_CREATED = "2026-10-07T08:00:00.000Z";

function provenInput(overrides: Record<string, unknown> = {}): {
  observedExists: boolean;
  observedExecutablePath?: string;
  observedCreatedAtIso?: string;
  persistedPid: number;
  persistedExecutablePath?: string;
  persistedProcessCreatedAt?: string;
} {
  return {
    observedExists: true,
    observedExecutablePath: PROVEN_EXE,
    observedCreatedAtIso: PROVEN_CREATED,
    persistedPid: 4242,
    persistedExecutablePath: PROVEN_EXE,
    persistedProcessCreatedAt: PROVEN_CREATED,
    ...overrides,
  };
}

let scratch: string;
let stateDir: string;
let savedEnv: Record<string, string | undefined>;

/**
 * Queries the real Win32_Process creation time of a PID (same source of truth
 * the production identity probe uses) so forged state can pin the observed
 * side while deliberately omitting/invalidating another identity field.
 */
function queryCreationTime(pid: number): string {
  const script =
    "$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=" +
    pid +
    "' -ErrorAction Stop | Select-Object -First 1; if ($p) { Write-Output $p.CreationDate.ToString('o') } else { Write-Output 'NOTFOUND' }";
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
  assert.notStrictEqual(out, "NOTFOUND", "helper process must be observable");
  return out;
}

describe("M3A P2 R2: managed identity fail-closed proof", () => {
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "winhelm-m3a-p2-r2-"));
    stateDir = path.join(scratch, "state");
    savedEnv = {
      WINHELM_TUNNEL_STATE_DIR: process.env.WINHELM_TUNNEL_STATE_DIR,
    };
    process.env.WINHELM_TUNNEL_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (savedEnv.WINHELM_TUNNEL_STATE_DIR === undefined) {
      delete process.env.WINHELM_TUNNEL_STATE_DIR;
    } else {
      process.env.WINHELM_TUNNEL_STATE_DIR = savedEnv.WINHELM_TUNNEL_STATE_DIR;
    }
    await fs.rm(scratch, { recursive: true, force: true });
  });

  describe("identity predicate (direct, pure)", () => {
    it("1. observed process exists but executablePath missing => unproven", () => {
      const prove = getPredicate();
      assert.strictEqual(
        prove(provenInput({ observedExecutablePath: undefined })),
        false
      );
      assert.strictEqual(prove(provenInput({ observedExecutablePath: "" })), false);
    });

    it("2. observed process exists but creation time missing => unproven", () => {
      const prove = getPredicate();
      assert.strictEqual(
        prove(provenInput({ observedCreatedAtIso: undefined })),
        false
      );
      assert.strictEqual(prove(provenInput({ observedCreatedAtIso: "" })), false);
    });

    it("3. observed creation time malformed => unproven", () => {
      const prove = getPredicate();
      assert.strictEqual(
        prove(provenInput({ observedCreatedAtIso: "not-a-timestamp" })),
        false
      );
    });

    it("4. persisted processCreatedAt missing or malformed => unproven", () => {
      const prove = getPredicate();
      assert.strictEqual(
        prove(provenInput({ persistedProcessCreatedAt: "not-a-timestamp" })),
        false
      );
      assert.strictEqual(
        prove(provenInput({ persistedProcessCreatedAt: "" })),
        false
      );
      assert.strictEqual(
        prove(provenInput({ persistedProcessCreatedAt: undefined })),
        false
      );
    });

    it("5. exact path + valid creation time match => proven", () => {
      const prove = getPredicate();
      assert.strictEqual(prove(provenInput()), true);
      // Case-insensitive path comparison preserved from R1.
      assert.strictEqual(
        prove(provenInput({ observedExecutablePath: "c:\\TOOLS\\TUNNEL-CLIENT.EXE" })),
        true
      );
      // Creation time within the accepted 2 s tolerance stays proven.
      assert.strictEqual(
        prove(
          provenInput({
            observedCreatedAtIso: "2026-10-07T08:00:01.500Z",
          })
        ),
        true
      );
    });

    it("6. path mismatch => unproven", () => {
      const prove = getPredicate();
      assert.strictEqual(
        prove(
          provenInput({
            observedExecutablePath: "D:\\elsewhere\\tunnel-client.exe",
          })
        ),
        false
      );
      assert.strictEqual(
        prove(provenInput({ persistedExecutablePath: "Z:\\unrelated\\node.exe" })),
        false
      );
    });

    it("7. creation-time mismatch beyond tolerance => unproven", () => {
      const prove = getPredicate();
      assert.strictEqual(
        prove(
          provenInput({
            observedCreatedAtIso: "2026-10-07T08:00:05.000Z",
          })
        ),
        false
      );
    });

    it("missing persisted executablePath, absent process, or invalid pid => unproven", () => {
      const prove = getPredicate();
      assert.strictEqual(
        prove(provenInput({ persistedExecutablePath: "" })),
        false
      );
      assert.strictEqual(
        prove(provenInput({ persistedExecutablePath: undefined })),
        false
      );
      assert.strictEqual(prove(provenInput({ observedExists: false })), false);
      assert.strictEqual(prove(provenInput({ persistedPid: 0 })), false);
      assert.strictEqual(prove(provenInput({ persistedPid: -1 })), false);
      assert.strictEqual(
        prove(provenInput({ persistedPid: Number.NaN })),
        false
      );
    });
  });

  describe("stop path fail-closed against a live process (end to end)", () => {
    /**
     * Forges managed state for a LIVE unrelated helper process whose observed
     * identity is real, while one persisted identity field is emptied. The
     * stop path must reject with MANAGED_IDENTITY_UNPROVEN and the helper must
     * survive — at R1 the emptied field skipped its comparison and the helper
     * was killed (the defect under correction).
     */
    async function forgeStateAndStop(persisted: {
      executablePath?: string;
      processCreatedAt?: string;
    }): Promise<void> {
      const helper = await import("node:child_process");
      const unrelated = helper.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000);"],
        { stdio: "ignore" }
      );
      await new Promise((r) => setTimeout(r, 300));
      try {
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "managed-state.json"),
          JSON.stringify({
            schemaVersion: 1,
            stateId: "forged-r2-state",
            pid: unrelated.pid,
            processCreatedAt:
              persisted.processCreatedAt ?? queryCreationTime(unrelated.pid!),
            executablePath: persisted.executablePath ?? process.execPath,
            profilePath: process.execPath,
            startedAt: new Date().toISOString(),
            healthUrl: "http://127.0.0.1:1",
            status: "ready",
          }),
          "utf8"
        );

        await assert.rejects(
          stopManagedTunnel(),
          (err: unknown) =>
            err instanceof TunnelLifecycleError &&
            err.code === "MANAGED_IDENTITY_UNPROVEN"
        );

        let alive = true;
        try {
          process.kill(unrelated.pid!, 0);
        } catch {
          alive = false;
        }
        assert.strictEqual(
          alive,
          true,
          "incomplete identity proof must never enable a kill"
        );
      } finally {
        unrelated.kill();
      }
    }

    it("persisted executablePath empty while observed identity is real => no kill", async () => {
      await forgeStateAndStop({ executablePath: "" });
    });

    it("persisted processCreatedAt empty while observed identity is real => no kill", async () => {
      await forgeStateAndStop({ processCreatedAt: "" });
    });

    it("persisted processCreatedAt malformed => no kill", async () => {
      await forgeStateAndStop({ processCreatedAt: "not-a-timestamp" });
    });
  });
});
