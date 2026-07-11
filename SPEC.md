# standdown.js — Technical Spec (v0.1)

_For the implementing agent. Decisions in `decisions.md`; evidence and sources in `research.md` + the raw JSON files beside it. This spec is the contract — deviate only with a written note back to the coordinator._

## What this is

`standdown` — an open-source (MIT) TypeScript library for browser-extension developers that implements affiliate **stand-down** correctly: detecting that another affiliate already has attribution for a merchant, entering a session-scoped stand-down state, and gating any affiliate activation behind a real user gesture. Built and maintained by Dupe. Interops with Rakuten's PublisherStandown-SDK policy schema.

**Non-goals for v1:** performing affiliate redirects/link activation itself (we only gate it); coupon logic; analytics; any server component (except the static signed policy-bundle format); Manifest V2.

## Design invariants (violating any of these is a bug, not a tradeoff)

These encode the Affiliate Software Code of Conduct (affiliatecoc.org/code) and are the anti-Honey/anti-Phia guarantees:

- **I1 — Client-side decisions only.** No network call may participate in a stand-down decision. The decision path is a pure function over local signals + bundled policies.
- **I2 — No user profiling.** The decision function's inputs must never include user identity, account age, points balances, email, login state, or anything usable to detect compliance testers. The type signatures should make this structurally impossible (closed `Signals` type, no arbitrary context bag).
- **I3 — Fail toward standing down.** Unknown/ambiguous states resolve to `standDown: true` for suppression purposes (loading, storage errors, malformed policy). Activation guard fails closed.
- **I4 — Monotone remote updates.** The optional policy-refresh mechanism must reject any bundle that removes/narrows detection coverage, shortens durations, or touches activation rules. Updates can only broaden stand-down.
- **I5 — Audit log on by default.** Every decision (both outcomes) is appendable to a local, exportable audit log so a publisher can prove compliance in an Edelman-style third-party audit.
- **I6 — No remote code, no eval, no dynamic script loading.** Policies are data (validated, no regex compilation from remote sources without the monotonicity + signature checks).
- **I7 — Deterministic + loggable.** `decide()` is pure: same signals + policies + clock → same decision, with machine-readable reasons.

## Package

- npm name: `standdown` (verified available 2026-07-10). Repo: `github.com/dupe-com/standdown` (private until launch).
- TypeScript strict. **Zero runtime dependencies.** Build with `tsup` (ESM + CJS + d.ts). Test with `vitest`. Lint: eslint + prettier (or biome — implementer's choice, pick one and be consistent).
- Subpath exports:
  - `standdown` — pure core: types, `decide()`, session state machine, activation guard core, policy validation, Rakuten schema converters.
  - `standdown/policies` — bundled policy packs + `allPolicies`, `policiesFor(networks[])`.
  - `standdown/webext` — MV3 background/service-worker adapter (chrome.webRequest, webNavigation, storage, tabs). Browser-API-typed via `@types/chrome` (dev dep only); runtime feature-detects Firefox/Safari.
  - `standdown/content` — content-script signal collector (location, document.cookie, referrer) + lightweight evaluator for extensions that only have content-script access.
- Node >= 18 for tooling; runtime targets are browsers (Chrome/Firefox MV3, Safari 16.4+ degraded).

## Core model

### Policy schema (our native format)

```ts
interface StanddownPolicy {
  id: string                       // 'cj', 'impact', 'rakuten', 'awin', 'shareasale', 'ebay-epn', 'amazon', 'sovrn-skimlinks', 'partnerize'
  schemaVersion: 3                 // ours; converters handle Rakuten v2
  policyVersion: string            // semver-ish, bumped per data change
  network: { id: string; name: string; policyUrl?: string }
  detection: {
    landingParams?: ParamRule[]    // matched against the merchant landing/current URL
    redirectDomains?: DomainRule[] // matched against redirect-chain hops (background plane)
    cookiePatterns?: CookieRule[]  // matched against first-party cookie names (content plane)
    initiatorRules?: InitiatorRule[] // eBay-style referrer classification
    disableHosts?: DomainRule[]    // unconditional stand-down on these advertiser hosts, regardless of params/cookies/self-exemption
  }
  standdown: {
    scope: 'advertiser'            // only value in v1; field exists for forward compat
    sessionRule: 'session-or-min' | 'inactivity-window'
    minDurationMs: number          // Impact: 1_800_000; CoC fallback: 5_400_000 (90m)
    inactivityMs?: number          // CoC preferred: 3_600_000 (60m)
    behaviors: Behavior[]          // ['suppress-prompts','no-cookie-write','no-redirect','no-background-tracking']
  }
  activation: {
    mode: 'user-click' | 'never'   // amazon: 'never'
    allowedReferrerClasses?: ('own-site' | 'organic' | 'direct')[]  // ebay-epn
  }
  metadata: { sourceUrl: string; lastVerified: string; notes?: string }
}

// ParamRule supports AND-groups OR'd together:
//   { anyOf: [ { allOf: [{name:'ranEAID'},{name:'ranSiteID'}] }, { allOf: [{name:'ranSiteID'}] } ] }
// Individual matchers: { name: string; value?: string; match?: 'exists'|'equals'|'contains' }
// CookieRule: { name: string; match: 'exact'|'substring' }
// DomainRule: { pattern: string; kind: 'suffix'|'regex'; comment?: string }  // suffix match must be
//   proper domain-suffix (dot-boundary), NOT substring.
```

### Signals (closed type — see I2)

```ts
interface Signals {
  url: string                      // current/landing URL
  referrer?: string
  cookieNames?: string[]           // pre-extracted first-party cookie NAMES (never values → privacy)
  redirectChain?: string[]         // URLs of hops, background plane only
  initiator?: string               // first-request initiator, for InitiatorRule
  selfPatterns?: SelfExemption[]   // the integrator's OWN click IDs (cf. Rakuten SDK ownAffiliatePatterns)
  now: number                      // injected clock — no Date.now() inside decide()
}
```

### API surface (core)

```ts
// Pure decision — no storage, no side effects.
function detect(signals: Signals, policies: StanddownPolicy[]): Detection
// Detection = { matched: MatchedRule[]; selfMatch: boolean; strongest?: { policyId, advertiserHost, reason } }

// State machine over a pluggable store.
class StanddownSession {
  constructor(store: StateStore, opts?: { auditLog?: boolean })  // auditLog default TRUE
  async ingest(signals: Signals, policies: StanddownPolicy[]): Promise<Decision>
  async shouldStandDown(advertiserHost: string, now: number): Promise<Decision>
  async recordActivity(now: number): Promise<void>               // feeds inactivity windows
  async exportAuditLog(): Promise<AuditEntry[]>
}
// Decision = { standDown: boolean; policyId?: string; reason: string; expiresAt?: number; behaviors: Behavior[] }

// Activation guard (see I3): refuses unless a genuine user gesture + declared benefit + no active stand-down.
function guardActivation(req: {
  decision: Decision
  userGesture: { isTrusted: boolean; type: string; timeStamp: number }  // pass the real Event fields
  benefit: { kind: 'coupon-applied' | 'cashback' | 'donation'; description: string }
  policy: StanddownPolicy
}): { allowed: boolean; reason: string }

// Interop
function fromRakutenPolicy(p: RakutenNetworkPolicyV2): StanddownPolicy
function toRakutenPolicy(p: StanddownPolicy): RakutenNetworkPolicyV2
function validatePolicy(p: unknown): asserts p is StanddownPolicy

// Monotone refresh (core exposes verification; webext adapter does the fetch)
function verifyPolicyBundle(current: StanddownPolicy[], update: SignedBundle, publicKeyJwk: JsonWebKey):
  { ok: true; policies: StanddownPolicy[] } | { ok: false; violation: string }
// Signature: WebCrypto Ed25519 or ECDSA-P256 over canonical JSON. Monotonicity: every current
// detection rule must survive (same or broader), durations may only lengthen, activation untouched.
```

`StateStore` interface + three implementations: in-memory (tests), `webext` chrome.storage.local adapter, `content` sessionStorage/localStorage-TTL adapter.

### webext adapter

`createStanddown({ policies, selfPatterns, refresh? })` in the background service worker:
- Observational `chrome.webRequest.onBeforeRequest` (redirect-chain capture, per-tab) with graceful degrade to `chrome.webNavigation.onCommitted`-only (Safari 16.4+ / reduced permissions) — final-URL params only in that mode.
- Persists session state via chrome.storage StateStore (MV3 SW restarts — I3: on storage failure, report standDown true).
- Message-port helper so content scripts / popups can query `shouldStandDown(tabId)`.
- Optional monotone refresh: periodic fetch of the signed bundle URL, `verifyPolicyBundle`, apply-or-reject with audit-log entry either way.

### content adapter

For extensions without webRequest: collect `Signals` from `location`, `document.referrer`, `document.cookie` (names only), run `detect` + session store on sessionStorage/localStorage-TTL. Re-evaluate on SPA navigations (history pushState/replaceState hooks + popstate).

## Policy packs (`standdown/policies`) — data with citations

Every pack entry carries `metadata.sourceUrl` + `lastVerified: '2026-07-10'`. Seed data (from research — verify params against sources when authoring):

| Pack | Landing params | Redirect domains | Cookies | Stand-down | Activation |
|---|---|---|---|---|---|
| `cj` | `cjevent`; corroborating: `cjdata`, `utm_source=cj`, `sf_cs=cj`; `afsrc=1` | dpbolvw.net, anrdoezrs.net, jdoqocy.com, kqzyfj.com, tkqlhce.com, qksrv.net, awltovhc.com, lduhtrp.net (+ full ~21 from Pie list) | `cje`, `cjevent_dc` (substring) | session-or-min 30m | user-click |
| `impact` | `afsrc=1` (canonical), `irclickid` | (per-merchant) | `im_ref` (substring) | session-or-min 30m (policy: session or ≥30min, whichever longer) | user-click |
| `rakuten` | `ranMID`+`ranEAID`+`ranSiteID` OR-groups `siteID` | click.linksynergy.com, linksynergy.* | `lsclick_mid*`, `*linkshare*` (substring) | session-or-min (browser session) | user-click |
| `awin` | `awc`; corroborating `utm_source=aw`, `source=aw` | awin1.com | — | session-or-min | user-click |
| `shareasale` | `sscid` | shareasale.com | `sscid` (substring) | session-or-min | user-click |
| `ebay-epn` | `campid`, `pubid`, `mkevt`, `mkcid`, `mkrid`; groups: [campid+_trkparms], [mktype+gclid] | rover.ebay.com | — | re-stand-down on any new non-approved source in-session | user-click, allowedReferrerClasses own-site/organic/direct |
| `amazon` | `tag` (detect only) | — | — | n/a | **never** (Operating Agreement bans extensions carrying Special Links) |
| `sovrn-skimlinks` | — | go.skimresources.com, go.redirectingat.com | — | session-or-min | user-click (generic conduct rules; no published signal) |
| `partnerize` | `clickref` | prf.hn | — | session-or-min | user-click |
| `universal` | `afsrc=1` (cross-network standard) + YouTube redirect rule from Pie | import/attribute piedotorg/standdown-domains (MIT) | — | CoC defaults: inactivity 60m, fallback min 90m | user-click |

Also export `cocDefaults` (the Code of Conduct duration semantics) applied when a pack lacks explicit durations. A `POLICIES.md` in the repo documents every rule with its citation (research.md has the URLs).

**Note low-confidence entries explicitly in data comments** (e.g. partnerize prf.hn, sovrn redirect domains were "domain knowledge, verify" in research) — mark `notes: 'unverified against network docs'` rather than dropping them.

## Testing bar

- Unit tests for `detect` covering every pack rule (positive + negative), AND/OR param groups, substring cookies, dot-boundary domain suffix matching (regression test: `myebay.example.com` must NOT match `ebay.com`), self-exemption precedence, and the cross-network clobber scenario (network A self-exemption must not clear network B's stand-down).
- State machine: session-or-min vs inactivity windows, expiry, clock injection, store-failure ⇒ fail-closed.
- Activation guard: rejects non-trusted events, missing benefit, active stand-down, amazon 'never', eBay prompt-count exhaustion.
- Monotonicity verifier: accepts additive bundles; rejects removal, narrowing, duration shortening, activation edits, bad signature. 
- Rakuten converter round-trip on their README sample CJ policy.
- webext adapter: vitest with mocked chrome APIs (redirect-chain assembly, SW-restart state rehydration, degraded webNavigation mode).
- CI: GitHub Actions — typecheck, lint, test, build, and a `policies-cite-check` script asserting every rule has sourceUrl + lastVerified.

## Repo deliverables

README (positioning, quickstart for both adapter planes, invariants I1–I7 as a public commitments section), POLICIES.md (citations), SECURITY.md, CONTRIBUTING.md (how to submit a policy change: must cite network doc), LICENSE (MIT), CHANGELOG. Examples dir: minimal MV3 extension using `standdown/webext`.

## Phasing for the implementer

1. **P1:** scaffold + core types/`detect`/state machine/guard + policy packs + full unit tests. (Publishable core.)
2. **P2:** webext adapter + content adapter + storage adapters + mocked-chrome tests.
3. **P3:** monotone refresh + Rakuten converters + example extension + docs polish.

Ship each phase as a reviewable commit series. Do not publish to npm — publishing is a human step at launch.

---

## Amendments (2026-07-10, post-P1 review)

Ratified by the coordinator after the independent P1 spec review. These override the sections above where they conflict.

- **A1 — `session-or-min` semantics (fixes premature expiry).** `minDurationMs` is a FLOOR, not an expiry. The pure core cannot observe browser-session end, so for `session-or-min` records: `shouldStandDown` is true while `now < startedAt + minDurationMs` OR the record is still present in a session-scoped store. `expiresAt` is undefined/null for session-bound records (the store's lifetime IS the session boundary); the state machine must never auto-expire them by clock alone. `recordActivity` does not extend `session-or-min` records (pin with a test). **P2 store contract implication:** session stores clear at browser-session end; persistent stores must track a session identity and drop records from ended sessions.
- **A2 — Detection host scoping.** Add `detection.advertiserHosts?: DomainRule[]` to the policy schema: when present, `landingParams`/`cookiePatterns`/`initiatorRules` match ONLY when the signal URL's host matches (dot-boundary suffix). Apply to packs: `amazon` (amazon.<tld> — kills the `?tag=recipes`-on-a-blog false positive), `ebay-epn` (ebay.<tld> — initiator rules only apply during an eBay journey). Network-appended click params (`cjevent`, `irclickid`, `ranMID`…, `awc`, `sscid`, `afsrc`) legitimately appear on ANY merchant's landing page and stay unscoped.
- **A3 — Referrer classification.** `'own-site'` means the PUBLISHER's own property, never the advertiser's. Add an optional `publisherSites?: string[]` (integrator config — static, not user data; I2-compatible) as an input to referrer classification / `guardActivation`. If `publisherSites` is unset or the referrer doesn't match, `'own-site'` MUST NOT be assigned (fail closed). Advertiser-internal navigation classifies as its own thing (e.g. `'advertiser-internal'`), which is not an allowed referrer class.
- **A4 — Type ratifications.** `Detection.failClosedReason`, `Decision.promptCount`, `Decision.referrerClass`, and per-policy/network scoping on `SelfExemption` (`policyId`/`networkId`) are ratified. `Detection.strongest` must have a DEFINED ordering: redirect-domain match > landing-param > cookie > initiator; ties broken by policy array order. Document it in the type's JSDoc and pin with a test.
- **A5 — sessionRule for awin/shareasale/sovrn-skimlinks/partnerize.** Using CoC `inactivity-window` defaults (broader than the table's `session-or-min`) is ratified; record the reasoning in each pack's `metadata.notes`.
- **A6 — Citations.** Every pack's `metadata.sourceUrl` must point at the SPECIFIC policy/help document the rules came from, not a homepage (fix awin, shareasale, partnerize, ebay-epn). The `universal` pack must import the full piedotorg/standdown-domains rule list (MIT, with attribution in POLICIES.md), not just the YouTube rule.
- **A7 — Hygiene.** `StanddownSession` exposes ONLY `ingest`/`shouldStandDown`/`recordActivity`/`exportAuditLog` publicly (make `withState`/`failClosedWithAudit`/`loadState` private). Commit: LICENSE (MIT), lockfile, lint config (biome), GitHub Actions CI (typecheck/lint/test/build) + a real `policies-cite-check` script asserting per-rule citation presence.
