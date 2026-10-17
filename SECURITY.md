# Security Policy

The WinHelm MCP maintainers and contributors are committed to providing a secure, resilient tool for connecting AI agents to Windows environments. We take all potential security vulnerabilities seriously.

---

## Supported Versions

Only the latest minor release is actively maintained and receives security patches:

| Version | Supported          | Security Status |
| ------- | ------------------ | --------------- |
| 1.4.x   | :white_check_mark: | Active Support |
| 1.2.x   | :x:                | Superseded by v1.4.0 |
| 1.1.x   | :x:                | End of Life     |
| 1.0.x   | :x:                | End of Life     |

---

## Reporting a Vulnerability

If you discover a security vulnerability in WinHelm MCP, please **do not** disclose it publicly via GitHub issues or social media. Instead, please follow our coordinated disclosure process:

1. **Email:** Send your report to the repository security contact or maintainer via GitHub Private Vulnerability Reporting on the [WinHelm MCP Security tab](https://github.com/dhammawatthumpra-coder/winhelm-mcp/security/advisories).
2. **Details to Include:**
   - Detailed description of the vulnerability.
   - Proof of Concept (PoC) or reproduction steps.
   - Assessment of impact (e.g. bypass of `allowedDirectories`, remote code execution outside boundary, credential leakage).
   - Any suggested remediations or patches.

### Our Response Commitment
- **Initial Acknowledgment:** Within 48 hours of receipt.
- **Triage & Reproduction:** Within 5 business days.
- **Fix & Advisory Release:** We aim to release a patch and publish a coordinated security advisory within 14 days of triage.

---

## Security Documentation & Policies

For in-depth architectural details, please refer to:
- [Threat Model (STRIDE Framework)](docs/THREAT_MODEL.md) — Comprehensive analysis of attack surfaces, trust boundaries, and mitigations.
- [Security Architecture & Guidelines](docs/SECURITY.md) — Detailed explanation of multi-layered controls, path confinement, and credential masking.
- [Terms of Use & Shared Responsibility](TERMS_OF_USE.md) — Clarification of administrator responsibilities and software limitations.

## v1.4.0 Security Posture

WinHelm v1.4.0 uses layered authorization. Capability/profile and protected-boundary checks happen before Approval Mode. Manual / Smart / Trusted can change prompting for an already-permitted action, but cannot turn a denied capability into an allowed one.

Non-bypassable release floors include:
- absolute-deny/preflight checks before approval/job creation;
- explicit and mandatory confirmation where required;
- protected internal paths and secret/control state;
- fail-closed Local-Control metadata validation;
- public-ingress OAuth/TLS boundaries and redaction of secret material.

The direct production dependency `@modelcontextprotocol/sdk` is pinned to the patched v1.32.x line; release qualification requires `npm audit --omit=dev` to report zero known production vulnerabilities.

**D1 live mode is not shipped as active v1.4.0 functionality.** Port 18791 remains disabled because the deferred D1 design requires stronger process-lifetime provenance than mutable timestamp metadata can provide.

The accepted R8 public-ingress service is Manual and its public route is inactive by default; exposure is explicitly activated rather than left permanently open.

---

## Security Best Practices for Administrators

1. **Keep `allowSystemExecution: false`:** WinHelm defaults to fail-closed containment. Only enable `--system-exec` if you explicitly require access to Windows system binaries on `C:\`.
2. **Always Use Authentication on Shared Networks:** If exposing WinHelm beyond localhost (via LAN, Tailscale, or Cloudflare Tunnel), always pass `--auth <token>` or set `MCP_AUTH_TOKEN`. WinHelm enforces a fail-closed startup gate that refuses to run on non-loopback interfaces without authentication.
3. **Restrict `allowedDirectories`:** Specify only the directory trees the AI agent needs access to (e.g. `D:\projects\app`). Avoid setting `allowedDirectories: ["*"]`.
4. **Run under Standard User:** Do not run WinHelm from an elevated Administrator command prompt unless strictly required.
