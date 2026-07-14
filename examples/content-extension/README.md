# standdown content-script example

Uses `standdown/content` — the adapter for Safari and any MV3 extension that
**cannot** hold `webNavigation`/`webRequest` (see [Choosing an
adapter](../../README.md#choosing-an-adapter)). The decision is computed in a
content script from local page signals only (`location.href`,
`document.referrer`, first-party cookie names); no `chrome.*` network APIs and no
elevated permissions are required. This manifest deliberately requests **no**
`webNavigation`/`webRequest` — that's the whole reason to reach for `content`
instead of [`webext`](../mv3-extension).

Chrome does not resolve npm package subpath imports in a raw content script, and
manifest-declared content scripts are classic scripts (not ES modules), so bundle
to an IIFE first. From the repo root:

```sh
npm install
npm run build
rm -rf /tmp/standdown-content-example
mkdir -p /tmp/standdown-content-example
npx esbuild examples/content-extension/content.js \
  --bundle \
  --format=iife \
  --platform=browser \
  --target=chrome120 \
  --outfile=/tmp/standdown-content-example/content.js
cp examples/content-extension/manifest.json /tmp/standdown-content-example/
```

Then open `chrome://extensions`, enable Developer mode, and load
`/tmp/standdown-content-example` unpacked.

To see both states: visit a plain merchant page (no attribution → a green "clear
to offer" banner) versus the same page carrying prior affiliate attribution in
the URL (e.g. `?cjevent=abc123` → the example stands down and shows nothing).

### Re-evaluating on SPA navigations

The adapter patches `history.pushState`/`replaceState` and listens for
`popstate`, but there is a catch worth understanding before you rely on it.

A content script runs in an **isolated world**. Patching `history.pushState`
there only intercepts `pushState` calls made *from the isolated world*. When the
page's own single-page-app code changes the route, it calls `history.pushState`
in the **main world**, which the isolated-world patch never sees. Only `popstate`
(a DOM event dispatched on `window`) reliably reaches both worlds.

So on a real SPA merchant site, the adapter's history hooks alone will miss most
client-side route changes. Drive re-evaluation yourself by calling the
controller's `evaluate()` from whatever navigation signal you already have — a
`MutationObserver` on the app root, a framework router hook, or (as a last
resort) a URL poll. `content.js` in this example shows the URL-poll version.
`evaluate()` recomputes from the current page signals and fires `onDecision`, so
the banner appears and disappears as attribution comes and goes without a reload.
