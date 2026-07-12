# Grading approaches: black-box vs. self-grading

How do you put a letter grade on an extension's affiliate stand-down behavior?
There are two fundamentally different models. This note records what we learned
building both, and why the project favors the second.

## 1. Black-box grading (external)

Treat the extension as an opaque subject: load it, drive it against controlled
merchant pages, and watch what it does on the network. No source knowledge, no
cooperation from the extension.

The **sensor must be an externally observable affiliate action** — a redirect
through a known affiliate-network domain, or an affiliate cookie being set — not
the extension's private internal state. Internal storage keys are per-extension
and don't generalize; observable network actions do. The bundled affiliate
fingerprint (`fixtures/fingerprint.ts`, derived from every policy pack's redirect
domains and cookie names) is the generic classifier.

### Techniques that work (and are reusable for any extension testing)

- **Merchant-hostname spoofing.** Launch Chromium with
  `--host-resolver-rules="MAP www.example-retailer.com 127.0.0.1"` plus a
  self-signed cert whose SAN covers that host and `--ignore-certificate-errors`.
  The extension now believes it is on the real retailer while you serve a page you
  fully control, so its merchant-keyed logic engages. See `grade/observe.ts`.
- **Checkout background-tab sensor.** Coupon/cashback extensions are commonly
  dormant until checkout, where they open a *background tab* that navigates through
  their affiliate link to drop a last-click cookie. Capture it with Playwright's
  `context.on('page')` and classify where that tab navigates. This is a clean,
  generic hijack detector — no internal knowledge required. See
  `grade/checkout-probe.ts`.
- **Observable-action fingerprinting with a merchant-echo guard.** Only count an
  affiliate hit when the request leaves the merchant origin. A merchant page
  echoing its *own* seeded attribution param (e.g. a landing `?ranSiteID=` on the
  fixture URL) is not the extension redirecting — failing to exclude it produces
  false "hijack" readings.

### Why it does not scale

Building this far enough to run against a real, never-before-seen extension made
the limits concrete:

1. **Activation is the hard part.** Detection is easy; getting the extension to
   *act* is not. Modern affiliate extensions stay dormant until they see real
   product context (real retailer DOM / product IDs), an authenticated user, and/or
   an actual outbound buy-click. Passive page-load observation yields nothing.
2. **Auth is a per-user wall.** Activation is frequently gated behind sign-in, and
   sign-in is commonly OAuth (Google/Apple). That cannot be automated across a
   fleet, and an automated agent should never be entering someone's credentials.
3. **Per-merchant + environment friction.** Each extension supports a different set
   of retailers, and loading an unpacked build or inspecting `chrome://` pages is
   off-limits to in-browser automation. Auth established in one browser does not
   transfer to a separate grading browser.
4. **False accusations are a real hazard.** A grade like "F — hijacks attribution"
   about a *named* third party is a strong public claim. Every such grade must carry
   a reproducible network trace, and the harness must keep **INCONCLUSIVE strictly
   distinct from FAIL** — "did not activate in our sandbox" is not "hijacks."

The reference harnesses (`observe.ts`, `checkout-probe.ts`, `dogfood-probe.ts`) are
kept as demonstrations of the techniques above, useful for one-off testing. They are
not a scalable grading service.

## 2. Self-grading (conformance on install) — the direction

Instead of grading extensions from the outside, grade an extension that has
**adopted the standdown library**. Once the library is installed, activation, auth,
and merchant context are the host extension's concern — the parts that made
black-box grading intractable simply move out of scope. The library can then expose
a conformance / self-grade harness that verifies the extension's stand-down
*decisions* are correct against the shared fixture substrate, and reports a grade
the extension's own maintainers can run in CI.

This is the scalable path: no spoofing, no OAuth walls, no per-merchant coverage
problem, and no risk of misjudging a black box — the extension opts in and grades
its own conformance. (Design in progress.)

## Shared substrate

Both models reuse the same building blocks, so work here is not wasted:

- `fixtures/` — scenarios and the affiliate fingerprint derived from the policy packs.
- `grade/rubric.ts` — the F→A+ bands and the **inert cap** (an extension that never
  acts must not score A+ by passively "passing" stand-down — the guard that keeps
  dead code from grading well).
- MV3-headless operational gotchas (documented alongside the harnesses): use
  `--headless=new` (old headless can't load MV3 extensions), warm up the service
  worker before probing, isolate storage/cookies between scenarios (a stand-down can
  persist a per-merchant TTL), and put hard timeouts on every browser op — headless
  MV3 wedges after enough pages.
