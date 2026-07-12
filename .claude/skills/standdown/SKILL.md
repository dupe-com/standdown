---
name: standdown
description: Integrate the `standdown` affiliate stand-down library into a browser extension and grade its conformance F→A+. Use when the user wants their extension to stop hijacking existing affiliate attribution (stand down when a partner already owns the sale), when they ask to "add standdown" / "install standdown", or when they want to grade/verify an extension's stand-down behavior.
---

# standdown: install → integrate → verify → grade

Drive the full loop of adopting the [`standdown`](https://www.npmjs.com/package/standdown)
library in a browser extension, then prove it works with the conformance grader.
`standdown` is **advisory**: it returns a `Decision`; your code performs (or
suppresses) the side effect. Never break these invariants while integrating:
decisions stay local and synchronous (no network in the decision path), signals
exclude user identity, and everything fails toward standing down.

Work through the phases in order. Confirm the context with the user before
editing; report what changed at the end.

## Phase 0 — Understand the target

Inspect the extension you're integrating into and determine:

- **Manifest version + browser.** Chromium MV3 vs Safari/other.
- **Does it have `webRequest` + `webNavigation` permissions?** Check `manifest.json`.
- **Where affiliate activation happens today** — the code that redirects, rewrites
  links, or drops cookies (grep for `webRequest`, `redirect`, affiliate params like
  `cjevent`/`ranSiteID`, cookie writes). That is what must be gated behind a
  stand-down check.

State which adapter applies (Phase 2) before writing code.

## Phase 1 — Install

```sh
npm install standdown
```

Zero runtime deps; ESM + CJS; Node ≥18. No `@types/chrome` needed (the library
models the `chrome.*` surface itself).

## Phase 2 — Pick the adapter

| Context | Import specifier | Factory |
| --- | --- | --- |
| Chromium MV3 with `webRequest`/`webNavigation` | `standdown/webext` | `createStanddown()` |
| Safari / reduced-permission / content-script only | `standdown/content` | `createContentStanddown()` |
| Non-extension / custom host | `standdown` | `new StanddownSession()` + `guardActivation()` |

Use import specifiers exactly as written — never deep `dist/` paths.

## Phase 3 — Integrate

**Webext** — in the background service worker:

```ts
import { allPolicies } from 'standdown/policies';
import { createStanddown } from 'standdown/webext';

const standdown = createStanddown({
  policies: allPolicies,
  selfPatterns: [{ name: 'YOUR_click_id_param', networkId: 'cj' }], // your own attribution
  publisherSites: ['your-site.com'],
});
```

`createStanddown()` **throws if `chrome.webNavigation.onCommitted` is absent** —
ensure the permission is present. It auto-registers a message handler. Gate your
activation from the content script / popup:

```ts
const { decision } = await chrome.runtime.sendMessage({
  type: 'standdown:shouldStandDown',
  tabId,
  url,
});
if (decision.standDown) return; // do NOT activate: no redirect, cookie, or rewrite
```

**Content** (Safari / page-level):

```ts
import { allPolicies } from 'standdown/policies';
import { createContentStanddown } from 'standdown/content';

const standdown = createContentStanddown({
  policies: allPolicies,
  storage: 'session', // or 'local-ttl' (sliding 24h)
  publisherSites: ['your-site.com'],
});

const decision = await standdown.ready;
const suppress = decision.standDown || decision.degraded; // content is partial-coverage → fail closed
if (suppress) return;
```

**Wire it into the real activation site** found in Phase 0: every path that fires
affiliate attribution must first check the decision and bail when standing down.

## Phase 4 — Build / bundle

Chrome does not resolve npm subpath imports (`standdown/webext`) from service
workers or popups — **you must bundle**. Follow the exact esbuild recipe in
`examples/mv3-extension/README.md` (bundle each entry `--format=esm
--platform=browser`), adapted to the extension's own build. Then produce the
unpacked output the grader will load.

## Phase 5 — Grade conformance

The grader is **not in the npm package** — it lives in the standdown repo's
`audit/` harness. Clone the repo if needed and run it against the built,
**unpacked** extension:

```sh
git clone https://github.com/dupe-com/standdown   # if not already available
cd standdown/audit && npm install
npx tsx grade/grade.ts /path/to/the/unpacked-extension
```

Read the letter grade (F→A+):

- **A / A+** — respects existing attribution on every network *and* activates on
  the positive controls. This is the target.
- **C (inert)** — the inert cap fired: the extension never activated even when
  allowed, so stand-down can't be distinguished from dead code. Your integration
  is over-suppressing or the extension isn't actually doing anything on the
  controls — check that activation still fires when there's no prior attribution.
- **F** — it hijacked scenarios where attribution already existed. The
  stand-down check isn't gating the real activation path; go back to Phase 3.

If the run is inconclusive (the extension never triggers in the harness), note
that — it is not the same as a fail.

## Phase 6 — Report

Summarize: adapter chosen, files changed (with the activation site now gated),
build command, and the grade with its one-line rationale. If below A, name the
specific scenario that failed and the fix.

## Reference

- `AGENTS.md` — the condensed integrator playbook (mirror of these phases).
- `README.md` — full API: `selfPatterns` self-exemption scope, per-host disable
  (`detection.disableHosts`), degraded decisions, signed policy refresh, interop.
- `POLICIES.md` — bundled network packs and citations. `allPolicies` is the
  verified set (cj, impact, rakuten, awin, shareasale, ebay-epn, amazon,
  universal); `experimentalPolicies` (skimlinks, partnerize) are opt-in.
- `examples/mv3-extension` — a working MV3 integration + the bundle recipe.
