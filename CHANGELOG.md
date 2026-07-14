# Changelog

## 0.3.3 - 2026-07-14

Hardening for `selfExemptionScope: 'session'`, closing the last item of the
content-controller review. **Touches `src`**; one additive option and one
narrowing of what a live exemption suppresses.

### Added

- `sessionExemptionTtlMs` on the session (and the `content` / `webext` / `url`
  adapters): how long a session self-exemption persists for a host, measured
  from when it was first granted. Defaults to **30 minutes** (fixed, not
  sliding). Set to `0` or any non-positive value to disable expiry and keep the
  previous lifetime-of-session-state behavior. Session exemptions were never
  pruned before, so a single self-click grant lasted the whole session; this
  bounds that window.

### Fixed

- A session self-exemption no longer swallows a **competing attribution param**.
  It previously dropped any later same-network match for an exempted host,
  including a fresh `landing-param` / `redirect-domain` carrying someone else's
  click id, so a competitor's click back to an already-exempted host was
  suppressed and the sale taken. The exemption now re-covers only ambient
  lingering signals (a first-party cookie, the initiator); a fresh competing
  attribution param that is not our own self-match stands down. This bites only
  with value-specific self-patterns (the documented, correct way to author
  them); a name-only self-pattern already claims every value of that param as
  ours (#56, #57, resolves the session-exemption item of #52).

## 0.3.2 - 2026-07-14

Concurrency fix in decision persistence. **Touches `src`** — a correctness fix;
no API change.

### Fixed

- Serialize the session's state read-modify-write path so concurrent
  evaluations can't lose-update the store. `StanddownSession.ingest` loads,
  mutates, and saves state asynchronously; the adapter's own navigation hooks
  coalesce, but callers that drive `evaluate()`/`ingest()` from their own
  navigation signal (as the content adapter docs recommend) are not otherwise
  serialized. Two overlapping evaluations could both load the pre-write snapshot
  and have the second save clobber the first, dropping a just-recorded
  stand-down record — worst case flipping a host from `standDown: true` back to
  `false`. A FIFO lock now runs state operations in order, and gives
  read-after-write consistency for a `shouldStandDown` queued right after an
  `ingest` (#55).

## 0.3.1 - 2026-07-14

Content-adapter hardening from dogfooding the Dupe extension migration and a
review of the SPA re-evaluation example. **Touches `src`** — a small,
safe-direction guard; no change to how a live controller decides.

### Fixed

- The content controller's public `evaluate()` now fails closed after
  `dispose()`: it returns a `controller-disposed` decision and no longer fires
  `onDecision`. Previously only the internal `scheduleEvaluation` path checked
  the `disposed` flag, so an adopter driving `evaluate()` from their own
  navigation signal could re-run a torn-down controller and re-fire `onDecision`
  after teardown.

### Docs

- Documented that the content adapter's `history.pushState`/`replaceState` hooks
  run in the content script's **isolated world** and therefore miss a page's own
  main-world SPA route changes (only `popstate` crosses worlds). `ADOPTING.md`
  and `examples/content-extension/` now recommend driving `controller.evaluate()`
  from a single navigation source, and the example spells out the URL-poll
  fallback's tradeoffs (latency, duplicate work, clearing the timer on teardown).

## 0.3.0 - 2026-07-14

Backfilled entry. New `url` adapter, a self-exemption fan-out helper,
construction-time policy lint warnings, and a Rakuten detection fix. **Touches
`src`** across several adapters; the only decision-behavior change is the
Rakuten fix (safe-stricter — it stands down in a case it previously missed).

### Added

- **`standdown/url` adapter** for URL-only decision contexts — no page, cookie,
  or redirect-chain signals, just a URL in and a `Decision` out
  (`src/url.ts`). For callers that only have a destination URL to reason about.
- **`expandSelfExemption(matcher, policies)`** — fans a single global
  `ignore_param` matcher out to a scoped self-exemption per policy, derived from
  the same `policies` array so it stays in sync as networks are added
  (`src/self-exemption.ts`). This is the sanctioned way to express an
  "our click wins regardless of network" param without a name-only clear-all.
- **`lintPolicies` construction warnings.** Adapters now surface config lint
  warnings when a controller is constructed (`src/validation.ts`, wired through
  the `content`, `webext`, and `url` adapters), so misconfigured policy sets
  announce themselves at setup instead of failing silently at decision time.

### Fixed

- **Rakuten: stand down on a bare `ranEAID`.** A landing carrying a Rakuten
  `ranEAID` with no accompanying click id is now treated as prior attribution
  and stands down; the grader also grades every landing group rather than
  stopping early (#48).

### Docs / tooling

- CI-verified "Graded with standdown" showcase wall of fame, with a Tier 2
  live-verify path that grades a published `.crx`, and the first showcased
  extension (Dupe.com, conformance A+ 100/100).
- Claude Code plugin marketplace: `/standdown:setup`, `/standdown:adopt`,
  `/standdown:showcase`, plus agent-first setup/integration docs and a
  single-sourced adoption playbook.

## 0.2.6 - 2026-07-13

Hardening from real integration feedback (an extensions reviewer hit the domain
footgun below on a live port). **This one touches `src`** — an additive,
non-breaking dev-time warning; no decision behavior changes.

### Added

- `validatePolicy` now emits a `console.warn` when a `kind: 'suffix'`
  `DomainRule` uses a bare label (`'ebay.'`, `'ebay'`). Suffix rules match a
  registrable domain, so a bare label matches no real host — the classic result
  of mis-porting a substring domain list (`hostname.includes('ebay.')`) onto
  suffix rules, which silently makes the rule inert. The warning names the fix.
  Non-throwing: the rule is structurally valid, just almost certainly a mistake.

### Docs

- `AGENTS.md` gotchas and `INSTALL.md` (per-host disable) now document the
  substring-vs-suffix domain hazard — the domain-level twin of the existing
  cookie name-only caveat — with the full-host / `kind: 'regex'` fixes.

## 0.2.5 - 2026-07-13

Docs and audit-tooling release from a second cold-start integration (a fresh
agent running the install prompt end-to-end). **No library behavior change** —
`src`/`dist` are unchanged since 0.2.3.

### Added

- **Shareable grade card.** Both graders (`grade/conformance.ts`, `grade/grade.ts`)
  now emit a card on a passing run: a terminal card, a self-contained
  `standdown-grade.svg` (1200×630, OpenGraph ratio) written to the working
  directory, and a copy-paste social snippet — all crediting the project
  (`audit/grade/share-card.ts`, with tests). Repo tooling; not part of the package.
- `INSTALL.md` — the manual install + full API reference (adapters, quickstarts,
  self-exemption, per-host disable, signed refresh, interop), split out of the
  README.

### Changed

- **README rewritten prompt-first** (~474 → ~257 lines): the AI-agent integration
  is now the primary, recommended path (with a "use a capable model" note); a new
  **How it works** section explains the signals standdown inspects and the
  greenfield vs brownfield integration shapes; the code-heavy API reference moved
  to `INSTALL.md`.
- `AGENTS.md` **Step 6** now leads with `conformanceGrade` (the fast, browser-free
  adopter grade) and demotes `grade.ts` to the optional in-browser testext sensor;
  the stale "decision-conformance grader … tracked in issue #22" framing is gone
  (it shipped in 0.2.4). **Step 2** states the permission-keyed adapter rule
  explicitly; **Step 5** points content adopters at `examples/content-extension`.

### Renamed

- `audit/grade/dupe-extension-probe.ts` → `audit/grade/host-extension-probe.ts` —
  a template host-extension probe, not a Dupe-specific one — with all references
  and the AGENTS.md link corrected.

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
