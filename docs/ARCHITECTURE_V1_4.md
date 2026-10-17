# WinHelm v1.4.0 — Architecture Overview

Status: `FINAL_RC`

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

## R7 / R8 public ingress

R7 is the hosted/public compatibility layer; the accepted v1.4.0 production edge is the qualified R8 TLS/service posture. It remains a separate deployment/security boundary from Core so client/OAuth compatibility work does not require mutating the Core runtime. The service is Manual and the public route is inactive by default.

## D1

D1 is not part of v1.4.0 active architecture.

Its live-mode/cutover work is deferred pending stronger lifetime provenance.

## Future MCP Harbor

MCP Harbor is not a synonym for R7 or WinHelm Core. It is a future independent MCP control-plane/gateway product in which WinHelm may be a first-class provider.
