# WinHelm v1.4.1 — Known Limitations and Deferred Items

Status: `RELEASE_CANDIDATE__PRODUCTION_CUTOVER_GATED`

This file documents items that remain disabled, separately gated, or deferred in the accepted v1.4.1 source candidate.

## 1. D1 live mode / port 18791

D1 live mode and port 18791 remain outside active v1.4.1 production scope. Their absence is intentional and is not an operational error.

Any future D1 activation requires a separate accepted design and cutover decision.

## 2. Native Approval UX

v1.4.1 closes the prior lack of Windows toast approval. Native Approval toast activation is accepted, and the installer uses exact live Registry/Shortcut state as the authority for repair/uninstall decisions.

Persisted installer receipts are advisory metadata only. They cannot authorize destructive mutation or restore arbitrary historical commands.

CLI and Web Dashboard approval remain supported fallback paths.

## 3. Standalone Setup Assistant

The standalone Setup Assistant companion executable is not yet shipped. Product Dashboard status must report it as unavailable and its launch action remains disabled.

## 4. Marker guarded-commit prerequisite

Live production cutover remains blocked until the active-backend marker can be changed with a separately qualified guarded-commit primitive that protects expected-current authority through commit without silently overwriting an external writer.

The existing generic `file_write_atomic(expected_current_sha256)` primitive is not accepted as that race-free external-writer CAS.

## 5. Dynamic Internal Ports and production adoption

The source supports OS-selected internal ports for clean/automatic topology. Existing fixed installations remain fixed unless explicitly migrated. Initial production adoption is Fixed-first; no silent Fixed -> Automatic migration is permitted.

## 6. Tray / desktop UX

Richer native tray and desktop lifecycle controls remain deferred beyond the v1.4.1 core release candidate.

## 7. Connector console

Additional connector list/revoke/management UX remains deferred beyond the current core release candidate.

## 8. Public ingress operating posture

Gemini Static OAuth and the accepted hosted-client flow remain qualified. The R8 Windows ingress service is Manual and its public route is inactive by default. Operators must explicitly activate public exposure through the accepted control path.

## 9. Native Windows boundary

The Windows-targeted package includes the qualified native boundary addon required by governed file/process operations. Native-dependent operations fail closed if the addon is missing or incompatible.

## 10. Approval convenience vs. security floors

Trusted mode is not an unrestricted mode. Capability denial, Absolute Deny, Explicit Confirmation, and Mandatory Confirmation remain stronger than Approval Mode.

## 11. MCP Harbor

MCP Harbor is a separate future MCP control-plane/gateway product. It is not included in WinHelm v1.4.1.

## 12. Public endpoint topology

Owner-specific internal ports, hostnames, paths, and launch details are not public API guarantees. The accepted hosted/public R8 protocol identity is HTTPS/443 when explicitly active; internal topology is resolved from verified runtime state.

## 13. Publication status

The accepted source candidate is not automatically a public release. npm publication, Git tag/GitHub release, and live production cutover remain separately authorized gates.

## 14. Historical evidence

Historical v1.4.0 release notes, migration guides, phase reports, and baseline evidence intentionally retain their original version references. They are not stale current-product claims and must not be globally rewritten.
