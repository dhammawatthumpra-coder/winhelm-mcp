# WinHelm v1.4.0 — Install, Upgrade, and Rollback Guide

For the shortest clean-install path, start with [MANUAL_INSTALL.md](MANUAL_INSTALL.md). This document covers the more detailed operator/upgrade/rollback boundary.

## 1. Requirements

- Windows 10/11 or supported Windows Server.
- Node.js >= 20 for Node-based installation.
- Windows PowerShell 5.1 minimum; PowerShell 7+ recommended.
- Standard-user account recommended for routine use.
- Administrator rights only for operations that explicitly require them.

## 2. Supported installation paths

### Published npm package

```powershell
npm install --global winhelm-mcp@1.4.0
winhelm --help
```

### Exact release tarball

```powershell
Get-FileHash .\winhelm-mcp-1.4.0.tgz -Algorithm SHA256
npm install --global .\winhelm-mcp-1.4.0.tgz
winhelm --help
```

Verify the tarball hash against the release record before installing it.

### Source checkout

```powershell
git clone <WINHELM_REPOSITORY_URL>
cd winhelm-mcp
git checkout v1.4.0
npm ci
npm run build:native
npm run build
npm run lint:tools
```

Source builds are intended for maintainers/developers; normal users should prefer the published package or exact reviewed tarball.

## 3. Initial configuration

Preview a Balanced profile with an explicit workspace:

```powershell
winhelm setup --preset balanced --folder "D:\Workspace" --dry-run
```

Apply after review:

```powershell
winhelm setup --preset balanced --folder "D:\Workspace" --yes
```

Schema-v2 product presets default to Smart Approval Mode unless explicitly changed through the supported controls. Review generated folder permissions before using broad workspace roots.

## 4. Local startup and client connection

HTTP/SSE gateway and Dashboard:

```powershell
winhelm
```

stdio:

```powershell
winhelm --stdio
```

Read-only:

```powershell
winhelm --read-only
```

Preview and apply client connection:

```powershell
winhelm connect claude --dry-run
winhelm connect claude --yes

winhelm connect cursor --dry-run
winhelm connect cursor --yes
```

Public R8 ingress is a separate deployment boundary and is not required for local Claude/Cursor operation.

## 5. Upgrade from an earlier configuration

Before upgrade:

```powershell
Copy-Item "$HOME\.winhelm" "$HOME\.winhelm.backup-pre-v1.4" -Recurse
```

Preview legacy migration:

```powershell
winhelm setup --migrate-legacy --folder "D:\Workspace" --dry-run
```

Apply only after review:

```powershell
winhelm setup --migrate-legacy --folder "D:\Workspace" --yes
```

Key behavioral changes:

- v1.4 product profiles and Approval Modes are distinct dimensions.
- Approval Mode cannot expand profile/capability authority.
- wildcard legacy access does not silently become broad Schema-v2 authority;
- protected/internal paths and mandatory confirmation remain fail-closed.

See [MIGRATION_V1_2_1_TO_V1_4_0.md](MIGRATION_V1_2_1_TO_V1_4_0.md).

## 6. Production upgrade checklist

Before switching an existing installation:

- identify the exact current package/source/configuration;
- back up the user configuration/state needed for rollback;
- stop only the exact owner-controlled instance being replaced;
- verify the target package hash/version;
- verify configuration parses and the intended profile/folders are present;
- verify the v1.4.0 native boundary loads;
- verify loopback health reports version 1.4.0;
- verify Local-Control status;
- verify client configuration independently;
- verify hosted/public ingress separately if used;
- never use broad process cleanup as an upgrade mechanism.

The accepted v1.4.0 production posture keeps the R8 ingress service Manual and its public route inactive by default. A Core upgrade must not silently change that posture.

## 7. Rollback principles

Rollback must be:

- exact and bounded;
- based on a recorded prior package/source/configuration;
- limited to the instance being replaced;
- free of broad PID/process-tree cleanup;
- explicit about Schema-v2 versus legacy configuration compatibility.

Do not restore stale Local-Control metadata blindly. In particular, do not copy historical control-pointer bytes over current state. Let a restored process establish its own current control metadata.

## 8. Package rollback

Example:

```powershell
npm uninstall --global winhelm-mcp
npm install --global winhelm-mcp@<PREVIOUS_VERSION>
```

If the previous package expects an older configuration format, restore the corresponding reviewed configuration backup as part of the same rollback plan.

## 9. Public ingress rollback

R8/public ingress is a separate layer from Core.

A Core rollback must not silently modify:

- accepted R7/R8 source or service deployment;
- public routes;
- hosted-client OAuth stores;
- protected launchers/control state.

Public-route activation/deactivation must use the accepted explicit control path. The normal release posture is public route inactive.

## 10. v1.4.0 exclusions

Do not install/enable D1 live mode as part of v1.4.0.

D1 port 18791 is deferred and should remain absent.

Windows toast/native approval UX and native tray UX are not installation prerequisites. The Web Dashboard/CLI flow is the supported v1.4.0 baseline.

The separate WinHelm Setup Assistant is optional and follows its own release lifecycle. Manual installation remains supported and canonical.

## 11. Verification after install/upgrade

Minimum verification:

```powershell
winhelm --help
```

Then start WinHelm and check:

```text
http://127.0.0.1:8788/health
```

Expected release version: `1.4.0`.

For local MCP clients, restart/reload the client and verify that WinHelm is discoverable. For hosted/public clients, follow [CLIENTS_R7_CONNECTIVITY.md](CLIENTS_R7_CONNECTIVITY.md) and preserve the inactive-by-default public route posture when remote access is not required.
