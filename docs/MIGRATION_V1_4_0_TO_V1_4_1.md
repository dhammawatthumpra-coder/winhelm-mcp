# WinHelm — Migration Guide: v1.4.0 to v1.4.1

Status: `RELEASE_CANDIDATE__NO_SILENT_AUTHORITY_EXPANSION`

v1.4.1 adds operational UX and topology capabilities while preserving the v1.4 security model. Migration must remain explicit and fail closed.

## 1. Before migration

- Record the current installation root, Git/package identity, active configuration, and rollback source.
- Preserve the current fixed/automatic topology choice.
- Record public-ingress and OAuth state separately from Core.
- Do not copy secrets, bearer tokens, admin codes, OAuth values, or approval activation tokens into migration evidence.

## 2. Internal-port behavior

Existing fixed installations remain fixed by default. Do not silently migrate Fixed -> Automatic.

For an explicitly authorized clean/automatic topology, v1.4.1 may use OS-selected internal listeners. Treat verified runtime state—not an unverified registry hint or remembered port—as authority for the current endpoint.

## 3. Native Approval integration

Native Approval installation is a separate live-state operation.

- Exact current Registry command and shortcut identity determine ownership.
- Foreign commands/shortcuts must be preserved fail-closed.
- Missing/corrupt installer receipt metadata does not override exact live state.
- Persisted receipt history must never restore arbitrary prior commands.
- Rollback within a failed install/upgrade transaction may use the transaction's in-memory pre-state only.

## 4. Setup Assistant

The standalone Setup Assistant companion executable is not yet shipped in this release candidate. Do not configure launch paths to a nonexistent companion and do not treat Dashboard `unavailable` status as a migration failure.

## 5. Public ingress and OAuth

Migration of Core must not silently change:

- R7/R8 source/runtime;
- Funnel/public routes;
- hosted-client OAuth registrations/secrets;
- the R8 Manual service posture;
- the public-route inactive-by-default policy.

The accepted hosted/public protocol identity remains HTTPS/443 when explicitly active.

## 6. D1

D1 live mode/port 18791 remains outside active v1.4.1 production scope unless separately re-adjudicated.

## 7. Production active-backend switch

Do not switch the live active-backend marker through an ordinary check-then-replace write. Production cutover remains blocked until the marker guarded-commit primitive is separately qualified.

If current marker/config state differs from the recorded expected state, stop and preserve the external state for adjudication.

## 8. Rollback

Rollback must be exact and bounded:

- restore only the explicitly accepted prior Core/config/launcher identity;
- do not broadly kill Node/PowerShell processes;
- do not overwrite external marker/config changes;
- do not rewrite OAuth/public-route state as a side effect;
- preserve foreign Native Approval registration/shortcut state.

## 9. Validation

Before any production switch:

- verify target package/runtime identity is `1.4.1`;
- run accepted type-check/build/canonical qualification;
- verify the intended local topology without mutating the existing production topology;
- verify Native Approval state independently;
- verify public ingress separately;
- verify rollback material;
- require the marker guarded-commit qualification before live marker mutation.

## 10. Publication boundary

This migration guide does not authorize production cutover, public route activation, tag creation, npm publication, or GitHub release.
