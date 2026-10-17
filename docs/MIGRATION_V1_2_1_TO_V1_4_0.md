# WinHelm — Migration Guide: v1.2.1 to v1.4.0

Status: `FINAL_RC`

## Why this guide exists

v1.4.0 changes governance, Local-Control, tool surface, Approval Modes, and public-ingress behavior substantially from v1.2.1. The Final RC package metadata and lock are synchronized at `1.4.0`; migration must still be explicit rather than inferred from version metadata alone.

## Before migration

1. Back up WinHelm configuration/internal state.
2. Record the exact current version/source.
3. Record workspace/allowed-directory settings.
4. Record how clients launch WinHelm.
5. Record remote/public ingress separately.

Do not overwrite working R7/public ingress merely as part of a Core upgrade.

## Recommended migration target

Use Schema v2.

Recommended daily posture:
- Profile: Balanced
- Approval Mode: Smart

## Key conceptual changes

### Profiles are capability posture

Safe / Balanced / Power set folder, terminal, and tool authorization posture.

### Approval Mode is separate

Manual / Smart / Trusted controls prompting for actions that are already permitted.

Approval Mode cannot grant a capability that the profile/security layer denied.

### Mandatory confirmation remains

Some high-impact operations ask even in Trusted.

## Local-Control

v1.4 introduces the multi-instance Local-Control registry model.

Expected:
- HTTP Core and stdio instances may coexist;
- multiple live Local-Control registry records are not inherently an error;
- CLI can use preferred pointer/registry fallback.

Do not clean internal control records broadly during migration.

## Client configuration

Re-run supported connector/configuration helpers if final v1.4.0 release notes require it.

Preserve unrelated MCP server entries when modifying Claude/Cursor/client configuration.

## Network/public ingress

Do not expose the Core directly just because local upgrade succeeds.

Keep public ingress/auth configuration bounded and use the accepted R7 path defined by final release closure.

## Approval UX

Migrating to v1.4.0 does not yet provide Windows toast approvals. Web/CLI approval remains normal.

## D1

Do not migrate/enable D1 live mode in v1.4.0.

## Rollback

Rollback should restore the exact prior application/config baseline, not historical transient control metadata.

Do not:
- restore old `control.json` blindly;
- delete all `control.d`;
- kill all Node processes;
- rewrite public routes.

## Final migration validation

After upgrade:
- configuration parses;
- expected profile/mode are active;
- Core health passes;
- Local-Control CLI works;
- tool surface matches final release expectation;
- approvals behave as expected;
- hosted ingress remains healthy where configured.

Final validation should use the exact RC/release artifact recorded in the consolidated release report. External publication of `v1.4.0` remains a separate Owner-authorized step.
