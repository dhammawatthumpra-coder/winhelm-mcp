# WinHelm v1.4.0 — Release Notes

Status: `FINAL_RC__EXTERNAL_PUBLISH_PENDING_OWNER_AUTHORIZATION`

WinHelm v1.4.0 focuses on making the Windows MCP runtime safer and more practical for daily use. The release consolidates profile-based permissions, approval modes, cross-process Local-Control, hardened public ingress, recovery behavior, and a validated production operating model.

## Highlights

### Product profiles

WinHelm v1.4.0 standardizes three product profiles:

- **Safe** — read-only exploration with terminal execution disabled.
- **Balanced** — daily engineering profile with bounded autonomous local work and approval for higher-impact actions.
- **Power** — trusted automation profile with broader automatic execution while retaining non-bypassable security floors.

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

The final RC lineage has exercised:
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
- **MCP Harbor is a separate future product/control-plane effort.**

## Upgrade note

The Final RC package metadata is `1.4.0`, its package lock is synchronized, and the public tool count is 56. Upgrade/rollback smoke and exact artifact hashes are release gates before publication.

## Publication gate

Technical release finalization is complete only after the Final RC canonical suite, package/install/rollback smoke, exact artifact hashes, and clean release commit are recorded. External `v1.4.0` tag push and npm publication require a separate final Owner authorization.
