# Changelog

## 0.2.4 - 2026-07-12

Docs and audit-tooling release from the first real end-to-end integration
(issue #22). **No library behavior change** — `src`/`dist` are unchanged since
0.2.3; every change below is in guidance, examples, or the repo-only audit
harness.

### Added

- `examples/content-extension` — a minimal `standdown/content` example: a content
  script that gates an on-page offer on the decision and deliberately holds no
  `webNavigation`/`webRequest` permissions (the case that forces `content` over
  `webext`), with an esbuild IIFE bundle recipe.
- Audit harness: `conformanceGrade` (`audit/grade/conformance.ts`) — a
  decision-level, browser-free, CI-able grader that scores an adopter's policy set
  against the fixture matrix via `StanddownSession.ingest`, including
  adopter-declared disable hosts. Repo tooling; not part of the published package.
- The audit harness now runs as its own vitest workspace and is gated in CI.

### Changed

- `AGENTS.md` Step 4: split degraded-handling guidance by adapter. Always-on
  content-adapter extensions gate on `standDown` **alone** (the content plane
  always reports `degraded: true` on a clean page, so `standDown || degraded`
  there is permanently inert); redirect-plane tools keep `standDown || degraded`.
- `README.md`: adapter selection is now keyed on **permissions** (`webext` needs
  `webNavigation`/`webRequest`, otherwise `content`) with the `createStanddown()`
  throw caveat; documented the global self-click exemption recipe; and the
  copy-paste agent prompt now routes to the brownfield `ADOPTING.md` migration
  when the extension already has stand-down logic.

### Fixed

- Audit grader `grade.ts` now notes that an INERT result on a real extension most
  likely means its redirect sensor doesn't match how the extension activates (UI
  paint / background tab), not that it's dead code.
- Audit docs: build the root library first (the harness links `standdown` via
  `file:..`, and `dist/` is not checked in).

## 0.2.3 - 2026-07-12

### Added

- Ship `ADOPTING.md` in the published package. The README links to the
  brownfield adoption guide, so npm consumers now get it instead of a dead link.
- Audit harness: grade against your own policy pack via a `POLICY_PACK=<module>`
  env var (`audit/fixtures/resolvePolicies.ts`). The grader already derives its
  whole scenario matrix from the packs, so supplying your policy is all that's
  needed — no affiliate identifiers are hardcoded on that path.
- Audit harness: an in-browser side-by-side probe
  (`audit/grade/shadow-sidebyside-probe.ts`) comparing the library's decision
  against a host extension's own detector.

### Changed

- Generalized the adoption guide and audit probes: replaced a specific adopter's
  example affiliate identifiers and internal keys with neutral placeholders, and
  reframed the worked examples around a generic "host/adopting extension." No
  library behavior change — docs and dev tooling only.

## 0.2.2 - 2026-07-12

### Changed

- Marked the project as alpha in the README (status badge + notice).

## 0.2.1 - 2026-07-12

### Added

- Brownfield adoption guide (`ADOPTING.md`) and agent-onboarding notes for
  migrating an existing stand-down decision path onto the library.
- `npm run release` — one-command, human-cut release script.

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
