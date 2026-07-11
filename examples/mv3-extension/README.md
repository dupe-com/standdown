# standdown MV3 example

This directory is source for a minimal extension. Chrome does not resolve npm
package subpath imports from extension service workers or popups, so bundle the
example before loading it unpacked.

From the repo root:

```sh
npm install
npm run build
rm -rf /tmp/standdown-mv3-example
mkdir -p /tmp/standdown-mv3-example
npx esbuild examples/mv3-extension/background.js examples/mv3-extension/popup.js \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=chrome120 \
  --outdir=/tmp/standdown-mv3-example
cp examples/mv3-extension/manifest.json examples/mv3-extension/popup.html /tmp/standdown-mv3-example/
```

Then open `chrome://extensions`, enable Developer mode, and load
`/tmp/standdown-mv3-example` as an unpacked extension.

The popup starts in a stand-down state until the background worker returns a
decision. Its activate button calls `guardActivation()` with the click event so
the example exercises the same user-gesture gate an integration should use.
