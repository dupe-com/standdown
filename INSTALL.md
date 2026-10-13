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
const { decision } = await chrome.runtime.sendMessage({
  type: 'standdown:relay:shouldStandDown',
  url: location.href,
});
if (decision.standDown) return; // decision.matchKind === 'landing' when the param was stripped
```

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
- **Never with a competing signal** on the same page, and never on a
  `disableHosts` host.

Decisions it lifts carry `reason: 'self-click-lifted'` in the audit log.

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
