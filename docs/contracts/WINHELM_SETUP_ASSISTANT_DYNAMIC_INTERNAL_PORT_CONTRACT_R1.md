# WinHelm Setup Assistant — Dynamic Internal Port Contract R1

Status: Phase 6 integration contract for WinHelm v1.4.1 dynamic internal ports.

This document is consumed by the separate Setup Assistant lane. It does not authorize mutation of `D:\mcp\winhelm-setup-assistant-r1`.

## Product rule

Normal users do not choose, reserve, remember, or troubleshoot Core/R7/R8 internal ports.

Public identity remains separate and stable:

- public scheme: HTTPS;
- public port: 443;
- public hostname/OAuth identity: unchanged;
- public exposure: inactive by default.

Internal endpoints are diagnostics, never public identity.

## UI contract

### Clean/new installation

Recommended internal-port mode:

`automatic`

Normal UI:

- show “Automatic (recommended)”;
- do not show Core/R7/R8 port text boxes;
- do not ask for a port number;
- do not pre-reserve/check ports;
- launch components with internal selector `auto`;
- display resolved endpoints only under Advanced/Diagnostics after verified readiness.

### Existing installation

The Setup Assistant must first recover the existing mode from trusted installation state.

If the existing mode is `fixed`:

- preserve the existing fixed Core/R7/R8 values;
- do not silently switch to `automatic`;
- a switch to Automatic requires an explicit user mode-change action.

If the existing mode is `automatic`:

- preserve Automatic;
- do not switch to fixed unless the user explicitly chooses Fixed and supplies the fixed topology.

If existing mode cannot be established safely:

- state = Blocked;
- no automatic migration;
- no inferred port-mode change.

## Machine-readable launcher input

Schema:

`prototype/dynamic-internal-ports/launcher/setup-assistant-dynamic-port-contract.schema.json`

Core fields:

```json
{
  "schema": 1,
  "installation": {
    "kind": "clean | existing",
    "existingMode": "automatic | fixed",
    "existingFixedPorts": {
      "core": 18788,
      "r7": 64239,
      "r8": 19447
    }
  },
  "internalPorts": {
    "mode": "automatic | fixed",
    "fixedPorts": {
      "core": 18788,
      "r7": 64239,
      "r8": 19447
    },
    "explicitModeChange": false
  }
}
```

Rules:

- `clean + automatic` requires no fixed-port object;
- `existing + fixed` reuses trusted existing values when no new fixed values are requested;
- any existing-mode change requires `explicitModeChange=true`;
- automatic mode rejects fixed-port values rather than treating them as hints;
- fixed Core/R7/R8 ports must be valid and distinct;
- public 443 is not part of the internal-port object.

## Secret boundary

Launcher config MUST NOT contain:

- Gemini Client Secret;
- bearer/auth token;
- admin code;
- OAuth access/refresh token;
- private key;
- password.

The R7 Gemini Client Secret is supplied ephemerally in process environment at action time.

The reference launcher rejects secret-bearing config field names before process startup.

Client ID and redirect URI are non-secret identity/configuration values and may be supplied.

## Launcher behavior

Reference launcher:

`prototype/dynamic-internal-ports/launcher/start-runtime-chain.mjs`

Plan-only:

```text
node start-runtime-chain.mjs --config=<absolute-config> --plan-only
```

Run ordering:

```text
Core start
-> verified Core readiness
-> R7 start
-> verified R7 readiness
-> R8 start
-> verified R8 readiness
-> WINHELM_RUNTIME_CHAIN_READY
```

A dependency is never started before its upstream dependency reaches the required verified-ready state.

On failure, already-started children are stopped in reverse order.

Public route activation is NOT part of normal chain startup. R8 must reach ready state with public route inactive.

## Automatic-mode process contract

Core:

```text
--port auto
--host 127.0.0.1
```

R7:

```text
--port=auto
--backend-port=auto
--core-executable=<trusted Node executable>
--core-entrypoint=<trusted Core entrypoint>
--core-registry=<Core default verified registry>
```

R8 supervisor:

```text
--port=auto
--r7-port=auto
--r7-executable=<trusted Node executable>
--r7-entrypoint=<trusted R7 entrypoint>
--r7-registry=<verified R7 registry>
--r8-registry=<R8 registry>
```

The user never supplies these internal `auto` selectors manually; the launcher derives them from product mode.

## Fixed-mode compatibility contract

Fixed mode remains a first-class recovery/debug/rollback path.

The launcher passes preserved numeric values to:

- Core listener;
- R7 listener;
- R7 Core backend;
- R8 listener;
- R8 R7 upstream.

Fixed mode does not require dynamic upstream discovery arguments.

No existing numeric configuration is rewritten merely because v1.4.1 supports Automatic.

## Diagnostics contract

Setup Assistant must not read mutable endpoint JSON and treat it as authority.

Use the verified topology adapter:

`resolveVerifiedInternalTopology(...)`

It invokes `resolveVerifiedRuntimeEndpoint(...)` for each dynamic component using trusted executable/entrypoint identities.

R8 additionally uses HTTPS/SNI generation-bound health verification because R8 is a TLS ingress.

Sanitized diagnostics may expose:

- role;
- ready/unavailable;
- loopback host;
- resolved internal port;
- generation;
- PID;
- source = `verified_runtime`.

Normal UI should show only product readiness. Advanced/Diagnostics may show the fields above.

Public status remains separately represented as HTTPS/443.

## Existing Setup Assistant fallback fields

The current Setup Assistant R1 contains fixed fallback values in:

`D:\mcp\winhelm-setup-assistant-r1\prototype\setup-assistant.config.json`

Those values remain compatibility inputs for the existing read-only prototype.

Phase 6 does not edit that workspace.

Future Setup Assistant integration should replace “receipt/config value first” authority for Automatic mode with the verified topology adapter described here.

Fallback numeric values may remain only for:

- legacy fixed installations;
- explicit fixed mode;
- recovery/rollback;
- clearly labeled compatibility display.

They must not be used as hidden defaults for a clean Automatic installation.

## Setup Assistant state-machine mapping

Clean install:

```text
NOT_INSTALLED
-> INSTALLABLE
-> explicit Install
-> internalPorts.mode = automatic (recommended)
-> orchestrated chain startup
-> verified Core/R7/R8
-> INSTALLED_READY
```

Existing fixed upgrade:

```text
INSTALLED_READY(fixed)
-> upgrade
-> preserve fixed mode and values
-> INSTALLED_READY(fixed)
```

Explicit fixed -> automatic migration:

```text
INSTALLED_READY(fixed)
-> user chooses Change internal-port mode
-> explicitModeChange = true
-> transaction/rollback receipt required
-> automatic chain qualification
-> INSTALLED_READY(automatic)
```

Migration transaction semantics remain owned by Setup Assistant's orchestration layer and must create rollback evidence.

## Phase ownership

Dynamic-port lane owns:

- mode semantics;
- verified runtime discovery;
- process argument contract;
- reference launcher;
- sanitized diagnostic adapter.

Setup Assistant lane owns later:

- UX controls;
- persisted installation-state schema;
- install/upgrade transaction;
- rollback receipt;
- packaging/bootstrapper;
- service installation wiring.

Phase 6 does not mutate production launchers, services, public route, OAuth identity, or the Setup Assistant workspace.
