# Grading the Dupe extension (Phase 0 baseline conformance)

This is the operator's guide for `grade/dupe-extension-probe.ts` — the black-box
probe that grades Dupe's **real** browser extension against its Phase-0 baseline:
the behavioral spec we must preserve before the `standdown` library is introduced
as a shadow observer.

The probe is strictly black-box. It never reads Dupe-internal storage keys and
contains **no hardcoded build path** — you supply the extension build directory
yourself. It judges only what a user could see:

1. the extension painting its own UI into a merchant page (its wxt shadow hosts
   `dupe-onpage` / `dupe-price-element`, with real rendered content — which the
   extension's `standDown` decision gates), and
2. any outbound affiliate-network action (redirect / cookie), classified with the
   shared policy-pack fingerprint in `fixtures/fingerprint.ts`.

## What it checks

Each scenario is spoofed to a real retailer host (via Chromium
`--host-resolver-rules`) so the extension's merchant-keyed logic engages against
a page we control. The baseline spec encoded in the probe:

| Scenario | Host | Expectation |
| --- | --- | --- |
| Rakuten `ranSiteID`+`ranEAID` param | nordstrom | **stand down** (partner owns it) |
| CJ `cjevent` param | nordstrom | **stand down** |
| Impact `irgwc` param | nordstrom | **stand down** |
| Rakuten `lsclick_mid` cookie present | nordstrom | **stand down** |
| eBay | ebay.com | **stand down** (unconditional disable_domain) |
| Home Depot | homedepot.com | **stand down** (unconditional disable_domain) |
| AliExpress | aliexpress.com | **stand down** (unconditional disable_domain) |
| SHEIN | shein.com | **stand down** (unconditional disable_domain) |
| Clean merchant, no attribution | nordstrom | **activate** (allowed to earn) |
| Amazon | amazon.com | **activate** (`ALLOW_AMAZON=true`) |
| Wayfair | wayfair.com | **activate** (filtered out of client policy) |
| Self-click `cp=…_Dupe.com` over a CJ param | nordstrom | **activate** (ignore_param clears the match) |

The result is scored with the shared rubric (`grade/rubric.ts`): an F→A+ letter,
plus the **inert cap** — see "Reading the result" below.

## 1. Build the Dupe extension

The extension is a [wxt](https://wxt.dev) project. From the extension package
(`apps/extension` in the dupe-com repo):

```bash
cd /path/to/dupe-com/apps/extension

# Node 20.11.1 is pinned in .nvmrc
nvm use            # or: fnm use

# install deps (uses bun; this repo's lockfile is bun.lockb)
bun install

# build the Chrome MV3 extension
bun run build-ext        # alias for `wxt build`  (also: `bun run build`)
```

The unpacked build lands here:

```
apps/extension/.output/chrome-mv3
```

That directory (the one containing `manifest.json`) is what you pass to the
probe. Other targets: `bun run build-ext:firefox` → `.output/firefox-mv2`,
`bun run build-ext:safari` → `.output/safari-mv2-prod`. The probe loads MV3 into
headless Chromium, so use `chrome-mv3`.

## 2. Set up the audit harness (once)

From the standdown repo's `audit/` directory:

```bash
cd /path/to/standdown/audit
npm install
npx playwright install chromium
```

## 3. Grade it

Point the probe at your build output. The path comes from `EXT_PATH` (env) or the
first CLI arg — nothing is hardcoded:

```bash
# from standdown/audit
EXT_PATH="/path/to/dupe-com/apps/extension/.output/chrome-mv3" \
  npx tsx grade/dupe-extension-probe.ts

# equivalently, as a positional arg:
npx tsx grade/dupe-extension-probe.ts /path/to/dupe-com/apps/extension/.output/chrome-mv3
```

Useful env vars:

- `VERBOSE=1` — per-scenario activation lines as they run.
- `SETTLE_MS=9000` — increase the settle time if the extension is slow to load
  its policy / render (default 6000).

Example shape of the output:

```
  standdown — Dupe extension baseline conformance probe
  extension: /…/.output/chrome-mv3
  service worker: registered
  spoofed merchant hosts: www.nordstrom.com, www.ebay.com, …
  sensor: rendered Dupe UI in merchant DOM + affiliate-network redirect/cookie

  [ok  ] rakuten:attribution:landing-param    no observable activation
  [ok  ] cj:attribution:landing-param         no observable activation
  [HIJACK] impact:attribution:landing-param   activated: ui[dupe-onpage(3)]
  …
  [ok  ] control:clean-merchant               activated: ui[dupe-price-element(5)]

  standdown grade: B  (83/100)
  Hijacked 1/8 scenarios where attribution already existed.
```

## Reading the result

- **`[ok]` / `[HIJACK]` / `[MISS]`** — `HIJACK` = activated where a partner
  already owned the sale (a regression against baseline). `MISS` = failed to
  activate on a positive control.
- **Inert / INCONCLUSIVE.** If the extension never activates on **any** positive
  control (its service worker didn't register, its policy never loaded, or the
  product/auth context isn't satisfied in the sandbox), the rubric caps the grade
  and the probe prints an explicit `INCONCLUSIVE, not FAIL` banner. Read that as
  "could not exercise the extension here" — **not** "it passes" and **not** "it
  hijacks." Fix service-worker/policy load and re-run before trusting a grade.
- A trustworthy grade requires the positive controls to light up green
  (`activated: ui[…]`) — that's the evidence the sensor actually engaged.

## Why these techniques (and their limits)

Merchant-hostname spoofing + the affiliate fingerprint are the same building
blocks used by `grade/observe.ts` and `grade/checkout-probe.ts`; see
`docs/grading-approaches.md` for the full rationale and the known limits of
black-box grading (activation is the hard part; auth walls; keeping
INCONCLUSIVE strictly distinct from FAIL). The self-grading / conformance path in
that doc is the scalable successor once the extension adopts the library.
