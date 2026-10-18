import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import {
  buildRuntimeChainProcessSpecs,
  launchRuntimeChain,
  recommendedInternalPortMode,
  resolveInternalPortLaunchPlan,
  resolveVerifiedInternalTopology,
  type ManagedLaunchedProcess,
  type ProcessSpec,
} from "../../src/runtime/launcher-contract.js";

const fixed = { core: 18788, r7: 64239, r8: 19447 };

function abs(name: string): string {
  return path.resolve("D:\\phase6-fixture", name);
}

function paths() {
  return {
    coreExecutable: abs("node.exe"),
    coreEntrypoint: abs("core\\dist\\index.js"),
    coreConfig: abs("core\\config.json"),
    r7Executable: abs("node.exe"),
    r7Entrypoint: abs("r7\\live-server-dynamic-upstream.mjs"),
    r7SourceRoot: abs("r7\\reviewed"),
    r7Store: abs("state\\r7-store.json"),
    r7Receipt: abs("state\\r7-receipt.json"),
    r7Origin: "https://winhelm-gemini-go-hardening-01.tailabb39e.ts.net",
    r7ClientId: "phase6-client-id",
    r7RedirectUri:
      "https://oauth-redirect.googleusercontent.com/r/winhelm-phase6",
    r8SupervisorExecutable: abs("node.exe"),
    r8SupervisorEntrypoint: abs("r8\\r8-runtime-supervisor.mjs"),
    r8Binary: abs("r8\\winhelm-r8.exe"),
    r8ConfigTemplate: abs("r8\\config.template.json"),
    r8RuntimeConfig: abs("state\\r8-runtime.json"),
    coreRegistry: abs("runtime\\core.json"),
    r7Registry: abs("runtime\\r7.json"),
    r8Registry: abs("runtime\\r8.json"),
    r7Preference: abs("runtime\\r7-pref.json"),
    r8Preference: abs("runtime\\r8-pref.json"),
  };
}

describe("WinHelm v1.4.1 Phase 6 launcher / Setup Assistant contract", () => {
  test("recommends automatic only for a clean install and preserves existing mode", () => {
    assert.equal(recommendedInternalPortMode("clean"), "automatic");
    assert.equal(recommendedInternalPortMode("existing", "fixed"), "fixed");
    assert.equal(recommendedInternalPortMode("existing", "automatic"), "automatic");
    assert.throws(
      () => recommendedInternalPortMode("existing"),
      /refusing to infer migration state/
    );
  });

  test("clean automatic startup needs no user-selected internal ports", () => {
    const plan = resolveInternalPortLaunchPlan({ installationKind: "clean" });
    assert.equal(plan.mode, "automatic");
    assert.equal(plan.requiresUserPortInput, false);
    assert.equal(plan.core.selector, "auto");
    assert.equal(plan.r7.selector, "auto");
    assert.equal(plan.r8.selector, "auto");
    assert.equal(plan.public.port, 443);
    assert.equal(plan.public.exposureDefault, "inactive");
  });

  test("existing fixed install remains fixed without any migration", () => {
    const plan = resolveInternalPortLaunchPlan({
      installationKind: "existing",
      existingMode: "fixed",
      existingFixedPorts: fixed,
    });
    assert.equal(plan.mode, "fixed");
    assert.equal(plan.migration, "none");
    assert.equal(plan.core.selector, fixed.core);
    assert.equal(plan.r7.selector, fixed.r7);
    assert.equal(plan.r8.selector, fixed.r8);
  });

  test("existing fixed install cannot silently switch to automatic", () => {
    assert.throws(
      () =>
        resolveInternalPortLaunchPlan({
          installationKind: "existing",
          existingMode: "fixed",
          existingFixedPorts: fixed,
          requestedMode: "automatic",
        }),
      /EXPLICIT_MODE_CHANGE_REQUIRED/
    );

    const explicit = resolveInternalPortLaunchPlan({
      installationKind: "existing",
      existingMode: "fixed",
      existingFixedPorts: fixed,
      requestedMode: "automatic",
      explicitModeChange: true,
    });
    assert.equal(explicit.mode, "automatic");
    assert.equal(explicit.migration, "explicit_mode_change");
    assert.equal(explicit.requiresUserPortInput, false);
  });

  test("automatic mode rejects fixed port values instead of treating them as hints", () => {
    assert.throws(
      () =>
        resolveInternalPortLaunchPlan({
          installationKind: "clean",
          requestedMode: "automatic",
          requestedFixedPorts: fixed,
        }),
      /does not accept user-selected internal ports/
    );
  });

  test("clean fixed override remains available but requires explicit distinct ports", () => {
    const plan = resolveInternalPortLaunchPlan({
      installationKind: "clean",
      requestedMode: "fixed",
      requestedFixedPorts: fixed,
    });
    assert.equal(plan.mode, "fixed");
    assert.equal(plan.requiresUserPortInput, true);
    assert.throws(
      () =>
        resolveInternalPortLaunchPlan({
          installationKind: "clean",
          requestedMode: "fixed",
          requestedFixedPorts: { core: 18788, r7: 18788, r8: 19447 },
        }),
      /must be distinct/
    );
  });

  test("automatic process specs inject auto/discovery internally and expose no port input", () => {
    const plan = resolveInternalPortLaunchPlan({ installationKind: "clean" });
    const specs = buildRuntimeChainProcessSpecs(plan, paths());
    assert.deepEqual(
      specs.map((spec) => spec.role),
      ["core", "r7", "r8"]
    );

    const core = specs[0]!;
    assert.deepEqual(core.args.slice(1, 5), [
      "--port",
      "auto",
      "--host",
      "127.0.0.1",
    ]);

    const r7 = specs[1]!;
    assert.ok(r7.args.includes("--port=auto"));
    assert.ok(r7.args.includes("--backend-port=auto"));
    assert.ok(r7.args.some((arg) => arg.startsWith("--core-registry=")));
    assert.ok(r7.args.some((arg) => arg.startsWith("--core-entrypoint=")));

    const r8 = specs[2]!;
    assert.ok(r8.args.includes("--port=auto"));
    assert.ok(r8.args.includes("--r7-port=auto"));
    assert.ok(r8.args.some((arg) => arg.startsWith("--r7-registry=")));
    assert.ok(r8.args.some((arg) => arg.startsWith("--r8-registry=")));

    const rendered = specs.flatMap((spec) => spec.args).join("\n");
    assert.doesNotMatch(rendered, /(?:^|\D)18788(?:\D|$)/);
    assert.doesNotMatch(rendered, /(?:^|\D)64239(?:\D|$)/);
    assert.doesNotMatch(rendered, /(?:^|\D)19447(?:\D|$)/);
  });

  test("fixed process specs preserve numeric topology and do not require discovery arguments", () => {
    const plan = resolveInternalPortLaunchPlan({
      installationKind: "existing",
      existingMode: "fixed",
      existingFixedPorts: fixed,
    });
    const specs = buildRuntimeChainProcessSpecs(plan, paths());
    assert.ok(specs[0]!.args.includes("18788"));
    assert.ok(specs[1]!.args.includes("--port=64239"));
    assert.ok(specs[1]!.args.includes("--backend-port=18788"));
    assert.ok(specs[2]!.args.includes("--port=19447"));
    assert.ok(specs[2]!.args.includes("--r7-port=64239"));
    assert.ok(!specs[1]!.args.some((arg) => arg.startsWith("--core-registry=")));
    assert.ok(!specs[2]!.args.some((arg) => arg.startsWith("--r7-registry=")));
  });

  test("diagnostic topology is produced only from verified resolver results", async () => {
    const calls: Array<{ role: string; health?: string; probe: boolean }> = [];
    const topology = await resolveVerifiedInternalTopology(
      {
        core: {
          executablePath: abs("node.exe"),
          entrypointPath: abs("core\\dist\\index.js"),
          registryPath: abs("runtime\\core.json"),
        },
        r7: {
          executablePath: abs("node.exe"),
          entrypointPath: abs("r7\\live-server-dynamic-upstream.mjs"),
          registryPath: abs("runtime\\r7.json"),
        },
        r8: {
          executablePath: abs("r8\\winhelm-r8.exe"),
          entrypointPath: abs("r8\\winhelm-r8.exe"),
          registryPath: abs("runtime\\r8.json"),
          probeHealth: async () => ({
            status: "ok",
            server: "winhelm-r8",
          }),
        },
      },
      async (options) => {
        calls.push({
          role: options.role,
          health: options.expectedHealthServer,
          probe: typeof options.probeHealth === "function",
        });
        if (options.role === "r7") return undefined;
        return {
          role: options.role,
          generation:
            options.role === "core"
              ? "11111111-1111-4111-8111-111111111111"
              : "33333333-3333-4333-8333-333333333333",
          host: "127.0.0.1",
          port: options.role === "core" ? 50101 : 50303,
          pid: options.role === "core" ? 101 : 303,
        };
      }
    );

    assert.deepEqual(calls, [
      { role: "core", health: undefined, probe: false },
      { role: "r7", health: "winhelm-r7", probe: false },
      { role: "r8", health: "winhelm-r8", probe: true },
    ]);
    assert.equal(topology.public.port, 443);
    assert.equal(topology.internal.core.state, "ready");
    assert.equal(topology.internal.core.port, 50101);
    assert.equal(topology.internal.r7.state, "unavailable");
    assert.equal(topology.internal.r8.state, "ready");
    assert.equal(topology.internal.r8.port, 50303);
    assert.equal(topology.internal.r8.source, "verified_runtime");
  });

  test("runtime chain starts Core then R7 then R8 and waits for each verified readiness", async () => {
    const specs: ProcessSpec[] = (["core", "r7", "r8"] as const).map((role) => ({
      role,
      executable: abs(`${role}.exe`),
      args: [],
      cwd: abs(role),
    }));
    const events: string[] = [];
    const children: ManagedLaunchedProcess[] = [];

    const started = await launchRuntimeChain({
      specs,
      spawn: async (spec) => {
        events.push(`spawn:${spec.role}`);
        const child = {
          role: spec.role,
          stop: async () => {
            events.push(`stop:${spec.role}`);
          },
        };
        children.push(child);
        return child;
      },
      waitReady: async (role) => {
        events.push(`verified:${role}`);
      },
    });

    assert.equal(started.length, 3);
    assert.deepEqual(events, [
      "spawn:core",
      "verified:core",
      "spawn:r7",
      "verified:r7",
      "spawn:r8",
      "verified:r8",
    ]);
  });

  test("startup failure stops already-started children in reverse order", async () => {
    const specs: ProcessSpec[] = (["core", "r7", "r8"] as const).map((role) => ({
      role,
      executable: abs(`${role}.exe`),
      args: [],
      cwd: abs(role),
    }));
    const events: string[] = [];

    await assert.rejects(
      launchRuntimeChain({
        specs,
        spawn: async (spec) => ({
          role: spec.role,
          stop: async () => {
            events.push(`stop:${spec.role}`);
          },
        }),
        waitReady: async (role) => {
          events.push(`wait:${role}`);
          if (role === "r7") throw new Error("verified R7 unavailable");
        },
      }),
      /verified R7 unavailable/
    );

    assert.deepEqual(events, [
      "wait:core",
      "wait:r7",
      "stop:r7",
      "stop:core",
    ]);
  });
});
