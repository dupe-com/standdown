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

| Your context | Import | Entry |
| --- | --- | --- |
| Chromium **MV3** extension with `webRequest`/`webNavigation` | `standdown/webext` | `createStanddown()` |
| Safari / reduced-permission / page or content-script only | `standdown/content` | `createContentStanddown()` |
| Non-extension or custom host | `standdown` | `StanddownSession` + `guardActivation` |

Most Chrome extensions use **webext** in the background service worker and query
it from content scripts/popup. Safari builds use **content**.

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
have been missed). To fail fully closed:

```ts
const suppress = decision.standDown || decision.degraded;
```

Stand-down decisions are never degraded — over-suppression is the safe direction.

## Step 5 — Build / bundle (extensions)

Chrome does **not** resolve npm package subpath imports (`standdown/webext`) from
service workers or popups. You **must bundle** before loading unpacked. See
[`examples/mv3-extension`](./examples/mv3-extension) for a minimal, working MV3
background + popup and the exact `esbuild` bundle command. Mirror that build for
your extension, then load the bundled output unpacked and click through a
partner flow to confirm you go quiet when attribution already exists.

## Step 6 — Grade conformance

Prove the integrated extension actually stands down in a real browser (not just
that unit tests pass). The grader is **not shipped in the npm package** — it
lives in the standdown repo's `audit/` harness, so clone the repo to run it:

```sh
git clone https://github.com/dupe-com/standdown && cd standdown/audit && npm install
npx tsx grade/grade.ts /path/to/your/unpacked-extension
#   standdown grade: A+  (100/100)
```

The rubric is F→A+ with an **inert cap**: an extension that never activates even
when allowed can't score above a C (so "disciplined stand-down" can't be faked
with dead code). Target **A/A+** with real activation on the positive controls.

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

- `README.md` — full API, self-exemption scope, per-host disable, interop.
- `POLICIES.md` — network policy citations.
- `examples/mv3-extension` — working MV3 integration.
- `audit/` — the conformance grader.
