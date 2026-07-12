# Changelog

## 0.2.0 - 2026-07-11

### Added

- `selfExemptionScope: 'policy' | 'session'` option on the session, `webext`,
  and `content` surfaces. `'session'` persists a network-precise self-exemption
  for a host (Dupe `ignore_param` semantics) that re-applies to the same
  network's later signals; the default `'policy'` keeps per-navigation scope.
  Exports `ExemptionRecord` and `SelfExemptScope`. Exemptions are recorded only
  when no stand-down is active and never lift an active stand-down, so the
  fail-toward-standing-down invariant holds; they persist through the store
  layer and drop on a new browser session.
- `detection.disableHosts` — a per-host hard-disable primitive that suppresses
  all detection on matching advertiser hosts, immune to session exemptions.
- Degraded marker on non-stand-down decisions made under partial coverage, so
  callers can distinguish "no attribution found" from "couldn't fully observe."

### Changed

- Set Impact and Rakuten packs to session-only durations and documented the
  `session-or-min` duration semantics.
- Aligned bundled policy packs with production ground truth and dropped the
  unenforced prompt-cap field.
- README now merchandises the guarantees up front, documents the black-box
  conformance grader, and shows the affiliate networks the bundled packs cover.
  Cookie matching is documented as name-only (values are never read).

### Notes

- The `audit/` black-box conformance harness and the CI policy-conformance suite
  were added in this cycle. Neither ships in the npm package (the `files`
  allowlist is `dist`, `README.md`, `LICENSE`, `POLICIES.md`).

## 0.1.1 - 2026-07-11

- Added the project logo, status badges, and a refreshed README header. Docs
  only; no library code changed.

## 0.1.0 - 2026-07-10

- Scaffolded strict TypeScript package with ESM, CJS, and declaration builds.
- Added pure core detection, session state machine, activation guard, validation,
  and audit logging.
- Added bundled policy packs with citations and Pie standdown-domains
  attribution.
- Added Manifest V3 `standdown/webext` adapter with redirect-chain capture,
  degraded webNavigation mode, persistent storage, message queries, and signed
  monotone policy refresh.
- Added `standdown/content` adapter with cookie-name-only signal collection,
  session/local-TTL storage, and SPA re-evaluation.
- Added WebCrypto signed policy bundle verification.
- Added Rakuten `NetworkPolicy` schemaVersion 2 converters.
- Added minimal MV3 example extension.
- Added project docs: README, policy citations, contributing, security, and this
  changelog.
- Removed the empty `standdown/react` subpath from the 0.1.0 package surface; it
  will return when a real React adapter exists.
