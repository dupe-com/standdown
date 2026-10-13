# Relay verification: local browser run

**In short:** we loaded the relay example into a real Chromium and visited fake
shop pages that remove `?cjevent=abc` from the address bar as they load. The
existing `content` adapter said "not referred" every time. The relay correctly
said "stand down" every time, and stayed quiet on visits nobody referred. All 9
checks passed.

- **Date:** 2026-10-13
- **Build:** the `standdown/relay` branch on top of v0.3.3, built with `npm run build`
- **Browser:** Chromium (Chrome for Testing) via Playwright, headless
- **How to repeat:** `node examples/relay-extension/e2e/run.mjs` (see [README](./README.md))

## Results

| Scenario | `content` at idle | `relay` | Expected | |
| --- | --- | --- | --- | --- |
| Page strips `?cjevent=abc` with `replaceState` before load | not referred | stand down (`matchKind: 'landing'`) | stand down | ✅ |
| Page strips `?cjevent=abc` with `pushState` just after load | not referred | stand down | stand down | ✅ |
| `?utm_source=cj` stripped (CJ only when the value is `cj`) | not referred | stand down | stand down | ✅ |
| `?utm_source=google` stripped | not referred | not referred | not referred | ✅ |
| `link.shop.example?cjevent=abc` → script → `www.shop.example` | not referred | stand down | stand down | ✅ |
| Plain visit, no referral | not referred | not referred | not referred | ✅ |
| `?cjevent=abc` on an unrelated site, then the shop in the same tab | not referred | not referred | not referred | ✅ |
| Reload after the param was stripped | not referred | stand down | stand down | ✅ |
| Closed tabs leave no landing records behind | | 0 left | 0 | ✅ |

## What this run does not cover

- **Return visits on a later day.** The relay remembers a landing for one tab
  (up to 30 minutes) and the engine remembers a stand-down for the browsing
  session. Neither reaches a visit after the browser restarts. The relay does not
  read cookies. CJ's first-party `cje` cookie is not a good substitute: CJ's
  [server-side cookie spec](https://docs.cj.com/docs/http-cookie) sets it for
  13 months from the last update, kept on visits without a new click, and the
  library matches cookie names only, so its presence can't tell a click from
  yesterday from one a year ago.
- **Server-side redirect hops** and `#` fragment params (documented limits).
- **Real shop sites and Safari.** These pages are local stand-ins built to
  reproduce the stripping patterns.
- **A real CJ click.** The `cjevent` value is a placeholder; the run checks
  detection, not network-side attribution.

## Later additions (same date, same setup)

**In short:** two more behaviours were checked in the same real browser. CJ's
"session, or at least 60 minutes" rule now survives a browser restart counted
from the latest referral, and the opt-in `selfClickLift` lets the host's own
CJ click end a competitor's earlier CJ stand-down without ever touching another
network's. Each case was also run with the change undone, and the cases that
depend on it failed, so they test what they claim.

### Minimum after a browser restart (`e2e/cases/session-floor.mjs`, floor shortened to 8 s)

| Scenario | Result | With the fix undone |
| --- | --- | --- |
| Referral, restart right away | stands down ✅ | stands down |
| Referral, restart after the floor | clear ✅ | clear |
| Second referral re-arms the floor, restart | stands down ✅ | **clear (fails)** |

### Own-click lift (`e2e/cases/self-click-lift.mjs`, `selfClickLift: 'same-network'`)

| Scenario | Result | With the option off |
| --- | --- | --- |
| Competitor's CJ click, then our CJ click (both stripped) | clear, `self-click-lifted` ✅ | **stands down (fails)** |
| …and the next page of the visit | clear ✅ | **stands down (fails)** |
| Our CJ click, then a competitor's CJ click | stands down ✅ | stands down |
| Competitor's Impact click, then our CJ click | stands down ✅ | stands down |
| Our own click alone | clear ✅ | clear |

The base relay scenarios pass unchanged under both configs (12/12 and 14/14 in
total including base cases and the tab-cleanup check).

