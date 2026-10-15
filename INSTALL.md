# Manual installation & API reference

The recommended way to integrate `standdown` is to hand it to a capable coding
agent with the prompt in the [README](./README.md#set-it-up-with-an-ai-agent) —
it finds every attribution firing point in your extension for you and follows
[`AGENTS.md`](./AGENTS.md). This file is the **manual path**: the same steps, done
by hand, plus the full API surface as a reference.

## Install

```sh
npm install standdown
# or
bun add standdown
# or
pnpm add standdown
# or
yarn add standdown
```

Published to npm, versioned with semver from `0.1.0`. ESM and CJS are both
published, with types included. Extension contexts need a bundler (see
[Build / bundle](#build--bundle)).

## Surfaces

| Import | Purpose |
| --- | --- |
| `standdown` | Pure core: detection, session state machine, activation guard, policy validation, signed bundle verification, Rakuten converters |
| `standdown/policies` | Bundled policy packs and helpers |
| `standdown/webext` | Manifest V3 background/service-worker adapter |
| `standdown/content` | Content-script signal collector and evaluator |
| `standdown/url` | URL-only decision helper for background/side-panel contexts (no live page) |
| `standdown/relay/capture` + `standdown/relay/background` | Early landing capture at `document_start`, decided in the background, without `webNavigation` |

## Choosing an adapter

The choice is driven by **permissions, not manifest version** — an MV3 extension
that can't hold (or add) `webNavigation`/`webRequest` must use `content`.

| Your extension | Adapter |
| --- | --- |
| MV3 **with** `webNavigation`/`webRequest` (and willing to keep them) | `standdown/webext` |
| MV3 **without** those permissions, or that can't add them, or whose detection already runs in a content script | `standdown/content` |
| Safari, or any page-/content-script-only context | `standdown/content` |
| A background worker or native side panel deciding from a **tab's URL** (no live page, no `document`, no first-party cookies) | `standdown/url` |
| MV3 **without** `webNavigation`, on shops that strip referral params before `document_idle` | `standdown/relay` (capture + background) |

**What each adapter can see**, from most to least permission:

| | `webext` | `relay` | `content` |
| --- | --- | --- | --- |
| Extra permissions | `webNavigation` (+ optional `webRequest`) | none beyond host access + `storage` | none |
| Install warning | "Read your browsing history" | none new | none |
| Runs in | background | `document_start` capture + background | content script at `document_idle` |
| Param the shop strips before idle | ✅ | ✅ | ❌ |
| Same-site / `link.` → `www.` script forward | ✅ | ✅ (within `hopWindowMs`) | ❌ |
| A param removed **by the shop's server** (a redirect before any page loads) | ✅ with `webRequest` | ❌ | ❌ |
| First-party cookie names | ❌ | ❌ | ✅ |

That ❌ is narrower than it looks. A normal affiliate click *does* redirect
through the network's servers, but it lands on the shop with the param still in
the URL (`?cjevent=abc`), and the relay reads that landing page. The relay only
misses a flow where the param never reaches a loaded page: the shop's own server
reads it and redirects to a clean URL before anything renders, or a redirect
hop sets attribution without passing a param on. `e2e/run.mjs` asserts this
limit so it stays documented.

In short: `relay` is the low-permission middle option. It catches what `content`
misses on shops that strip the param, without the install warning `webext`
needs. A host can run `relay` and `content` side by side if it also wants cookie
rules (Rakuten's `lsclick_mid`).

`createStanddown()` (the `webext` adapter) **requires** `chrome.webNavigation.onCommitted`
and throws if it's absent — an adapter that observes no navigations would fail
open. If you can't ship that permission, use `content`. Adding
`webNavigation`/`webRequest` to an already-published extension can also trigger a
permission re-prompt that disables it for existing users until they re-accept,
which is often reason enough to choose `content`.

## Using the `Decision` correctly

The one rule: **when `decision.standDown` is true, do not activate** — no
redirect, no cookie write, no affiliate link rewrite.

Content and reduced-permission webext adapters can't see redirect chains, so a
`standDown: false` may carry `degraded: true`. How you treat `degraded` depends on
your extension's profile:

- **Redirect-plane tools, or any extension that must never activate without full
  coverage** — treat `degraded` as suppression: `const suppress = decision.standDown || decision.degraded;`
- **Always-on content-adapter extensions** (Safari / content-script shopping
  extensions that must activate on ordinary product pages) — gate on `standDown`
  **alone**: `const suppress = decision.standDown;`

The content plane **always** reports `degraded: true` on a non-stand-down
decision (it structurally can't observe redirect chains), so treating `degraded`
as suppression there makes the extension inert — it never activates on a clean
page. Gating on `standDown` alone is still fully fail-closed: the library returns
`standDown: true` for every error, malformed-policy, and unknown state regardless
of coverage. Stand-down decisions are never `degraded`.

A stand-down that this navigation's own params triggered also says which params
matched, by name only, never by value:

- `matchedParams`: the landing param names, as the policy spells them, for
  example `['cjevent', 'afsrc']`.
- `sharedOnly: true`: every signal behind it is a shared one (`afsrc=1`), which
  several networks append. The stand-down is just as binding, but `policyId` may
  not name the network that actually referred the shopper.

Both are absent when the decision comes from an earlier referral on the host.

## Webext adapter

```ts
import { allPolicies } from 'standdown/policies';
import { createStanddown } from 'standdown/webext';

const standdown = createStanddown({
  policies: allPolicies,
  // Declare YOUR OWN attribution params so the library never stands you down
  // against your own clicks (see Self-exemption scope):
  selfPatterns: [{ name: 'my_click_id', networkId: 'cj' }],
  publisherSites: ['example-publisher.com'],
});
```

It observes `chrome.webRequest.onBeforeRequest` redirect chains when available and
uses `chrome.webNavigation.onCommitted` final-URL signal collection when
`webRequest` is reduced or unavailable. `chrome.webNavigation.onCommitted` itself
is **required**: `createStanddown()` throws when that API is absent, because an
adapter that observes no navigations would fail open.

Query the decision from a content script or popup:

```ts
const { ok, decision } = await chrome.runtime.sendMessage({
  type: 'standdown:shouldStandDown',
  tabId,
  url,
});
if (decision.standDown) return; // suppress your activation
```

### Signed policy refresh (optional)

Refresh runs **outside** the decision path:

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
lengthen, and activation rules must remain unchanged. Added overlapping policies
cannot downgrade a decision because the session layer unions behaviors from every
policy matching the advertiser. Signed bundles also reject overly complex regex
`DomainRule` patterns before they can enter local detection.

## Content adapter

```ts
import { allPolicies } from 'standdown/policies';
import { createContentStanddown } from 'standdown/content';

const standdown = createContentStanddown({
  policies: allPolicies,
  storage: 'session', // or 'local-ttl' for a sliding 24h envelope
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
This is intentional and not configurable.

`storage: 'local-ttl'` stores session records in `localStorage` with a sliding
24-hour envelope TTL by default. The TTL clears session records, not audit
history; per-policy stand-down durations remain enforced by the core state
machine.

## URL adapter

For surfaces that fire (or suppress) attribution from a **URL string** rather
than a live page — a native side panel, or a background/service worker deciding
whether to auto-load a monetized comparison for a tab's URL. These contexts have
no `document`, can't read the merchant's cross-origin first-party cookies, and
often don't observe the redirect chain.

```ts
import { allPolicies } from 'standdown/policies';
import { createUrlStanddown } from 'standdown/url';

const standdown = createUrlStanddown({
  policies: allPolicies,
  selfPatterns: [{ name: 'myclickid' }], // YOUR OWN attribution params
  publisherSites: ['example-publisher.com'],
});

// referrer/initiator are optional — pass them when you know them.
const decision = await standdown.decideForUrl(tabUrl, { referrer });
if (decision.standDown) {
  // a partner already owns this sale — do not auto-load / rewrite / redirect.
}
```

`decideForUrl` collects signals from the URL (+ optional `referrer`/`initiator`)
only — no cookies, no redirect chain — and shares the same policy set,
self-exemption, and `disableHosts` semantics as the other adapters. Because the
signal set is incomplete it **always reports `signalCoverage: 'partial'`**, so a
non-stand-down decision carries `degraded: true` (see [Using the `Decision`
correctly](#using-the-decision-correctly)). It **fails toward standing down** on
a missing or malformed URL and on any collection error.

State defaults to an in-memory store (fitting a stateless worker); pass a durable
`store` to carry stand-downs across worker restarts. The lower-level
`collectUrlSignals(url, opts)` is exported if you want to drive
`StanddownSession.ingest` yourself.

## Relay adapter

Some shops strip the referral param (`?cjevent=abc`) with `history.replaceState`,
or forward to a clean URL by script, before `document_idle`. A content script
that reads `location` at idle then sees a clean URL and reports "not referred".
`webext` would see the param, but needs `webNavigation`. The relay closes that
gap with no new permission: a tiny `document_start` capture plus a background
decision.

**Manifest** (nothing beyond host access you already have and `storage`):

```json
{
  "permissions": ["storage"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["<your existing host matches>"],
      "js": ["relay-capture.js"],
      "run_at": "document_start",
      "all_frames": false
    }
  ]
}
```

**`relay-capture.js`** (bundle it; keep it to this):

```ts
import { allPolicies } from 'standdown/policies';
import { captureLanding } from 'standdown/relay/capture';

captureLanding({
  policies: allPolicies,
  selfPatterns: [{ name: 'my_click_id', networkId: 'cj' }],
});
```

**Background:**

```ts
import { allPolicies } from 'standdown/policies';
import { createRelayStanddown } from 'standdown/relay/background';

const relay = createRelayStanddown({
  policies: allPolicies,
  selfPatterns: [{ name: 'my_click_id', networkId: 'cj' }],
  publisherSites: ['your-site.com'],
});
```

**Query** from any content script (the tab comes from `sender.tab.id`):

```ts
import { shouldStandDownMessage } from 'standdown/relay/capture';

const { decision } = await chrome.runtime.sendMessage(shouldStandDownMessage(location.href));
if (decision.standDown) return; // decision.matchKind === 'landing' when the param was stripped
```

Use `shouldStandDownMessage()` rather than a literal. Its `timestamp` (also on the
capture's own message) keeps message routers that throw on, and *answer*, any
runtime message without a `type` and numeric `timestamp` from replying before the
relay does. `@webext-core/messaging`, common in WXT extensions, is one: without
the timestamp its error reply wins, and every query fails closed.

What happens:

- **Capture** reads `location.href` and `document.referrer` before page scripts
  run, matches each policy's `landingParams` (values are compared in the page,
  so `equals` rules and your own-click `selfPatterns` work), and keeps only
  `{ v, host, at, matches: [{ policyId, params: [names] }] }` — never a URL, a
  path, or a param value. It mirrors that to `sessionStorage` (survives a
  same-tab reload) and sends it to the background, retrying once if the worker
  isn't listening yet. The referrer counts only when it is on the same base
  domain (a same-origin script forward keeps the full referrer) or a tracking host.
- **Background** keys records by `sender.tab.id` (top frame only) in
  `chrome.storage.session`, deletes them on `tabs.onRemoved`, and answers by
  replaying the matched param names into the regular `StanddownSession`, so
  session rules, self-exemption and `disableHosts` behave exactly as elsewhere.
  A stand-down caused by a param no longer in the URL carries
  `matchKind: 'landing'`.
- **Cross-host forwards** (`link.shop.example?cjevent=abc` → script →
  `www.shop.example`) carry over in the same tab when the next page arrives within
  `hopWindowMs` and the earlier host shares the base domain or matches a
  `trackingHosts` rule (on the policy's `detection.trackingHosts`, or the
  `trackingHosts` option). A param seen on an unrelated site does not carry over;
  landing on an unrelated site drops the record.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxAgeMs` | 30 min | How long a landing record counts. It also ends when the tab moves to an unrelated site or closes. |
| `hopWindowMs` | 10 s | How soon a forward to another same-base / tracking host must land to carry the record. |
| `trackingHosts` | `[]` | Extra `DomainRule`s on top of each policy's `detection.trackingHosts` (empty in bundled policies). |
| `baseDomain` | 2–3 label heuristic | Swap in a public-suffix-list function if you need exact registrable domains. |
| `store` | `ChromeLocalStateStore` | Decision state, as for `webext`. |

Permissions: host access you already have and `storage`. It does **not** use
`webNavigation`, `webRequest`, `tabs` or `scripting`; `sender.tab.id` and
`tabs.onRemoved` need none of them.

Known limits:

- **Server-side redirect hops** load no page, so nothing in the page can see
  them. Only `webext` with `webRequest` observes those.
- URL fragment (`#…`) params are not read.
- Like `content`, a non-stand-down still carries `degraded: true`.
- The capture only sees pages your content script matches; on other sites,
  "moved to an unrelated site" is not observed and `maxAgeMs` bounds the record.

## Core usage

For non-extension or custom hosts, drive the session and guard directly:

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

## Param matchers

Policies, and your own `selfPatterns`, match a URL param with a `ParamMatcher`.
Param names match in any casing in policies (own-click names stay exact); values
compare exactly.

| `match` | Matches when | Example |
| --- | --- | --- |
| `'exists'` (default without `value`) | the param is present | `{ name: 'cjevent' }` |
| `'equals'` (default with `value`) | a value equals `value` | `{ name: 'afsrc', value: '1', match: 'equals' }` |
| `'contains'` | a value contains `value` | `{ name: 'ranSiteID', value: 'ABC-', match: 'contains' }` |
| `'pattern'` | a value fits the regular expression in `value` | `{ name: 'siteID', match: 'pattern', value: '^[A-Za-z0-9]{4}-[0-9]{2}$', example: 'AbC1-42' }` |

`'pattern'` rules, so a policy (including one from a signed refresh) stays fast
and predictable:

- `value` is a JavaScript regular expression source with no flags, anchored with
  both `^` and `$`, at most 256 characters.
- Only a fast subset is accepted: single characters (a literal, an escape such as
  `\d` or `\.`, `.`, or a `[...]` class), each with an optional count. Fixed
  counts like `{11}` can appear any number of times, but **at most one** count
  may vary in length (`+`, `*`, `?`, `{2,}`, `{2,4}`). No groups and no `|`.
  That covers ID shapes (`^[A-Za-z0-9]{11}-[A-Za-z0-9]{22}$`, `^brand_[0-9]{4}$`)
  and keeps matching time in line with the value's length. Patterns with
  stacked repeats (`a*a*a*`) or chains of choices (`(a|a)(a|a)…`) can take
  seconds or longer on a short value, so they are rejected.
- Validation rejects a pattern outside that subset, or one that doesn't compile,
  isn't anchored or is too long. Sessions and every adapter validate policies
  first, so a policy with a rejected pattern stands down. (Calling `detect()`
  directly skips validation: there a rejected pattern simply never matches.)
- A value longer than 512 characters never matches. At most 16 values of one
  param are tested: a URL that repeats it more often stands down, and an
  own-click pattern doesn't apply to it.
- `example` (optional, `'pattern'` only) is a made-up value the pattern must
  match, at most 512 characters. Validation checks it, and the conformance grader
  uses it to build a matching landing. Never put a real ID there.

`shared: true` marks a signal several networks append, like `afsrc=1` (also on a
`redirectDomains` rule). It still stands down on its own. When the same URL
carries your own scoped click, a param group made only of shared matchers is
explained by your click and doesn't match, and `selfClickLift` never counts
shared-only evidence as a network's own. The bundled `cj`, `impact` and
`universal` policies mark `afsrc=1` this way.

## Self-exemption scope

`selfPatterns` declare the params that are *your own* attribution — when one
matches, the library does not stand down against that network (it's your click,
not a competitor's). `selfPatterns` names match **exactly** (case-sensitive),
unlike policy landing params, which match names case-insensitively — so a
differently-cased param never widens your exemption. Declare the casing your
links actually carry. By default this exemption lasts only for the navigation that
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

### Letting your own click end an earlier stand-down (`selfClickLift`)

**In short:** off by default. Turn it on and, when a shopper clicks *your* link
on a network after a competitor's link on that same network, the stand-down for
the competitor ends, because the network now credits your click.

```ts
createContentStanddown({ policies, selfPatterns, selfClickLift: 'same-network' });
// relay: set it on BOTH halves, like selfPatterns
captureLanding({ policies, selfPatterns, selfClickLift: 'same-network' });
createRelayStanddown({ policies, selfPatterns, selfClickLift: 'same-network' });
```

It only lifts when it is safe:

- **Same network only.** Your CJ click ends a CJ stand-down, never an Impact or
  Rakuten one. Scope one `selfPatterns` entry per network you're on.
- **Only an older referral.** A competitor click *after* yours (in any tab) keeps
  the stand-down.
- **Never a mixed one.** If several networks fed the stand-down, it stays.
  `afsrc=1` alone doesn't count as a network here: a competitor's CJ click that
  carried it can be lifted, and once a landing carried `afsrc=1` alone, the
  stand-down is never lifted, whatever came before or after it.
- **Never with a competing signal** on the same page, and never on a
  `disableHosts` host.

Decisions it lifts carry `reason: 'self-click-lifted'` in the audit log.

Only a **fresh navigation** counts as a click. A reload, back/forward or SPA
re-check of a URL that still carries your param is not a new click (the shopper
may have clicked a competitor's link since), so it exempts but never lifts. The
`content`, `webext` and `relay` adapters handle this for you. If you call
`StanddownSession.ingest()` directly, pass `selfClickAt` (when the click
landed) for fresh navigations only. `standdown/url` has no navigation events,
so it doesn't offer the lift.

#### What the shopper sees

Nothing changes for the shopper; this is host configuration. A typical visit:

1. 2:00 — the shopper clicks a competitor's CJ link to `shop.example`. Your
   extension stands down (CJ: for the session, at least 60 minutes).
2. 2:10 — still shopping, the shopper clicks **your** CJ link to the same shop.
   CJ now credits your click, so with `selfClickLift` on the stand-down ends and
   your extension may activate again (still behind your usual user-click rules).
3. 2:20 — they click a competitor's CJ link again. That is now the latest click,
   so your extension stands down again.

Had step 2 been your **Impact** link instead, nothing would lift: your Impact
click doesn't move the CJ partner's credit.

#### Setting up your own-click patterns, per network

A pattern must match a param **value only your clicks carry**. A network's click
ID alone can't tell your click from a competitor's (`cjevent`, `irclickid` and
`awc` are per-click IDs, not publisher IDs), so don't scope a lift to those
without a value that is yours.

The most portable approach is a marker of your own: add a param to the
**destination URL** of every affiliate link you build (the deep link's landing
page), with a **different value per network**, for example
`?my_click_id=_mybrand_cj` on CJ links. A deep link redirects to that URL, so the
marker usually arrives on the landing page with the click (confirm with a real
click, below). Then scope each value to its network:

```ts
const selfPatterns = [
  // Your own marker, one value per network you send traffic through:
  { name: 'my_click_id', value: '_mybrand_cj', match: 'equals', networkId: 'cj' },
  { name: 'my_click_id', value: '_mybrand_impact', match: 'equals', networkId: 'impact' },
  { name: 'my_click_id', value: '_mybrand_awin', match: 'equals', networkId: 'awin' },
  // Where the network's own landing param already identifies you, you can use
  // it instead (check a real landing URL from your own link first):
  // CJ: PID is your publisher ID, but it reaches the landing page only where
  // the merchant passes it through, so treat it as an extra, not the marker:
  // { name: 'PID', value: 'YOUR_CJ_PID', match: 'equals', networkId: 'cj' },
  // Rakuten: ranSiteID starts with your encrypted publisher ID.
  { name: 'ranSiteID', value: 'YOUR_ENCRYPTED_ID-', match: 'contains', networkId: 'rakuten' },
  // eBay Partner Network: campid is your campaign ID.
  { name: 'campid', value: 'YOUR_CAMPAIGN_ID', match: 'equals', networkId: 'ebay-epn' },
] as const;

createContentStanddown({ policies, selfPatterns, selfClickLift: 'same-network' });
```

To find yours: click one of your own affiliate links for each network, copy the
URL the shop's page lands on (before it strips anything, e.g. from the network's
link tester or your browser's network log), and pick the param/value that would
differ on a competitor's click. Then:

- **One network per own click.** Use a different marker value per network. If one
  click matches your patterns for two networks (say the same `_mybrand` scoped to
  CJ and Awin), the library can't tell whose credit it moved: it still exempts
  you, but never lifts. (The `universal` catch-all doesn't count as a network.)
- **`afsrc=1` links.** CJ, Impact and the `universal` policy all read `afsrc=1`,
  which says "some affiliate", not which one. When your own scoped click is in
  the same URL, `afsrc=1` is explained by it, so scope the marker to its one
  network only (`cj` for a CJ link). Scoping it to more networks makes the click
  name two networks, so it would only exempt, never lift. A stand-down that rests
  only on `afsrc=1` is never lifted, nor one where any landing carried
  `afsrc=1` alone.
- **Scope every pattern** with `networkId` (or `policyId`). An unscoped pattern
  never exempts or lifts anything (see below).
- **Prefer `equals` or a distinctive `contains` value.** A loose `contains` (e.g.
  a short common string) could match a competitor's click and lift *their*
  stand-down, which is a hijack. Own-click names match case-sensitively.
- **Relay hosts:** pass the same `selfPatterns` and `selfClickLift` to both
  `captureLanding()` and `createRelayStanddown()`.
- Networks whose policy never activates (`amazon`) or with no click of yours
  (`universal`, `afsrc=1`) need no pattern.

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

## Per-host disable

Some merchants are ones where competing activation is never acceptable — the
integrator wants to go fully quiet on that host rather than detect-then-suppress.
`detection.disableHosts` expresses that: any navigation whose advertiser host
matches stands down **unconditionally**, regardless of params, cookies, or
self-exemption. It is the strongest match kind (`disabled-host`), and it is how
you model a "we do not operate here at all" list.

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
list a host here, your own attribution on that host still stands down. Use it only
for hosts where you never want to activate.

> **Porting a substring domain list?** `kind: 'suffix'` rules match a
> **registrable domain**, not a substring: `'ebay.com'` matches `ebay.com` and
> `*.ebay.com`, but a bare `'ebay.'` (or `'ebay'`) matches *nothing real*. A
> legacy list matched with `hostname.includes('ebay.')` covers every eBay TLD;
> the same string as a suffix rule is silently **inert**. Expand it to full hosts
> (`ebay.com`, `ebay.de`, `ebay.com.au`, `ebay.fr`, …) or switch to
> `kind: 'regex'` (e.g. `'(^|\\.)ebay\\.[a-z.]+$'`). `validatePolicy` emits a
> `console.warn` when it sees a bare-label suffix, so this trips at load time
> rather than in production.

## Build / bundle

Chrome does **not** resolve npm package subpath imports (`standdown/webext`,
`standdown/content`) from service workers, content scripts, or popups. You **must
bundle** before loading unpacked:

- **webext adapter** → [`examples/mv3-extension`](./examples/mv3-extension) has a
  minimal background + popup and the exact `esbuild` command.
- **content adapter** → [`examples/content-extension`](./examples/content-extension)
  has a content script that gates on `decision.standDown` alone.

Bundlers that resolve subpath imports themselves (WXT, Vite) handle this for you.

## Interop

`fromRakutenPolicy()` and `toRakutenPolicy()` convert Rakuten `NetworkPolicy`
schemaVersion 2 data. Rakuten's schema is detection-only, so native fields such as
cookie rules, initiator rules, activation guard details, stand-down behaviors,
citations, audit semantics, multi-group `anyOf` param rules, and `match: 'contains'`
params are lossy when emitting Rakuten v2. The bundled `rakuten` policy itself
intentionally does not round-trip exactly.

## Grade your integration

Prove it stands down with the [`audit/`](./audit) harness. Start with the
browser-free adopter grade:

```sh
git clone https://github.com/dupe-com/standdown && cd standdown/audit && npm install
DISABLE_HOSTS="ebay.com,homedepot.com" npx tsx grade/conformance.ts
```

See [README → How it's graded](./README.md#how-its-graded) and
[`audit/README.md`](./audit/README.md) for the full guide.
