# WinHelm v1.4.2 — Release Notes

Status: `OFFICIAL_RELEASE`

WinHelm v1.4.2 is a maintenance and documentation sanitization patch following the v1.4.1 operational usability release. It synchronizes release identity across npm and GitHub, sanitizes public repository documentation, and packages the companion Setup Assistant asset for streamlined deployment.

## Key Changes in v1.4.2

### 1. Repository & Documentation Sanitization
- Removed internal sprint work orders, implementation contracts, draft plans, and raw local test traces from the public repository and distribution tarball.
- All internal filesystem paths and developer-specific references have been cleansed.
- Kept documentation focused on operational, architectural, reference, and security guides (`ARCHITECTURE_V1_4.md`, `TOOLS.md`, `PROFILES.md`, `SECURITY.md`, `THREAT_MODEL.md`, `TROUBLESHOOTING.md`, etc.).

### 2. Synchronized Version Identity
- Package, manifest, and runtime identities are fully synchronized at `1.4.2`.
- Endpoints (`/health`) and version commands (`winhelm --version`) authoritatively report `1.4.2`.
- Published as official package `winhelm-mcp@1.4.2` on the npm registry.

### 3. Setup Assistant Companion Asset
- Shipped `WinHelm-Setup-Assistant-v1.4.1.zip` as an official companion asset attached to the GitHub release.
- Provides a turnkey local workspace configuration and setup experience for Windows workstations.

### 4. Preserved Runtime & Security Capabilities
- Retains all **56 canonical public tools** with single source of truth registry validation.
- Retains **Dynamic Internal Ports** capability with automatic OS port allocation and fixed-port backward compatibility.
- Retains **Native Approval UX** with Windows toast notifications and live-state-authoritative installer integration.
- Retains the refreshed **Product Web Dashboard** with real-time approval mirror and connection metrics.
- Preserves all security invariants: Absolute Deny, Explicit Confirmation, Mandatory Confirmation, protected path isolation (`~/.winhelm`), and fail-closed security posture.

## Release Metadata
- **npm Package:** `winhelm-mcp@1.4.2`
- **Git Tag:** `v1.4.2`
- **Tarball:** `winhelm-mcp-1.4.2.tgz`
- **Canonical Tools Count:** `56`
- **Minimum Node.js Version:** `>=20.0.0`
