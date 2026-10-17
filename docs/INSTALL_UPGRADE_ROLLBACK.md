# WinHelm v1.4.0 — Install, Upgrade, and Rollback Guide

Status: `FINAL_RC__PUBLISH_PENDING_OWNER_AUTHORIZATION`

## 1. Requirements

- Windows 10/11 or supported Windows Server.
- Node.js >= 20 for Node-based installation.
- Windows PowerShell 5.1 minimum.
- PowerShell 7+ recommended.
- Standard-user account recommended.

## 2. Fresh install from source

```powershell
git clone <final-repository-url>
cd winhelm-mcp
npm ci
npm run build
npm test
```

Until the Owner authorizes publication, install from the exact Final RC artifact/commit recorded in the release report rather than assuming a public `v1.4.0` tag exists.

## 3. Initial configuration

Recommended daily profile:

```powershell
winhelm setup --preset balanced --folder "D:\Workspace" --yes
```

Schema-v2 product presets default to Smart Approval Mode unless explicitly overridden.

Review generated folder permissions before using broad workspace roots.

## 4. Start locally

HTTP/gateway:

```powershell
winhelm
```

stdio:

```powershell
winhelm --stdio
```

Read-only session:

```powershell
winhelm --read-only
```

## 5. Upgrade from an earlier configuration

Before upgrade:

```powershell
Copy-Item "$HOME\.winhelm" "$HOME\.winhelm.backup-pre-v1.4" -Recurse
```

If migrating a legacy config, use the product's migration/setup path and review the resulting Schema-v2 profile/folder/approval settings before activation.

Key behavioral change:
- v1.4 product profiles and Approval Modes are distinct dimensions.
- Approval Mode cannot expand profile/capability authority.

## 6. RC upgrade checklist

Before switching a production installation:

- stop only the exact owner-controlled instance being replaced;
- record exact current source/runtime/config identity;
- verify config parses;
- verify backup/rollback source;
- verify target build/type-check/tests;
- verify target health on loopback;
- verify Local-Control status;
- verify hosted ingress separately;
- never use broad process cleanup.

The accepted production posture keeps the R8 ingress service Manual and its public route inactive by default. Core upgrades must not silently change that posture.

## 7. Rollback principles

Rollback must be:
- exact;
- bounded;
- based on recorded prior source/config/launcher identities;
- free of broad PID/process-tree cleanup.

Do not restore stale Local-Control metadata blindly.

Do not copy historical `control.json` bytes over current state.

Let a restored process establish its own current control metadata.

## 8. Public ingress rollback

R7/public ingress is a separate layer from Core.

A Core rollback must not silently modify:
- accepted R7 source;
- Funnel routes;
- hosted-client OAuth stores;
- protected launchers.

Any R7 replacement/rollback requires its own accepted plan.

## 9. v1.4.0 exclusions

Do not install/enable D1 live mode as part of v1.4.0.

D1 port 18791 is deferred and should remain absent.

## 10. Final artifact identity

The consolidated Final RC report records the exact release commit candidate, npm tarball filename/size/SHA-256, and rollback parent. The prospective public tag is `v1.4.0`; do not push/create the final external tag or publish npm until explicit Owner authorization.
