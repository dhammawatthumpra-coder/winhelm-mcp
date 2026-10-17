# WinHelm v1.4.0 — Troubleshooting Guide

Status: `FINAL_RC`

## Principle: diagnose the smallest layer first

WinHelm can have several cooperating layers:
- local Core;
- stdio instances;
- Local-Control registry;
- CLI;
- R7 public ingress;
- hosted-client OAuth;
- Funnel/public routing.

Avoid broad restarts. Identify which layer is actually unhealthy.

## 1. `winhelm status` cannot connect

Check:
- a WinHelm instance is running;
- Local-Control metadata exists;
- the pointed/registry process is live;
- the active candidate/root is the intended installation.

Do not delete all Local-Control metadata as a first response.

A stale compatibility pointer may coexist with a healthy registry; the client can use registry fallback.

## 2. Multiple Local-Control owners appear

This is not automatically a fault.

v1.4 supports concurrent WinHelm instances such as:
- one HTTP Core;
- one or more stdio clients/processes.

The critical distinction is role and current process identity, not simply total owner count.

Do not kill stdio processes just to force a singleton registry.

## 3. Dashboard approval feels stuck

Check:

```powershell
winhelm jobs
```

Then decide through CLI if appropriate:

```powershell
winhelm approve <jobId>
winhelm deny <jobId>
```

For dashboard privileged access, generate a fresh single-use local admin code:

```powershell
winhelm admin-code
```

Do not copy a previously consumed/expired code.

## 4. Too many approval prompts

Confirm:
- current profile;
- current Approval Mode;
- risk class of the action;
- whether the action has mandatory confirmation.

Recommended normal posture is Balanced + Smart.

Do not switch to Trusted merely to work around an action that is intentionally mandatory-confirmation gated.

## 5. Core healthy but hosted client fails

Treat this as R7/OAuth/routing first.

Check:
- R7 health;
- OAuth metadata;
- route/discovery;
- client-specific compatibility.

Do not mutate Core merely because a hosted client failed.

## 6. R7 healthy but client reports stale/session errors

Reconnect the client and verify current session/bootstrap behavior before restarting servers. Historical stale-session issues have dedicated corrective lineage; broad server cleanup is not the preferred recovery.

## 7. Funnel/public route mismatch

Do not repair by issuing broad Funnel/Serve changes without an accepted route decision.

First capture current status read-only and compare expected routes.

## 8. Production process disappeared

Determine:
- which exact process disappeared;
- whether its launcher/parent context remains;
- whether another transport instance is still healthy.

Do not use broad `Stop-Process -Name node` / taskkill patterns.

## 9. Config parse/startup failure

WinHelm is intended to fail closed on corrupt/invalid configuration.

Repair or restore the exact config rather than bypassing validation.

## 10. Filesystem operation denied

Check:
- Schema v2 folder permission;
- canonical resolved path;
- protected-internal-path rule;
- profile policy;
- read-only mode.

A denied protected path should not be made writable by switching Approval Mode.

## 11. D1 / port 18791

For v1.4.0:
- D1 live mode is deferred;
- port 18791 should remain absent;
- do not treat absence as an error.

## 12. When to rollback

Rollback when an accepted current production component itself is proven unhealthy and an exact prior baseline is available.

Do not rollback because:
- a later handoff describes an older snapshot;
- a client compatibility lane is still under isolated qualification;
- a deferred feature is intentionally disabled.

## Diagnostic sharing

Prefer:
- exact file hashes;
- versions;
- listener counts;
- HTTP status;
- sanitized error codes;
- redaction-safe process identity;
- timestamps.

Never share secrets or raw sensitive control metadata.
