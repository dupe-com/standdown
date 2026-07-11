# Security

## Reporting

Use GitHub private vulnerability reporting as the primary disclosure channel:
open the repository Security tab and choose "Report a vulnerability".

If GitHub private reporting is unavailable, email security@dupe.com. Include a
minimal reproduction and the affected package surface when possible.

## Security Model

`standdown` is intended to be embedded in browser extensions and keeps
stand-down decisions local:

- No network call participates in `detect`, `ingest`, `shouldStandDown`, or
  activation guard decisions.
- Optional refresh fetches signed data bundles asynchronously and only updates
  the already-applied local policy set after signature and monotonicity checks.
- Remote bundles are data, not code.
- Cookie signals are names only; values are not collected.
- User identity, account state, rewards balances, emails, login state, and
  tester-differentiating inputs are outside the `Signals` type.

## Supported Surfaces

The supported security boundary is the library code in `src/` and the built
package subpaths documented in `package.json`. Files under `examples/` are
illustrative and are not production extension templates.

## Out of Scope

This project does not perform affiliate redirects, coupon injection, server-side
decisioning, analytics collection, or publisher attribution writes. Integrators
remain responsible for their extension permissions, content security policy, and
network-specific compliance obligations.
