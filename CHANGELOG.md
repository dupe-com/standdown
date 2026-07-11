# Changelog

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
