# WinHelm v1.4.0 — Clients, R7, and Connectivity

Status: `FINAL_RC`

## Local clients

WinHelm supports stdio-based clients and local HTTP transport.

Typical local integrations include:
- Claude Desktop;
- Cursor;
- local MCP clients;
- owner-operated CLI/control workflows.

Use generated connector/configuration helpers where available. Do not place raw WinHelm bearer secrets into client JSON unless the final supported integration explicitly requires it.

## Hosted / public MCP clients

R7 is the public-ingress compatibility layer.

Its responsibility includes:
- hosted-client OAuth/discovery compatibility;
- modern MCP request/header behavior;
- browser authorization handoff where required;
- stateless/public-edge compatibility with the accepted Core;
- preserving Core and client-specific compatibility boundaries.

## Accepted client state

### ChatGPT

The R7 line has accepted real ChatGPT compatibility evidence, including OAuth/bootstrap and authenticated MCP behavior.

### Notion

Notion compatibility is accepted in the R7 production lineage.

### Gemini

Gemini Static OAuth is **release-qualified for v1.4.0**. The actual Gemini UI/client consumed the OAuth metadata, completed browser authorization and confidential-client token exchange, saved the WinHelm custom MCP connector, displayed all 56 actions, and executed a real read-only `system_info` call through authenticated MCP.

## Gemini credential and route rule

The accepted static OAuth identity and admitted Gemini registration are retained. Do not regenerate or expose the client secret as routine maintenance. The R8 ingress service is installed as **Manual** and the public route is **inactive by default**; enable public exposure only through the accepted explicit control path.

## Production route policy

Public hostnames and internal loopback ports remain deployment-specific rather than API guarantees. v1.4.0 fixes the public protocol expectation at HTTPS/443 when the accepted R8 route is explicitly active; internal port redesign remains deferred.

Do not use D1 port 18791 in v1.4.0 connectivity guidance.

## Failure isolation

When a hosted client fails:

1. determine whether Core itself is healthy;
2. determine whether R7 is healthy;
3. inspect OAuth/discovery/request compatibility;
4. inspect public route state;
5. avoid restarting/replacing multiple layers at once.

A hosted-client issue should not automatically trigger Core rollback.

## Secrets

Never paste or persist:
- real OAuth client secrets;
- bearer tokens;
- admin codes;
- Local-Control capability/pipe values.

Use redaction-safe hashes/status/identity evidence for diagnostics.
