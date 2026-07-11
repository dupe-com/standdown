<p align="center">
  <img src="https://raw.githubusercontent.com/dupe-com/standdown/main/assets/logo.png" alt="standdown — affiliate stand-down, done right" width="620">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/standdown"><img src="https://img.shields.io/npm/v/standdown?color=F5A623&label=npm&labelColor=1C1917" alt="npm version"></a>
  <a href="https://github.com/dupe-com/standdown/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dupe-com/standdown/ci.yml?branch=main&label=CI&labelColor=1C1917" alt="CI status"></a>
  <img src="https://img.shields.io/badge/tests-87%20passing-2ea043?labelColor=1C1917" alt="87 tests passing">
  <img src="https://img.shields.io/badge/dependencies-0-2ea043?labelColor=1C1917" alt="zero runtime dependencies">
  <img src="https://img.shields.io/badge/types-included-3178C6?labelColor=1C1917" alt="TypeScript types included">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/standdown?color=8A8175&labelColor=1C1917" alt="MIT license"></a>
  <a href="https://affiliatecoc.org"><img src="https://img.shields.io/badge/aligned-Affiliate%20CoC-F5A623?labelColor=1C1917" alt="aligned with the Affiliate Code of Conduct"></a>
</p>

> **Your extension shouldn't steal the sale.** `standdown` detects existing
> affiliate attribution, suppresses competing activation, and proves the
> decision was made locally — never on a server.

Built and maintained by [Dupe](https://dupe.com).

`standdown` is a zero-runtime-dependency TypeScript library for extension
developers who need to detect existing affiliate attribution, suppress
competing activation, and prove that suppression decisions were made locally and
deterministically.

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
are cut by a human; the repo does not publish from CI.

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

`storage: 'local-ttl'` stores session records in `localStorage` with a sliding
24-hour envelope TTL by default. The TTL clears session records, not audit
history; per-policy stand-down durations remain enforced by the core state
machine.

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
| `impact` | `afsrc=1`, `irclickid`, `irgwc`, `im_ref` cookie names | Session-or-min | User click |
| `rakuten` | `ranMID`, `ranEAID`, `ranSiteID`, `siteID`, LinkSynergy redirect domains, LinkShare cookie names | Session-or-min fallback | User click |
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
