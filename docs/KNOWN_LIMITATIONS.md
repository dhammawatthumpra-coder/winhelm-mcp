# WinHelm v1.4.0 — Known Limitations and Deferred Items

Status: `FINAL_RC__SHIP_WITH_V1_4_0`

This file intentionally documents items that are **not** release blockers because they are disabled, deferred, or UX improvements rather than unsafe active functionality.

## 1. D1 live mode — deferred to v1.4.1+

D1 live-mode materialization and production cutover are not part of v1.4.0 active scope.

Reason:
Fresh independent review found that mutable `createdAt` metadata could be backdated by an in-scope same-user writer and cause a current wrong-root process/pointer to be treated as stale PID-reuse history.

v1.4.0 policy:
- D1 is disabled/not active;
- port 18791 remains absent;
- no D1 live cutover is performed.

Follow-up:
v1.4.1 should redesign lifetime provenance rather than add another timestamp heuristic.

## 2. Approval UX

Current approval workflows are safe but can be cumbersome for frequent daily use.

v1.4.0 retains:
- web dashboard approval;
- CLI approve/deny;
- single-use local admin-code flow for privileged dashboard actions.

Deferred:
- Windows toast approval;
- approve/deny from notification;
- bounded batch/session approval;
- smoother desktop-native flow.

Target: v1.4.1+.

## 3. Tray / desktop UX

Native tray and richer desktop lifecycle controls are deferred.

Target: v1.4.2+.

## 4. Connector console

Additional connector list/revoke/management UX is deferred beyond the v1.4.0 core release.

## 5. Public ingress operating posture

Gemini Static OAuth and the actual Gemini client/UI flow are release-qualified. The remaining limitation is operational by design: the accepted R8 Windows service is **Manual** and its public route is **inactive by default**. Operators must explicitly activate public exposure when needed; v1.4.0 does not convert this into an always-on service.

## 6. Native Windows boundary

The v1.4.0 npm package is Windows-targeted and includes the qualified production native boundary addon required by governed file/process operations. The addon is fail-closed: if it is missing or incompatible, native-dependent operations do not silently fall back to weaker behavior.

## 7. Approval convenience vs. security floors

Trusted mode is not an "unsafe everything" mode. It cannot bypass capability denial or mandatory confirmation. Users seeking completely prompt-free high-impact system control may still encounter required confirmation by design.

## 8. MCP Harbor

MCP Harbor is a separate future MCP control-plane/gateway product. It is not included in WinHelm v1.4.0.

## 9. Public endpoint topology

Internal development ports/hostnames and owner-specific launch paths are not public API guarantees. Final supported connection instructions must come from the release package documentation.

## 10. Historical evidence volume

The v1.4 development line contains extensive internal qualification/review artifacts. These are not intended to ship as end-user documentation. The release pack consolidates them into user-facing README/CHANGELOG/SECURITY/operations docs.
