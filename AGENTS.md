# AGENTS.md — integrating `standdown`

Instructions for an AI coding agent (Claude Code, etc.) adding the
[`standdown`](https://www.npmjs.com/package/standdown) library to a browser
extension or shopping tool. Copy this file — or point your agent at it — and
follow the steps in order.

> Developing `standdown` itself (not integrating it)? See `README.md` and
> `CONTRIBUTING`. This file is the *consumer* playbook.

## What standdown is (read first)

`standdown` decides, client-side, whether your extension should **stand down**
(stay quiet) because a partner already owns the current affiliate attribution —
so you don't hijack a sale someone else referred. It is **advisory**: it returns
a `Decision`; it never redirects, blocks, or fires anything itself. You own the
side effects. Keep these invariants intact when you integrate:

- **Decisions are local and synchronous.** Never add a network call to the
  decision path.
- **Signals are a closed type.** Never feed user identity, account, balance, or
  login state into it.
- **Fail toward standing down.** On unknown/ambiguous/error states, suppress.

## Step 1 — Install

```sh
npm install standdown
```

ESM and CJS are both published. Requires a bundler for extension contexts (see
Step 4).

## Step 2 — Pick the adapter for your context

The choice is driven by **permissions, not manifest version.**

| Your context | Import | Entry |
| --- | --- | --- |
| MV3 extension that holds (and will keep) `webRequest`/`webNavigation` | `standdown/webext` | `createStanddown()` |
| MV3 extension **without** those permissions, or that can't add them | `standdown/content` | `createContentStanddown()` |
| Safari / page- or content-script-only | `standdown/content` | `createContentStanddown()` |
| Non-extension or custom host | `standdown` | `StanddownSession` + `guardActivation` |

**Decision rule:** if the extension does not already hold
`webRequest`/`webNavigation`, use `content`. Do **not** add those permissions to
an already-published extension just to reach for `webext` — doing so triggers a
permission re-prompt that disables the extension for every existing user until
they re-accept. `createStanddown()` also *throws* when `chrome.webNavigation.onCommitted`
is absent (an adapter that observes no navigations would fail open), so `webext`
without that permission is not an option regardless.

## Step 3 — Integrate

**Webext (MV3 background service worker):**

```ts
import { allPolicies } from 'standdown/policies';
import { createStanddown } from 'standdown/webext';

const standdown = createStanddown({
  policies: allPolicies,
  // Declare YOUR OWN attribution params so the library never stands you down
  // against your own clicks:
  selfPatterns: [{ name: 'my_click_id', networkId: 'cj' }],
  publisherSites: ['your-site.com'],
});
```

`createStanddown()` **requires** `chrome.webNavigation.onCommitted` and throws if
it's absent (an adapter that observes no navigations would fail open). Query the
decision from a content script or popup:

```ts
const { decision } = await chrome.runtime.sendMessage({
  type: 'standdown:shouldStandDown',
  tabId,
  url,
});
if (decision.standDown) return; // suppress your activation
```

The response is `{ ok: boolean, decision: Decision }` — read `decision.standDown`.

**Content (Safari / page-level):**

```ts
import { allPolicies } from 'standdown/policies';
import { createContentStanddown } from 'standdown/content';

const standdown = createContentStanddown({
  policies: allPolicies,
  storage: 'session', // or 'local-ttl' for a sliding 24h envelope
  publisherSites: ['your-site.com'],
});

const decision = await standdown.ready;
```

## Step 4 — Use the `Decision` correctly

The one rule: **when `standDown` is true, do not activate** (no redirect, no
cookie, no affiliate link rewrite).

Content and reduced-permission webext adapters can't see redirect chains, so a
`standDown: false` may carry `degraded: true` (a redirect-only attribution could
have been missed). How you treat `degraded` depends on your extension's profile:

**Redirect-plane tools, or any extension that must never activate without full
coverage** — treat `degraded` as suppression:

```ts
const suppress = decision.standDown || decision.degraded;
```

**Always-on content-adapter extensions** (Safari / content-script shopping
extensions that must activate on ordinary product pages) — gate on `standDown`
**alone**:

```ts
const suppress = decision.standDown;
```

The content plane **always** reports `degraded: true` on a non-stand-down
decision (it structurally can't observe redirect chains), so treating `degraded`
as suppression there means the extension never activates on a clean page — it
would be inert. Gating on `standDown` alone is still fully fail-closed: the
library returns `standDown: true` for every error, malformed-policy, and unknown
state regardless of coverage. Stand-down decisions are never `degraded` —
over-suppression is the safe direction.

## Step 5 — Build / bundle (extensions)

Chrome does **not** resolve npm package subpath imports (`standdown/webext`,
`standdown/content`) from service workers, content scripts, or popups. You
**must bundle** before loading unpacked. Two minimal, working references, each
with the exact `esbuild` bundle command:

- **webext adapter** → [`examples/mv3-extension`](./examples/mv3-extension)
  (background worker + popup).
- **content adapter** → [`examples/content-extension`](./examples/content-extension)
  (a content script that gates on `decision.standDown` alone).

Mirror whichever matches your adapter, then load the bundled output unpacked and
click through a partner flow to confirm you go quiet when attribution already
exists. Bundlers that resolve subpath imports themselves (WXT, Vite) handle this
for you — no manual `esbuild` step needed.

## Step 6 — Grade conformance

Prove the integration actually stands down. The graders are **not shipped in the
npm package** — they live in the standdown repo's `audit/` harness, so clone the
repo to run them. Two graders, used in order:

**1. `conformanceGrade` — the adopter grade (start here).** Deterministic and
browser-free: it drives the policy set your extension bundles through the real
decision engine over every network's attribution and positive-control scenarios
and scores F→A+. This is the number to report — it's fast, needs no browser, and
is the correct sensor for any real host extension. Pass `DISABLE_HOSTS` for any
merchants you disable unconditionally.

```sh
git clone https://github.com/dupe-com/standdown && cd standdown/audit && npm install
DISABLE_HOSTS="ebay.com,homedepot.com" npx tsx grade/conformance.ts
#   standdown conformance grade: A+  (100/100)
```

Target **A/A+**. The rubric has an **inert cap**: a policy set that never allows
activation on any positive control can't score above a C, so "disciplined
stand-down" can't be faked by suppressing everything.

**2. `grade/grade.ts` — the in-browser testext sensor (optional).** Loads an
unpacked extension into a real browser and detects activation by watching for a
redirect to `/aff/:net?actor=`, the protocol the bundled *testexts* speak. Real
host extensions activate by painting UI or opening a monetized tab, which that
sensor can't see — so a correctly integrated host extension routinely scores
**C (inert)** here. That means "wrong sensor for this extension," not "dead
code." To sense a real extension's own activation black-box, adapt the template
probe [`grade/host-extension-probe.ts`](./audit/docs/grading-your-own-extension.md)
to assert on your extension's surface.

Both CLIs print a shareable grade card — a terminal card plus an SVG you can
post — when the run passes.

## Gotchas

- **Bundle first** — subpath imports don't resolve in raw extension contexts (Step 5).
- **`webNavigation.onCommitted` is required** for the webext adapter; it throws otherwise.
- **Cookie matching is name-only** by design — rules match cookie *names*, never
  values (keeps user data out of signals). Porting a rule that matched a cookie
  *value* will silently not fire.
- **`allPolicies` is the verified set.** `experimentalPolicies` (skimlinks,
  partnerize) have inferred redirect domains — opt in only after verifying.
- **`amazon` is detect-only** (`activation.mode: never`) — the guard never allows
  activation on Amazon hosts unless you override the policy.

## Reference

- `README.md` — overview, how it works, the shareable grade card.
- `INSTALL.md` — manual install + full API (adapters, self-exemption, per-host
  disable, interop, signed refresh).
- `POLICIES.md` — network policy citations.
- `examples/mv3-extension` — working webext integration.
- `examples/content-extension` — working content-adapter integration.
- `audit/` — the conformance graders (`conformance.ts`, `grade.ts`).
