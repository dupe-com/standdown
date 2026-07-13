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
