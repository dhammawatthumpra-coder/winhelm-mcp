# WinHelm v1.4.0 — Release Notes

WinHelm v1.4.0 focuses on making the Windows MCP runtime safer and more practical for daily use. The release consolidates profile-based permissions, approval modes, cross-process Local-Control, hardened public ingress, recovery behavior, and a validated production operating model.

## Highlights

### Product profiles

WinHelm v1.4.0 standardizes three product profiles:

- **Safe** — read-only exploration with terminal execution disabled.
- **Balanced** — daily engineering profile with bounded autonomous local work and approval for higher-impact actions.
- **Power** — broader capability for trusted automation. Product presets still default to Smart Approval Mode, so representative R2/R3/R4/R5 actions remain approval-gated unless a different permitted mode applies; non-bypassable security floors remain in force.

### Approval Modes

Three Approval Modes are available in Schema v2:

- **Manual** — permitted state-changing actions normally require confirmation.
- **Smart** — low-risk bounded work can proceed automatically; higher-impact operations ask.
- **Trusted** — routine permitted actions can proceed without routine prompts.

Approval Mode never expands capability. A denied capability stays denied. Explicit-confirmation and mandatory-confirmation floors remain stronger than Approval Mode.

### Local-Control and CLI

v1.4.0 introduces the newer Local-Control registry model for coordinating local WinHelm instances and supporting CLI control across HTTP and stdio processes. The CLI validation lineage covers read-only status/job inspection as well as interactive admin-code and approval decision flows.

### Public ingress and MCP client compatibility

The R7 ingress line adds hardened MCP/OAuth compatibility for hosted clients while preserving the accepted Core runtime. ChatGPT and Notion compatibility have accepted production evidence.

Gemini Static OAuth is release-qualified. The actual Gemini client/UI completed OAuth authorization, saved the WinHelm connector, discovered all 56 actions, and executed a real read-only `system_info` call through authenticated MCP. Overall R7/Gemini release hold is closed.

### Security hardening

The v1.4 line strengthens:
- subject preflight absolute denies;
- mandatory confirmation;
- approval-mode/capability separation;
- protected internal paths;
- fail-closed startup and routing checks;
- exact activation/session identity;
- public-ingress OAuth/browser boundaries;
- process/lifecycle and Local-Control validation;
- secret redaction and evidence discipline.

## Current validated production shape

The release qualification lineage exercised:
- Windows-native Core;
- stdio clients;
- Local-Control registry and real CLI control;
- hardened R8 public ingress and static OAuth;
- **56 canonical public tools**;
- Safe / Balanced / Power profiles and Manual / Smart / Trusted Approval Modes.

The R8 Windows service remains Manual and the public route is inactive by default.

## Known v1.4.0 limitations

- **D1 live mode is deferred.** D1 port 18791 is not part of the v1.4.0 active production scope.
- **Approval UX remains web/CLI-centric.** Windows toast approval is planned for v1.4.1+.
- **Admin-code friction remains.** One-time local admin-code workflow is retained for privileged dashboard operations in v1.4.0.
- **Tray/dashboard polish is deferred.**
- **WinHelm Setup Assistant ships separately.** It is an optional companion UX and is not required for manual v1.4.0 installation or operation.
- **MCP Harbor is a separate future product/control-plane effort.**

## Install and upgrade

A complete manual installation path is part of the core release; see [MANUAL_INSTALL.md](MANUAL_INSTALL.md). The release does not depend on the separate Setup Assistant.

The release package metadata is `1.4.0`, its package lock is synchronized, and the public tool count is 56. The reviewed release artifact is identified by exact size and SHA-256 in the release record.

## Release integrity

The release is sealed only from the reviewed release commit and exact package artifact after canonical qualification, native conformance, migration checks, install smoke, and artifact hashing. Publication uses those sealed identities without source mutation.
