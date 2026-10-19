# WinHelm v1.4.1 — Daily Operations Guide

Status: `RELEASE_CANDIDATE__PRODUCTION_CUTOVER_GATED`

## Recommended daily posture

For normal interactive engineering:

- Profile: **Balanced**
- Approval Mode: **Smart**
- Run as a standard user.
- Keep workspace folders narrowly scoped.
- Keep public ingress separate from Core lifecycle.
- Use Manual mode for especially sensitive work; use Trusted only when routine prompts are intentionally reduced.

## Starting WinHelm

Use the installed launcher for Core/stdio operation. Resolve the active local endpoint from verified runtime state rather than assuming a universal internal port; existing fixed installations remain fixed unless explicitly migrated. Public R8 ingress is a separate boundary: its Windows service is Manual and its public route is inactive by default. Installation-specific owner paths are not public API guarantees.

## First health checks

After startup:

```powershell
winhelm status
winhelm jobs
```

Expected high-level state:
- configuration parses;
- Core is healthy;
- active profile/mode are recognizable;
- Local-Control has a reachable current instance;
- no unexpected pending/failed approval condition blocks routine use.

For HTTP deployments, also check the local health endpoint defined by the active configuration.

## Approval workflow

CLI:

```powershell
winhelm jobs
winhelm approve <jobId>
winhelm deny <jobId>
```

Dashboard unlock:

```powershell
winhelm admin-code
```

The admin code is single-use/local-interactive and is intentionally not stored in plaintext.

## When prompts feel excessive

For ordinary work:
- prefer Balanced + Smart rather than Manual;
- confirm that the operation is not under a mandatory-confirmation floor;
- do not weaken profile/capability policy just to suppress prompts.

v1.4.1 includes Native Approval toast activation for routine approval flow. CLI/dashboard approval remains available as a fallback; capability denial and mandatory/explicit-confirmation floors remain stronger than Approval Mode.

## Public ingress

Treat R7 as a separately validated public edge. Do not restart/replace it casually when restarting local Core.

If a hosted client cannot connect:
1. check Core health;
2. check R7 health;
3. check route/OAuth state;
4. do not rewrite OAuth stores or Funnel routes as a first response.

## Safe restart rule

Restart the exact instance you own. Avoid broad `node.exe` / PowerShell cleanup because WinHelm may coexist with stdio and other Node processes.

## Logs and secrets

When sharing diagnostics:
- redact tokens/secrets;
- do not include Local-Control pipe/capability values;
- do not paste admin codes;
- avoid raw OAuth secrets;
- prefer hashes, counts, statuses, and redaction-safe identities.

## D1 in v1.4.1

D1 live mode/port 18791 remains outside active production scope. Do not treat its absence as an operational failure.

## Production-adoption boundary

The v1.4.1 source candidate supports Dynamic Internal Ports, but initial production adoption remains Fixed-first. Do not silently migrate an existing fixed installation to automatic topology. A live active-backend marker switch remains blocked until the guarded-commit primitive is separately qualified.

## End-of-day state

No special shutdown is required for documentation purposes. If stopping services manually:
- stop only known WinHelm-owned processes;
- preserve approval/control evidence;
- do not delete internal state as routine cleanup.
