# WinHelm v1.4.0 — Manual Installation Guide

This is the canonical installation path for WinHelm v1.4.0. The separate WinHelm Setup Assistant is optional and is released on its own lifecycle; it is not required to install, configure, connect, upgrade, or operate the v1.4.0 core.

## 1. Requirements

- Windows 10/11 or supported Windows Server.
- 64-bit Windows recommended.
- Node.js >= 20.0.0.
- Windows PowerShell 5.1 minimum; PowerShell 7+ recommended.
- A standard-user account for routine operation.
- Administrator rights only for operations that explicitly require them, such as Windows service installation.

Verify Node and npm:

```powershell
node --version
npm --version
```

## 2. Install WinHelm

### Option A — npm release (recommended after publication)

```powershell
npm install --global winhelm-mcp@1.4.0
winhelm --help
```

### Option B — exact release tarball

Use this when installing an exact reviewed artifact or when the npm registry is not the desired source:

```powershell
npm install --global .\winhelm-mcp-1.4.0.tgz
winhelm --help
```

Verify the tarball SHA-256 against the release record before installation:

```powershell
Get-FileHash .\winhelm-mcp-1.4.0.tgz -Algorithm SHA256
```

### Option C — source checkout (maintainers/developers)

```powershell
git clone <WINHELM_REPOSITORY_URL>
cd winhelm-mcp
git checkout v1.4.0
npm ci
npm run build:native
npm run build
npm run lint:tools
```

Source builds require the supported Windows native build toolchain. Normal end users should prefer the published npm package or exact release tarball.

## 3. Verify the command

```powershell
winhelm --help
```

The v1.4.0 release surface contains 56 canonical public tools. Native-dependent operations fail closed if the qualified native boundary is unavailable; WinHelm does not silently downgrade to a weaker native path.

## 4. Configure permissions

For a normal workstation, start with the Balanced product profile and Smart Approval Mode.

Preview first:

```powershell
winhelm setup --preset balanced --folder "D:\Workspace" --dry-run
```

Apply after reviewing the preview:

```powershell
winhelm setup --preset balanced --folder "D:\Workspace" --yes
```

You may repeat `--folder` for additional roots:

```powershell
winhelm setup --preset balanced --folder "D:\Work" --folder "C:\Projects" --dry-run
```

The setup command creates Schema-v2 configuration. Product profile and Approval Mode are separate controls: an Approval Mode can change prompting behavior for an already-permitted action, but cannot expand the selected profile/capability boundary or bypass mandatory confirmation.

For profile details, see [PROFILES.md](PROFILES.md).

## 5. Start WinHelm locally

Start the loopback HTTP/SSE gateway and Web Dashboard:

```powershell
winhelm
```

Default local dashboard:

```text
http://127.0.0.1:8788/
```

Read-only session:

```powershell
winhelm --read-only
```

stdio mode for local MCP clients:

```powershell
winhelm --stdio
```

When a client is configured through the WinHelm connection helper, that client normally launches the stdio process itself; you do not need to keep a separate manual stdio process running.

## 6. Connect Claude Desktop or Cursor

Always preview client configuration changes first.

Claude Desktop:

```powershell
winhelm connect claude --dry-run
winhelm connect claude --yes
```

Cursor:

```powershell
winhelm connect cursor --dry-run
winhelm connect cursor --yes
```

Both:

```powershell
winhelm connect all --dry-run
winhelm connect all --yes
```

The helper preserves unrelated MCP entries and creates a backup when it writes an existing client configuration. Fully restart/reload the client after applying the connection.

For ChatGPT/OpenAI and qualified Gemini/R8 connectivity, see [CLIENTS_R7_CONNECTIVITY.md](CLIENTS_R7_CONNECTIVITY.md). Public ingress is not required for local Claude/Cursor use.

## 7. Use approvals

For local dashboard administration:

```powershell
winhelm admin-code
```

Then open:

```text
http://127.0.0.1:8788/
```

CLI approval flow:

```powershell
winhelm jobs
winhelm approve <jobId>
winhelm deny <jobId>
```

WinHelm v1.4.0 intentionally retains Web Dashboard and CLI approval. Windows toast/native approval UX is deferred to a later release.

## 8. Upgrade from v1.2.1

Back up the current user state before migration:

```powershell
Copy-Item "$HOME\.winhelm" "$HOME\.winhelm.backup-pre-v1.4" -Recurse
```

Preview legacy migration:

```powershell
winhelm setup --migrate-legacy --folder "D:\Workspace" --dry-run
```

Apply only after reviewing the proposed result:

```powershell
winhelm setup --migrate-legacy --folder "D:\Workspace" --yes
```

Wildcard legacy access does not silently become broad Schema-v2 access; explicit folders may be required. See [MIGRATION_V1_2_1_TO_V1_4_0.md](MIGRATION_V1_2_1_TO_V1_4_0.md).

## 9. Basic verification

After startup:

1. Confirm the process stays running without a fail-closed configuration/native error.
2. Open `http://127.0.0.1:8788/health`.
3. Confirm the reported version is `1.4.0`.
4. Confirm the intended profile/folders before allowing mutating work.
5. For Claude/Cursor, restart the client and confirm the WinHelm MCP server/tools appear.
6. If an approval-gated action is tested, confirm it appears in the Dashboard/CLI and executes at most once after approval.

## 10. Rollback

Before rollback, preserve the current configuration and identify the exact prior package/configuration you intend to restore.

Remove the current global package if needed:

```powershell
npm uninstall --global winhelm-mcp
```

Install the exact earlier package version or reviewed tarball:

```powershell
npm install --global winhelm-mcp@<PREVIOUS_VERSION>
```

Do not blindly copy stale Local-Control metadata such as historical control pointers over live state. Let the restored process establish its own current Local-Control metadata. If rolling back across Schema-v2/legacy boundaries, restore the matching reviewed configuration backup rather than assuming the newer configuration is backward-compatible.

See [INSTALL_UPGRADE_ROLLBACK.md](INSTALL_UPGRADE_ROLLBACK.md) for the detailed operator procedure.

## 11. Public ingress is optional

Local WinHelm operation does not require public exposure.

The qualified v1.4.0 R8 public-ingress posture is:

- Windows ingress service: Manual.
- Public route: inactive by default.
- Public exposure: enabled only through the accepted explicit control path when required.
- D1 / port 18791: not part of active v1.4.0 scope.

Do not expose a local WinHelm endpoint to a non-loopback interface without the documented authentication and network safety controls.

## 12. WinHelm Setup Assistant

The WinHelm Setup Assistant is a separate companion UX release. It may automate installation, configuration preview, client connection, validation, and recovery, but it does not replace the supported manual procedure above.

This separation keeps the v1.4.0 core independently installable and allows Setup Assistant UX to evolve without delaying or mutating the security-reviewed core release.

## Next references

- [Install / Upgrade / Rollback](INSTALL_UPGRADE_ROLLBACK.md)
- [Profiles and Approval Modes](PROFILES.md)
- [Clients and Connectivity](CLIENTS_R7_CONNECTIVITY.md)
- [Daily Operations](DAILY_OPERATIONS.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Known Limitations](KNOWN_LIMITATIONS.md)
- [v1.4.0 Release Notes](RELEASE_NOTES_V1_4_0.md)
