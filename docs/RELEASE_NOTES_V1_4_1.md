# WinHelm v1.4.1 — Release Notes

Status: `RELEASE_CANDIDATE__PUBLICATION_AND_PRODUCTION_CUTOVER_GATED`

WinHelm v1.4.1 focuses on operational usability without weakening the v1.4 security floor. The accepted source candidate removes routine internal-port selection from clean/automatic topology, adds Windows-native approval activation, refreshes the Product Dashboard, and wires product status to authoritative runtime classifiers.

## Dynamic Internal Ports

- Clean/automatic topology can obtain internal listeners from the operating system without asking the user to select numeric ports.
- Existing fixed deployments remain fixed unless explicitly migrated.
- Public HTTPS identity remains stable at HTTPS/443 when the accepted R8 route is explicitly active.
- Internal-port hints are not authority; active state is derived from verified live runtime identity.

## Native Approval UX

- Windows toast activation opens the approval flow without requiring routine terminal commands.
- Approval activation tokens are transient and are not persisted in plaintext.
- Exact live Registry/Shortcut state controls installer repair/update/uninstall authorization.
- Persisted installer receipts are advisory metadata only and cannot authorize destructive restoration.
- Foreign Registry/Shortcut state is preserved fail-closed.

## Product Dashboard

- The refreshed Dashboard presents factual Dynamic Port, Native Approval, and Setup Assistant state through authoritative adapters.
- Fake/fallback port presentation was removed from the accepted integration path.
- The standalone Setup Assistant companion remains unavailable; its launch action is disabled rather than pretending a companion exists.

## Security and authority

- Safe / Balanced / Power capability profiles remain separate from Manual / Smart / Trusted Approval Modes.
- Approval Mode never expands capability.
- Absolute Deny, Explicit Confirmation, Mandatory Confirmation, protected-path controls, OAuth/TLS boundaries, and secret redaction remain non-bypassable release floors.
- Native Approval live-state authority prevents forged receipt history from redefining destructive ownership.

## Production adoption

The accepted v1.4.1 source candidate is not the same thing as completed production cutover.

- Initial production adoption remains **Fixed-first**.
- Existing fixed production topology is not silently converted to Automatic.
- Live active-backend marker mutation remains blocked until a separately qualified guarded-commit primitive protects expected-current authority through commit.
- R7/R8/Funnel/OAuth state is not silently changed by Core adoption.

## Compatibility

- The canonical public tool count remains **56**.
- Schema-v2 governance remains compatible with the v1.4 profile/approval model.
- Existing fixed port configurations remain supported.
- D1 live mode/port 18791 remains outside active production scope unless separately re-adjudicated.

## Known limitations / deferred items

- Standalone Setup Assistant companion executable: unavailable/not shipped.
- Rich native tray/desktop lifecycle controls: deferred.
- MCP Harbor: separate future control-plane/gateway product.
- Marker guarded-commit primitive: required before live production cutover.

## Release identity

- Package/runtime version: `1.4.1`.
- Health/version surfaces derive from the package version and report `1.4.1` in the accepted candidate.
- Historical v1.4.0 release notes and evidence remain historical and are intentionally not rewritten.

## Publication status

No Git tag, npm publication, GitHub release, or live production cutover is implied by these notes. Those actions require their own final Owner authorization after the remaining gates close.
