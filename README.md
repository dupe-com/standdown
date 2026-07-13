<p align="center">
  <img src="https://raw.githubusercontent.com/dupe-com/standdown/main/assets/logo.png" alt="standdown — affiliate stand-down, done right" width="620">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-alpha-E5484D?labelColor=1C1917" alt="project status: alpha">
  <a href="https://www.npmjs.com/package/standdown"><img src="https://img.shields.io/npm/v/standdown?color=F5A623&label=npm&labelColor=1C1917" alt="npm version"></a>
  <a href="https://github.com/dupe-com/standdown/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dupe-com/standdown/ci.yml?branch=main&label=CI&labelColor=1C1917" alt="CI status"></a>
  <img src="https://img.shields.io/badge/dependencies-0-2ea043?labelColor=1C1917" alt="zero runtime dependencies">
  <img src="https://img.shields.io/badge/types-included-3178C6?labelColor=1C1917" alt="TypeScript types included">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/standdown?color=8A8175&labelColor=1C1917" alt="MIT license"></a>
  <a href="https://affiliatecoc.org"><img src="https://img.shields.io/badge/aligned-Affiliate%20CoC-F5A623?labelColor=1C1917" alt="aligned with the Affiliate Code of Conduct"></a>
</p>

> [!WARNING]
> **Alpha — expect bugs and breaking changes.** standdown is pre-1.0 and under
> active development: the API may shift between minor versions and edge cases are
> still being found. Because it makes revenue-affecting decisions, pin your
> version, verify it against your own integration with the
> [conformance grader](./audit), and please
> [report anything that misbehaves](https://github.com/dupe-com/standdown/issues).

> **Your extension shouldn't steal the sale.** `standdown` detects existing
> affiliate attribution, suppresses competing activation, and proves the
> decision was made locally — never on a server.

Built and maintained by [Dupe](https://dupe.com).

`standdown` is a zero-runtime-dependency TypeScript library for extension
developers who need to detect existing affiliate attribution, suppress
competing activation, and prove that suppression decisions were made locally and
deterministically.

## What makes it different

Affiliate stand-down is easy to claim and hard to prove. `standdown` is built so
the guarantees are structural — enforced by the type system and the architecture,
not by a promise in a blog post.

- 🔒 **Decisions never leave the device.** No network call participates in a
  stand-down decision, ever. The decision path is a pure function of local
  signals and bundled policies.
- 🛡️ **User data can't leak into a decision — by construction.** `Signals` is a
  closed type: identity, accounts, balances, email, and login state are
  structurally unable to enter it. No profiling, no compliance-tester detection.
- ⚖️ **Fails toward standing down.** Ambiguity, storage errors, or a malformed
  policy all resolve to *suppress*. The library never hijacks a sale by accident.
- 🧾 **Provably compliant.** Every decision is deterministic and appended to a
  local, exportable audit log — reproducible evidence you can hand to a
  third-party auditor.
- 🎯 **Detects attribution the way networks actually set it.** Landing params,
  redirect-chain hops, first-party cookie *names* (never values), and
  referrer/initiator classification — across eight verified network packs.
- ✍️ **Tamper-evident updates.** Signed policy bundles (Ed25519 / ECDSA-P256)
  that can only *broaden* coverage or *lengthen* durations — a remote update can
  never weaken a guard.
- 🅰️ **It grades itself, F→A+.** A [black-box conformance harness](#conformance-grading)
  loads a real extension into a real browser and scores whether it respects
  existing attribution — with an inert-code guard so "disciplined" can't be faked
  by shipping nothing.
- 📦 **Zero runtime dependencies.** Ships ESM + CJS + types. MV3, with a
  content-script path for Safari and reduced-permission contexts.

## Works across the major affiliate networks

Each bundled pack implements a network's *stand-down* expectations — the
detection signals it sets, the suppression behavior it asks for, and how long it
lasts — so you don't have to reverse-engineer them. Eight **verified** packs
ship enabled by default: seven named networks, plus a universal
redirect-fingerprint set.

<p align="center">
  <a href="https://www.cj.com/legal/software-policy"><img src="https://img.shields.io/badge/CJ%20Affiliate-00857C?style=for-the-badge&logoColor=white" alt="CJ Affiliate"></a>
  <a href="https://impact.com/stand-down-policy.ihtml"><img src="https://img.shields.io/badge/Impact-0E1C36?style=for-the-badge&logoColor=white" alt="Impact"></a>
  <a href="https://github.com/rakutenrewards/PublisherStandown-SDK"><img src="https://img.shields.io/badge/Rakuten%20Advertising-BF0000?style=for-the-badge&logo=rakuten&logoColor=white" alt="Rakuten Advertising"></a>
  <a href="https://success.awin.com/s/article/Downloadable-Software-Guidelines"><img src="https://img.shields.io/badge/Awin-E4097E?style=for-the-badge&logoColor=white" alt="Awin"></a>
  <a href="https://success.awin.com/s/article/Downloadable-Software-Guidelines"><img src="https://img.shields.io/badge/ShareASale-1F6FB2?style=for-the-badge&logoColor=white" alt="ShareASale"></a>
  <a href="https://partnernetwork.ebay.com/browser-extension-policy"><img src="https://img.shields.io/badge/eBay%20Partner%20Network-E53238?style=for-the-badge&logo=ebay&logoColor=white" alt="eBay Partner Network"></a>
  <a href="https://affiliate-program.amazon.com/help/operating/policies"><img src="https://img.shields.io/badge/Amazon%20Associates-FF9900?style=for-the-badge&logoColor=white" alt="Amazon Associates"></a>
</p>

The eighth verified pack is a **universal** set of publisher-contributed
redirect fingerprints ([piedotorg/standdown-domains](https://github.com/piedotorg/standdown-domains)).
Two more **experimental** packs are inferred from domain knowledge and stay
opt-in until you verify them for your integration:

<p align="center">
  <a href="https://www.sovrn.com/sovrn-commerce-publisher-code-of-conduct/"><img src="https://img.shields.io/badge/Sovrn%20%2F%20Skimlinks-FF5A00?style=for-the-badge&logoColor=white" alt="Sovrn / Skimlinks"></a>
  <a href="https://partnerize.com/legal/terms-and-conditions/"><img src="https://img.shields.io/badge/Partnerize-00B0A6?style=for-the-badge&logoColor=white" alt="Partnerize"></a>
</p>

> Network names and logos identify the stand-down policies each pack implements.
> They don't imply endorsement, partnership, or certification by these networks.

It ships four surfaces:

| Import | Purpose |
| --- | --- |
| `standdown` | Pure core: detection, session state machine, activation guard, policy validation, signed bundle verification, Rakuten converters |
| `standdown/policies` | Bundled policy packs and helpers |
| `standdown/webext` | Manifest V3 background/service-worker adapter |
| `standdown/content` | Content-script signal collector and evaluator |

## Install

```sh
npm install standdown
```

`standdown` is published to npm and versioned with semver from `0.1.0`. Releases
are cut by tagging a version with `npm run release`; CI then publishes over npm
Trusted Publishing (OIDC), with no stored token (see
[RELEASING.md](./RELEASING.md)).

## Set it up with an AI agent

The fastest path: hand the whole integration to your coding agent. Copy this
prompt into Claude Code, Cursor, Copilot, etc. — pointed at your extension's repo:

```text
Integrate the `standdown` npm library into this browser extension so it stops
hijacking affiliate attribution when a partner already owns the sale. Follow the
official guide at https://raw.githubusercontent.com/dupe-com/standdown/main/AGENTS.md.

First check whether this extension ALREADY has its own affiliate stand-down /
attribution-detection logic. If it does, STOP and use the brownfield migration
prompt at https://raw.githubusercontent.com/dupe-com/standdown/main/ADOPTING.md
instead — it moves the existing decision path onto the library in shadow mode,
proving parity before cutover so no live commission is put at risk. Only if this
is a greenfield install (no existing stand-down logic), do the full loop:
1. `npm install standdown`.
2. Pick the adapter by permissions: `standdown/webext` if the extension holds
   `webNavigation`/`webRequest`, otherwise `standdown/content` (Safari,
   content-script-only, or any MV3 build without those permissions).
3. Find every place this extension fires affiliate attribution (redirects, link
   rewrites, cookie writes) and gate each behind the stand-down decision — do
   nothing when `decision.standDown` is true.
4. Bundle per examples/mv3-extension (subpath imports don't resolve raw in
   extension contexts).
5. Build the unpacked extension, then grade it:
   git clone https://github.com/dupe-com/standdown && cd standdown/audit && \
     npm install && npx tsx grade/grade.ts <path-to-unpacked-extension>
   Report the letter grade and fix anything below A.

Preserve the invariants: decisions stay local and synchronous (no network in the
decision path), no user identity in signals, and fail toward standing down.
```

**Already have homegrown stand-down logic?** Use the brownfield prompt in
[`ADOPTING.md`](./ADOPTING.md) instead — it migrates your existing decision path
onto the library provably, without risking revenue in the switch.

**Claude Code users** can skip the prompt: this repo ships two skills in
[`.claude/skills/standdown`](./.claude/skills/standdown) (greenfield install) and
[`skills/adopt-standdown`](./skills/adopt-standdown) (brownfield migration). Copy
the one you want into your project's `.claude/skills/` (or `~/.claude/skills/`)
and run `/standdown` (or `/adopt-standdown`). Agents that read
[`AGENTS.md`](./AGENTS.md) or
[`llms.txt`](./llms.txt) get the same playbook automatically.

## Choosing an adapter

The choice is driven by **permissions, not manifest version** — an MV3 extension
that can't hold (or add) `webNavigation`/`webRequest` must use `content`.

| Your extension | Adapter |
| --- | --- |
| MV3 **with** `webNavigation`/`webRequest` (and willing to keep them) | `standdown/webext` |
| MV3 **without** those permissions, or that can't add them, or whose detection already runs in a content script | `standdown/content` |
| Safari, or any page-/content-script-only context | `standdown/content` |

`createStanddown()` (the `webext` adapter) **requires** `chrome.webNavigation.onCommitted`
and throws if it's absent — an adapter that observes no navigations would fail
open. If you can't ship that permission, use `content`. Adding
`webNavigation`/`webRequest` to an already-published extension can also trigger a
permission re-prompt that disables it for existing users until they re-accept,
which is often reason enough to choose `content`.

## Webext Quickstart

```ts
import { allPolicies } from 'standdown/policies';
import { createStanddown } from 'standdown/webext';

const standdown = createStanddown({
  policies: allPolicies,
  selfPatterns: [{ name: 'my_click_id', networkId: 'cj' }],
  publisherSites: ['example-publisher.com'],
});
```

The `standdown/webext` adapter is the Chromium-MV3 path. It observes
`chrome.webRequest.onBeforeRequest` redirect chains when available and uses
`chrome.webNavigation.onCommitted` final-URL signal collection when `webRequest`
is reduced or unavailable. `chrome.webNavigation.onCommitted` itself is
**required**: `createStanddown()` throws when that API is absent, because an
adapter that observes no navigations would fail open.

Safari and other reduced-permission contexts do **not** run this adapter — they
use the page-level `standdown/content` adapter below, which collects signals from
the page (`location.href`, `document.referrer`, first-party cookie names) and
needs no `chrome.*` network APIs. Content scripts and popups can query the
background worker with:

```ts
const response = await chrome.runtime.sendMessage({
  type: 'standdown:shouldStandDown',
  tabId,
  url,
});
```

Signed policy refresh is optional and runs outside the decision path:

```ts
createStanddown({
  policies: allPolicies,
  refresh: {
    url: 'https://static.example.com/standdown.bundle.json',
    publicKeyJwk,
    intervalMs: 60 * 60 * 1000,
  },
});
```

Only monotone updates are applied: detection coverage may broaden, durations may
lengthen, and activation rules must remain unchanged. Added overlapping
policies cannot downgrade a decision because the session layer unions behaviors
from every policy matching the advertiser. Signed bundles also reject overly
complex regex `DomainRule` patterns before they can enter local detection.

## Content Quickstart

```ts
import { allPolicies } from 'standdown/policies';
import { createContentStanddown } from 'standdown/content';

const standdown = createContentStanddown({
  policies: allPolicies,
  storage: 'session',
  publisherSites: ['example-publisher.com'],
});

const decision = await standdown.ready;
```

The content adapter collects only local page signals: `location.href`,
`document.referrer`, and first-party cookie names. Cookie values are never
included. SPA navigations are re-evaluated via `pushState`, `replaceState`, and
`popstate` hooks.

**Cookie matching is name-only, by design.** `CookiePattern` rules (`exact` and
`substring`) match against cookie **names**, never values — that is what keeps
user data structurally out of `Signals` (invariant I2). If you are migrating from
an implementation that matches against the whole `document.cookie` string (names
*and* values), verify that your cookie rules only depend on names before porting
them; a rule that secretly relied on matching a cookie *value* will not fire here.
This is intentional and not configurable: matching values would require cookie
values to enter `Signals`, which the closed-signal privacy guarantee forbids.

`storage: 'local-ttl'` stores session records in `localStorage` with a sliding
24-hour envelope TTL by default. The TTL clears session records, not audit
history; per-policy stand-down durations remain enforced by the core state
machine.

### Degraded decisions

The content adapter (and a webext adapter running without the `webRequest`
plane) cannot observe redirect chains, so it sets `Signals.signalCoverage =
'partial'`. When a decision comes back `standDown: false` from a partial signal
set, it carries `degraded: true` — the "no stand-down" may be a false negative
because a redirect-only attribution could have been missed. Stand-down decisions
are never marked degraded (over-suppression is the safe direction). Integrators
that want to fail fully closed can treat a degraded non-stand-down as a
stand-down:

```ts
const decision = await standdown.ready;
const suppress = decision.standDown || decision.degraded;
```

## Self-exemption scope

`selfPatterns` declare the params that are *your own* attribution — when one
matches, the library does not stand down against that network (it's your click,
not a competitor's). By default this exemption lasts only for the navigation that
carries the param (`selfExemptionScope: 'policy'`). Merchants often strip the
param on later internal navigations while your attribution (a first-party cookie,
say) lingers — under policy scope that lingering signal would then read as a
competitor and stand you down.

`selfExemptionScope: 'session'` fixes that: once your param is seen on a host, the
exemption is remembered for the session and re-applied to *that same network's*
signals on later param-less navigations. This is Dupe's `ignore_param` behavior.

```ts
const session = new StanddownSession(store, { selfExemptionScope: 'session' });
// or, through an adapter:
createStanddown({ policies, selfPatterns, selfExemptionScope: 'session' });
```

It is deliberately **network-precise, not host-blanket**, and monotone:

- A fresh signal from a *different* network on the same host still stands down —
  claiming the host for your network never silences a competitor's.
- A session exemption **never lifts an already-active stand-down**. If a
  competitor stand-down formed first, a later self-param does not clear it (no
  exemption is even recorded while a stand-down is active).
- A `disableHosts` match is immune — a hard-disabled host stands down regardless
  of any exemption.

### A self-click param that clears every network

A `selfPattern` only clears a stand-down for the network (or policy) it is
**scoped** to via `networkId`/`policyId`. An **unscoped** pattern (neither set) is
reported as a `selfMatch` but does **not** clear a third-party match — so it
silently fails to exempt you. If your click param is global — it identifies *your*
attribution against any network — scope one pattern per network:

```ts
import { allPolicies } from 'standdown/policies';

const networkIds = [...new Set(allPolicies.map((p) => p.network.id))];
const selfPatterns = networkIds.map((networkId) => ({
  name: 'my_click_id',
  value: '_mybrand',
  match: 'contains' as const,
  networkId,
}));
```

Getting this wrong fails in the *safe* direction — an unscoped (ineffective)
pattern means the library stands down on your **own** clicks — but that suppresses
attribution you were entitled to, so it is a silent revenue leak. Expand across
every network you ship a policy for.

## Core Usage

```ts
import { MemoryStateStore, StanddownSession, guardActivation } from 'standdown';
import { cjPolicy } from 'standdown/policies';

const session = new StanddownSession(new MemoryStateStore());
const decision = await session.ingest(
  { url: 'https://merchant.example/?cjevent=abc', now: Date.now() },
  [cjPolicy],
);

const guard = guardActivation({
  decision,
  userGesture: { isTrusted: true, type: 'click', timeStamp: performance.now() },
  benefit: { kind: 'cashback', description: 'Activate cashback.' },
  policy: cjPolicy,
});
```

## Public Commitments

- **I1: Client-side decisions only.** No network call participates in a
  stand-down decision. Refresh may update the already-applied local policy
  bundle asynchronously, but decisions use local state synchronously.
- **I2: No user profiling.** Signals are a closed type and exclude user identity,
  accounts, balances, emails, login state, and tester-differentiating data.
- **I3: Fail toward standing down.** Unknown, ambiguous, malformed, or storage
  error states suppress activation.
- **I4: Monotone remote updates.** Signed refresh bundles may only broaden
  detection or lengthen durations and may not edit activation rules.
- **I5: Audit log on by default.** Decisions and refresh outcomes are locally
  auditable.
- **I6: No remote code.** Policies are data. No eval, remote scripts, or dynamic
  code loading.
- **I7: Deterministic and loggable.** Given the same local signals, policies,
  state, and clock, decisions are reproducible.

## Conformance grading

Unit tests prove the library's decisions in isolation. The
[`audit/`](./audit) harness proves the thing they can't: whether a *real MV3
extension*, loaded into a *real browser* against realistic merchant pages,
actually stands down instead of hijacking existing attribution.

It serves synthetic merchant fixtures carrying pre-existing attribution for
each network, drives an extension through every scenario, and scores the run
**F → A+**:

```sh
cd audit && npm install
npx tsx grade/grade.ts /path/to/your/unpacked-extension
#   standdown grade: A+  (100/100)
#   Respected existing attribution across all tested networks and activated when allowed.
```

The rubric includes an **inert cap**: an extension that never activates even when
activation is *allowed* hasn't proven it does anything, so it can't score above a
C. That stops "disciplined stand-down" from being faked by shipping dead code.
Three reference extensions (`good` / `bad` / `inert`) ship alongside to validate
the grader itself.

The harness is opt-in: it is not part of the npm package and is not on the
required CI path. See [`audit/README.md`](./audit/README.md) for the full guide.

## Per-host disable

Some merchants are ones where competing activation is never acceptable — the
integrator wants to go fully quiet on that host rather than detect-then-suppress.
`detection.disableHosts` expresses that: any navigation whose advertiser host
matches stands down **unconditionally**, regardless of params, cookies, or
self-exemption. It is the strongest match kind (`disabled-host`), and it is how
you model a "we do not operate here at all" list (the extension's
`disable_domains`).

```ts
const merchantBlocklistPolicy = {
  // ...id, network, standdown, activation, metadata...
  detection: {
    disableHosts: [
      { pattern: '(^|\\.)ebay\\.[a-z.]+$', kind: 'regex' },
      { pattern: 'homedepot.com', kind: 'suffix' },
    ],
  },
};
```

A `disableHosts` match cannot be cleared by a `selfPatterns` exemption — if you
list a host here, your own attribution on that host still stands down. Use it
only for hosts where you never want to activate.

## Interop

`fromRakutenPolicy()` and `toRakutenPolicy()` convert Rakuten
`NetworkPolicy` schemaVersion 2 data. Rakuten's schema is detection-only, so
native fields such as cookie rules, initiator rules, activation guard details,
stand-down behaviors, citations, audit semantics, multi-group `anyOf` param
rules, and `match: 'contains'` params are lossy when emitting Rakuten v2. The
bundled `rakuten` policy itself intentionally does not round-trip exactly.

## Policy Packs

| Policy | Main signals | Stand-down | Activation |
| --- | --- | --- | --- |
| `cj` | `cjevent`, `cjdata`, `utm_source=cj`, `sf_cs=cj`, `afsrc=1`, CJ redirect domains, CJ cookie names | Session-or-min 60m | User click |
| `impact` | `afsrc=1`, `irclickid`, `irgwc`, `im_ref` cookie names | Session-only | User click |
| `rakuten` | `ranMID`, `ranEAID`, `ranSiteID`, `siteID`, LinkSynergy redirect domains, LinkShare cookie names | Session-only | User click |
| `awin` | `awc`, `utm_source=aw`, `source=aw`, `awin1.com` | CoC defaults | User click |
| `shareasale` | `sscid`, ShareASale redirect domains, `sscid` cookie name | CoC defaults | User click |
| `ebay-epn` | eBay EPN params, `rover.ebay.com`, scoped referrer classification | CoC defaults | User click |
| `amazon` | Amazon `tag` on Amazon advertiser hosts | Suppression visibility only | Never |
| `sovrn-skimlinks` † | Skimlinks redirect domains | CoC defaults | User click |
| `partnerize` † | `clickref`, `prf.hn` | CoC defaults | User click |
| `universal` | Full `piedotorg/standdown-domains` list plus `afsrc=1` | CoC defaults | User click |

`allPolicies` is the **verified** default set. Packs marked † (`sovrn-skimlinks`,
`partnerize`) have redirect domains inferred from domain knowledge rather than
verified against network documentation, so they are excluded from `allPolicies`
and exported separately as `experimentalPolicies`. Opt in explicitly once you
have verified them for your integration:

```ts
import { allPolicies, experimentalPolicies } from 'standdown/policies';

const policies = [...allPolicies, ...experimentalPolicies];
```

`amazon` is detect-only: it reports attribution for suppression visibility but
its `activation.mode` is `never`, so the guard will never allow activation on an
Amazon advertiser host. Integrators with their own Amazon arrangement can supply
a policy that overrides this.

See [POLICIES.md](./POLICIES.md) for citations and attribution.

## Example

See [examples/mv3-extension](./examples/mv3-extension) for a minimal Manifest V3
background worker and popup using `standdown/webext`.
