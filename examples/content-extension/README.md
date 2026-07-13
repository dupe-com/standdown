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
the URL (e.g. `?cjevent=abc123` → the example stands down and shows nothing). SPA
navigations re-evaluate automatically via the adapter's history hooks, so the
banner appears and disappears as attribution comes and goes without a reload.
