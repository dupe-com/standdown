# standdown relay example

Uses `standdown/relay`, the adapter for extensions that can't hold
`webNavigation`/`webRequest` **and** run on shops that remove the referral param
from the address bar before the page finishes loading.

**Why it exists, in one line:** by the time an ordinary content script runs
(`document_idle`), a shop may already have turned `shop.example/?cjevent=abc` into
`shop.example/`, so the evidence is gone. The relay writes down which referral
param *names* were present at `document_start`, before the shop's scripts run,
and the background answers "should we stand down?" from that note.

| File | Runs | Job |
| --- | --- | --- |
| `relay-capture.js` | content script, `document_start` | note matched param names (never values or URLs) |
| `background.js` | service worker | keep a short per-tab note, decide via the normal engine |
| `offer.js` | content script, `document_idle` | ask the background, show a demo banner only when clear |

Permissions: `storage` plus the host access you already have. No
`webNavigation`, `webRequest`, `tabs` or `scripting`.

## Build and load

Chrome doesn't resolve npm subpath imports, and manifest content scripts are
classic scripts, so bundle first. From the repo root:

```sh
npm install
npm run build
OUT=/tmp/standdown-relay-example
rm -rf $OUT && mkdir -p $OUT
npx esbuild examples/relay-extension/relay-capture.js --bundle --format=iife --platform=browser --target=chrome120 --outfile=$OUT/relay-capture.js
npx esbuild examples/relay-extension/offer.js        --bundle --format=iife --platform=browser --target=chrome120 --outfile=$OUT/offer.js
npx esbuild examples/relay-extension/background.js   --bundle --format=esm  --platform=browser --target=chrome120 --outfile=$OUT/background.js
cp examples/relay-extension/manifest.json $OUT/
```

Open `chrome://extensions`, enable Developer mode, and load `$OUT` unpacked.
On a plain page you'll see a green "clear to offer" banner. Arrive with
`?cjevent=abc` and the banner stays hidden, even after the page strips the param.

Tip for clicking through by hand: once a shop has stood down, the engine
remembers that shop for the browsing session (that's intended). Use a fresh
profile, or a different shop, for each check.

## Automated browser check

`e2e/run.mjs` builds this example (swapping `offer.js` for a test probe), serves
local shop pages that strip the param, maps `*.example` to `127.0.0.1`, and runs
each scenario in real Chromium. It also runs the plain `content` adapter on the
same page so you can see the before/after.

```sh
npm run build
(cd audit && npm install && npx playwright install chromium)
node examples/relay-extension/e2e/run.mjs
```

CI runs the same three suites on every pull request that touches `src/` or this
example (`.github/workflows/relay-e2e.yml`), headless, with Playwright's own
Chromium.

Set `CHROMIUM_PATH` to reuse a Chromium you already have, `HEADED=1` to watch it,
or `EXTRA_CASES=path/to/cases.mjs` to add your own pages and scenarios. A step
can be `'RESTART'`, which closes and reopens the browser with the same profile.
`e2e/cases/session-floor.mjs` uses it to check CJ's "session, or at least 60
minutes" rule (shortened to 8 s) across real restarts:

```sh
EXTRA_CASES=examples/relay-extension/e2e/cases/session-floor.mjs node examples/relay-extension/e2e/run.mjs
```

`e2e/cases/self-click-lift.mjs` checks `selfClickLift`: your own CJ click ends a
competitor's earlier CJ stand-down, and nothing else (a later competitor click,
or another network, still stands down):

```sh
EXTRA_CASES=examples/relay-extension/e2e/cases/self-click-lift.mjs node examples/relay-extension/e2e/run.mjs
``` See
[`VERIFICATION.md`](./VERIFICATION.md) for the last recorded run.
