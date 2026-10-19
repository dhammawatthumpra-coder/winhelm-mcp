# WinHelm v1.4.1 — Architecture Overview

Status: `RELEASE_CANDIDATE__PRODUCTION_CUTOVER_GATED`

## Layers

```text
MCP clients
  |-- local stdio
  |-- local HTTP
  |-- hosted/public clients
          |
          v
      R7 ingress
          |
          v
WinHelm Core
  |-- MCP transport/session layer
  |-- capability/profile policy
  |-- approval-mode policy
  |-- mandatory confirmation / absolute deny
  |-- tool registry/execution
          |
          +-- filesystem
          +-- terminal/commands
          +-- desktop
          +-- system/process/service
          +-- network/diagnostics

Local operator/control plane
  |-- Local-Control registry
  |-- control CLI
  |-- dashboard/admin-code
  |-- approval request/decision state
```

## Core

The Core hosts the MCP tool execution surface and policy engine.

It should remain loopback-first unless remote exposure is intentionally configured and protected.

## Policy

Schema v2 divides authorization into:
- profile/capability;
- folder scope;
- terminal policy;
- Approval Mode;
- non-bypassable security floors.

## Local-Control

Every surviving WinHelm instance may publish per-instance Local-Control metadata.

This supports concurrent HTTP Core and stdio instances.

The compatibility pointer is a preferred hint; registry records support failover.

## Approvals

Decision and execution are separated:
- a decision surface records approval/denial;
- the owning process executes the approved work;
- ambiguous/recovered side effects are not blindly replayed.

## v1.4.1 operational UX integration

The v1.4.1 source candidate adds three accepted product-facing capabilities without collapsing their authority boundaries:
- **Dynamic Internal Ports:** clean/automatic topology may use OS-selected internal listeners; existing fixed deployments remain fixed unless explicitly migrated.
- **Native Approval UX:** Windows toast activation reaches the existing approval decision plane; installer ownership decisions come from exact live Registry/Shortcut state, not receipt history.
- **Product Dashboard:** displays factual runtime/approval/setup state through authoritative adapters; the standalone Setup Assistant companion remains unavailable/disabled.

## R7 / R8 public ingress

R7 is the hosted/public compatibility layer; the accepted production edge remains the qualified R8 TLS/service posture. It stays a separate deployment/security boundary from Core so client/OAuth compatibility work does not require mutating the Core runtime. The service is Manual and the public route is inactive by default; the public protocol identity remains HTTPS/443 when explicitly active.

## Production adoption and marker authority

The v1.4.1 source candidate is not equivalent to a completed production cutover. Initial adoption is Fixed-first. Switching the active-backend marker remains blocked until a separately qualified guarded-commit primitive can protect expected-current authority through commit without silently overwriting an external writer.

## D1

D1 is not part of active v1.4.1 production architecture.

Port 18791 remains excluded unless a separate accepted design and cutover decision changes that boundary.

## Future MCP Harbor

MCP Harbor is not a synonym for R7 or WinHelm Core. It is a future independent MCP control-plane/gateway product in which WinHelm may be a first-class provider.
