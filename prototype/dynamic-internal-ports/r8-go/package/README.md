# WinHelmGoTlsIngressHardeningR1 package

This is an isolated corrective candidate package. It is not a production installation and does not authorize cutover.

The normal service command is:

```text
winhelm-go-tls-ingress-hardening-r1.exe --config <approved-config> --service
```

The normal service command never performs `--login`. Enrollment is a separate explicit one-shot administrative action through `enroll.ps1 -Apply`; the service identity must not be allowed to invoke that action.

Before the service is started, an Owner/admin must protect the runtime tree and obtain a verification PASS: run `prepare-acl.ps1` (dry-run by default), then `prepare-acl.ps1 -Apply`, then `verify-acl.ps1` must report `PASS class=acl_floor`. The model disables ACL inheritance on the candidate root and protects `config.json`, the executable, package files, `state`, and `logs`, plus the exact host-state directory `<candidate-root>\state\<host>` derived from the config `host` value (trimmed, lowercased, validated as a single DNS label; never hard-coded); the service identity receives read/execute only on immutable files and modify only under `state`/`logs`; broad principals receive no write. If the service has not yet been registered, pass the dedicated service SID explicitly to `-ServiceIdentity`. `prepare-acl.ps1 -Apply` protects deepest paths first (so directory protection never blocks traversal of a not-yet-processed child), pre-stages the exact host-state directory as an empty structural path before final verification (no tsnet state, marker, or credential), and writes `package\acl-rollback-snapshot.json` with the exact pre-apply SDDL for every touched path; it self-rolls back on failure. Restore with `prepare-acl.ps1 -RestoreFrom <snapshot> -Apply`: it returns parents to their original DACL before their children and removes paths that `-Apply` created, including the pre-staged host-state directory (children-first so a created parent is empty before removal). `verify-acl.ps1` requires a protected DACL (`SE_DACL_PROTECTED`) on every canonical surface (candidate root, `config.json`, executable, package, `state`, the exact host-state directory, and `logs`), while runtime descendants strictly beneath `state\<host>` and `logs` may inherit the protected root ACL as long as their effective ACL stays broad-write-free, still carries the exact service identity, and contains no reparse path. The DACL is the only section restored; `-Apply` never alters owner/group. Run `verify-acl.ps1` from an elevated Owner/admin session, or pass the same `-OperatorIdentity`/`-OperatorStateRead` flags so a non-elevated operator can traverse the protected tree; if the tree cannot be traversed, verification fails closed with `WALK_DENIED`. A named operator identity (`-OperatorIdentity`) is explicit and read-only: it receives `ReadAndExecute` (never write) on the runtime tree, and `-OperatorStateRead` is additionally required for any operator access to sensitive `state`. No package script may be run with `-Apply` in a non-privileged worker lane. The service package must use an explicit working directory, config path, state root, startup readiness contract, bounded restart policy, and local rotated structured logs. No Phase B state, OAuth state, DPAPI material, credentials, or logs may be copied into this package.

## Service recovery policy (R6)

The accepted bounded Windows SCM recovery policy for this service is:

- reset failure count after `86400` seconds;
- failure action 1: restart after `30000` ms;
- failure action 2: restart after `300000` ms;
- failure action 3: none (terminal);
- no reboot action and no recovery command;
- `FAILURE_ACTIONS_ON_NONCRASH_FAILURES = TRUE` (non-crash failures count as failures).

Canonical SCM intent:

```text
reset=86400; actions=restart/30000,restart/300000,none/0; failureflag=true
```

Mechanism note: `sc.exe failure` accepts only `run|restart|reboot` action tokens and cannot materialize the required explicit terminal `none` action; additionally, the SCM repeats the last configured action when failures exceed the configured array, so a two-element restart array would restart without bound. The exact bounded event order `[(RESTART,30000),(RESTART,300000),(NONE,0)]` plus the non-crash failure flag is therefore materialized through `ChangeServiceConfig2` (`SERVICE_CONFIG_FAILURE_ACTIONS` and `SERVICE_CONFIG_FAILURE_ACTIONS_FLAG`), never through `sc.exe failure`.

`configure-recovery.ps1` is dry-run by default and prints the sanitized plan; `-Apply` is an Owner/admin lane action that requires the service to exist and remain STOPPED, configures the policy above, and then requires `verify-recovery.ps1` to report `PASS class=recovery_policy` before returning `RECOVERY_CONFIGURED`. Neither script ever starts the service.

`verify-recovery.ps1` is read-only and fail-closed with stable machine-readable PASS/FAIL classes. It checks `sc.exe qfailure`, `sc.exe qfailureflag`, the service status, and the raw `FailureActions` registry blob. The terminal `none` action is not visible in `qfailure` display output, so the registry blob (`resetPeriodSeconds` at offset 0, action count at offset 12, `{type,delay}` entries at offset 20) is the authoritative boundedness check; a policy whose last configured action is not `none/0` fails as `none_terminal_missing` because the SCM would repeat that last action.

`install-service.ps1` runs configure-then-verify after registration, while the service is stopped, and before its final `INSTALLED_STOPPED` output; if either step fails, the existing self-rollback removes the service. The R6 package regression harness is `regression-recovery.ps1` (read-only; never uses `-Apply`).

Upgrade and rollback are separate bounded operations. Each operation must preserve the state marker and independently verify the binary/config manifest before returning success. `upgrade.ps1` and `rollback.ps1` are dry-run by default and require `-Apply`.

## Native service host (R7)

The corrective binary is a native Windows service host: it dispatches through `golang.org/x/sys/windows/svc` (`svc.Run` under the registered name `WinHelmGoTlsIngressHardeningR1`). It publishes `StartPending` (wait hint 30000 ms, checkpoint every 5000 ms) immediately, and publishes `Running` (accepting `stop`/`shutdown`) only after true local readiness: the local listener is up, the public route is confirmed inactive, and the sanitized local status surface has been written. `Stop`/`Shutdown` transitions through `StopPending`, cancels the process context, and waits for the bounded shutdown cleanup (hard cap 45 minutes; the process still reports a zero exit for a requested stop). Startup or runtime failure returns a nonzero service exit code (`1`) so the accepted SCM recovery policy (`restart/30000, restart/300000, none/0; failureflag=true`) engages deterministically.

Service mode never performs interactive enrollment: `--login` is refused before the service dispatcher is entered and enrollment remains the explicit one-shot console action through `enroll.ps1 -Apply`. Invoking the executable in a console without `--config` fails closed; there is no interactive default lane.

## Explicit service mode (R8)

The production service lane is selected by an explicit `--service` argument that the registered service ImagePath carries; startup enters `svc.Run` directly after argument parsing and never depends on `svc.IsWindowsService()` returning true. The live R7 start proved that SCM-context autodetection can return the ordinary ingress path even though the SCM launched the registered service (`SCM_CONTEXT_AUTODETECTION_FALSE_NEGATIVE__EXPLICIT_SERVICE_MODE_REQUIRED`), so the detector is no longer on the production service happy path. It remains only as a secondary hardening net for a non-flagged SCM launch, and a detection error is fail-closed (no silent console fallback).

Fail-closed rules are unchanged and explicit: `--service` combined with `--login` is refused as `--login is not available in service mode` before the dispatcher is entered; `--service` without `--config` is refused as `--config is required`; the ordinary console lane still refuses both cases. Service name, identity, SID, recovery policy, config, listener, and upstream are unchanged.

## Foreground-aware route inactivity (R8)

Route inactivity detection covers the top-level `AllowFunnel` entry for the configured host, any TCP handler on port 443, any funnel entry, and the `Foreground` serve sessions with the same predicate. A foreground `tailscale serve` session that exposes TCP/443 or a funnel mapping therefore counts as active exposure: startup no longer mistakes it for inactivity. A stale foreground route is cleared with the same readback verification (`PUBLIC_SERVE_STALE_CLEARED` + `PUBLIC_ROUTE_CONFIRMED_INACTIVE`), and the sanitized readiness/status evidence reports the Foreground-aware inactive verdict without logging raw `ServeConfig` content.

## Public activation decoupling (R7)

Normal startup no longer activates a Funnel route. Startup only confirms that the public route is inactive (Foreground-aware as of R8), at two stages (before the local listener and again before readiness), and it fails closed if inactivity cannot be confirmed; a stale route left by a previous instance is cleared with a readback check (`PUBLIC_SERVE_STALE_CLEARED`). The local listener therefore becomes ready while the public route is inactive (`GO_TLS_INGRESS_READY` carries `public_route=inactive`).

Public activation is a separate explicit admin action processed by the same running service, the single tsnet owner of the state directory. The admin helper writes a one-shot activate/deactivate request only when the service is Running, the control directory exists, and no request is already pending; the helper never chooses or authorizes an internal port. Legacy fixed mode keeps 127.0.0.1:19447 compatibility. Dynamic runtime mode re-reads current r8.json at activation time, requires generation/PID/executable/effective-listener identity to match the running R8 process, performs HTTPS/SNI generation-bound self-health, applies public HTTPS 443 only to that verified listener, verifies the same target again after apply, and clears the route if identity changes. status.json exposes the stable public host/port plus sanitized internal_target listener/generation/PID/verification fields, and public-route-status.ps1 checks that dynamic listener and its owning PID instead of assuming port 19447.
