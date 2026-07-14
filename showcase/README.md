# Showcase — “Graded with standdown”

A wall of fame for extensions that ran the [conformance grader](../audit) and
proved they stand down instead of hijacking existing affiliate attribution. The
gallery lives at [`SHOWCASE.md`](../SHOWCASE.md).

## Badges — A vs A+

The badge letter reflects the **verification tier**, not just the raw score:

| Badge | Tier | What CI proved |
| --- | --- | --- |
| **A** | Tier 1 — config-verified | CI re-ran `conformanceGrade` on your declared policy inputs and reproduced the grade. |
| **A+** | Tier 2 — live-verified | CI additionally downloaded your **published** crx from the Chrome Web Store and confirmed it bundles this exact policy set (matching inputs SHA). See [Reach A+ (Tier 2)](#reach-a-tier-2). |

The top mark is earned by proving your *deployed* extension uses the graded
config, so **Tier 1 caps at A**. Your true conformance score (e.g. `100/100`) is
still shown alongside the badge — a perfect config with an A badge just means
"prove it on prod for the A+." Tier is **CI-determined**; a submission cannot
claim it.

## How verification works (why the grades here are trustworthy)

standdown runs entirely client-side, so a grade card generated on your machine is
self-reported — anyone could hand-edit an SVG to say “A+”. The showcase doesn’t
trust the number. Instead:

- A submission is a **pure declaration of inputs** — your `policySet` (+ any
  `disableHosts`) — plus the claimed grade and a SHA over the resolved inputs.
- On your PR, [`showcase-verify.yml`](../.github/workflows/showcase-verify.yml)
  **re-runs `conformanceGrade` on those inputs**, recomputes the SHA, and
  **regenerates the card and `SHOWCASE.md`**. If your claimed grade doesn’t match
  the recomputation, or the committed card was hand-edited, CI fails.

Because the grader and the card are deterministic, the card is always
CI-authoritative. You control only the inputs; the grade follows from them.

> **Scope of the A (Tier 1) guarantee.** This proves *your policy configuration
> decides correctly*. It does not by itself prove your *shipped* extension uses
> that configuration — that's what **Tier 2 / A+** adds, by fetching the
> published crx and re-deriving the SHA from it ([below](#reach-a-tier-2)).

Only genuinely passing runs are eligible: **A-band, zero hijacks, non-inert.**

## What gets published (and what doesn't)

A submission is a **public PR to this repo**. Before you open one, here's exactly
what it discloses — and what it never touches.

**Published** (in `showcase/submissions/<slug>.json`, all reproducible by CI):

- Your extension's **name**, **URL**, and **Chrome Web Store id** — all already
  public on your store listing.
- Your GitHub handle (`submittedBy`), the grade, the inputs SHA, and the date.
- Your **`policySet`** — and, *only if it is `custom`*, the resolved `policies`
  array and the `disableHosts` you ship.

**Never sent, by construction:**

- ❌ **`selfPatterns` / self-click identifiers** — the submit tool serializes only
  `policies` + `disableHosts`; your own attribution ids never leave your machine.
- ❌ Credentials, API keys, or tokens.
- ❌ User data, traffic, revenue, or any telemetry.
- ❌ Your source or your build. Tier 2 reads the crx you **already published** to
  the Web Store — CI fetches that public artifact; you upload nothing.

So the only substantive disclosure is your **policy configuration** — which
affiliate networks you honor and which merchants you stand down on. That is
inherent to a verify-by-reproduction showcase: CI can only reproduce a grade from
inputs it can see. Two things to know before you decide:

- **Don't want to reveal a custom list?** Submit with `policySet: allPolicies`
  (or `allPolicies+experimental`). That discloses only "we ship the standard
  verified set" — no custom array — and still earns an **A**.
- **This repo is public and Dupe-owned.** A `custom` submission puts a
  machine-readable map of your affiliate policy in a competitor-adjacent public
  repo. That's a deliberate trade for a verified badge — make it with eyes open,
  or stick to `allPolicies`, or just use the local SVG grade card, which makes no
  public claim at all.

## Add yours — one prompt

Graded A/A+? Hand this to the same coding agent that did your integration, pointed
at your extension's repo (Claude Code: run `/standdown:showcase`):

```text
Publish this extension's standdown grade to the "Graded with standdown" showcase.
It already grades A or A+ on the conformance grader. Clone
https://github.com/dupe-com/standdown and follow its showcase/README.md end to
end: derive my submission details from this extension's standdown integration —
extension name, policy set, the hosts I disable, and (if it's published) my Chrome
Web Store id — then generate the submission with the submit tool, build the
CI-authoritative card, and open a PR to dupe-com/standdown. Ask me only for my
GitHub handle and today's date. Before opening the PR, tell me exactly what the
submission will disclose (for a custom policy set: my resolved policies + disabled
hosts, in a public Dupe-owned repo) and what it will not (no self-click ids, keys,
user data, or source), and ask whether to proceed, submit as allPolicies to
disclose less, or stop — do not publish without my explicit yes. If my extension
is published, also run the Tier 2 live-verify for an A+. Never hand-edit the
generated grade, SHA, card, or SHOWCASE.md — CI re-checks all of it, so a
hand-edit just fails the build.
```

That single prompt runs the whole flow — submit, build, verify, and open the PR
(plus Tier 2 live-verify when your extension is published). Expect one manual
step at the end: pushing the branch and opening the PR are outward actions on a
repo the agent doesn't own, so most coding agents (Claude Code included) will
pause and hand you the exact `git push` / PR-create command to run yourself —
that's the intended confirmation, not a failure. Everything up to that point
(grade, card, submission file) is generated for you. The mechanics it follows
are right below, if you'd rather run them yourself.

## Or by hand

```sh
git clone https://github.com/dupe-com/standdown && cd standdown/audit && npm install
# from the repo root, build the lib once so the grader can import it:
( cd .. && bun install && bun run build )

SLUG=acme-saver NAME="Acme Saver" URL=https://acme.example \
SUBMITTED_BY=octocat POLICY_SET=allPolicies DISABLE_HOSTS=ebay.com DATE=2026-07-13 \
npm run showcase:submit

npm run showcase:build      # regenerates the card + SHOWCASE.md
npm run showcase:verify     # the same check CI runs — must pass before you PR
```

Then open a PR adding `showcase/submissions/<slug>.json`, `showcase/cards/<slug>.svg`,
and the updated `SHOWCASE.md`.

## Reach A+ (Tier 2)

Tier 1 proves your *config* is right. **Tier 2 proves your _published_ extension
actually ships it** — CI downloads your live crx straight from the Chrome Web
Store (no API key) and re-derives the inputs SHA from it. A+ is granted only when
that SHA equals your submission's. Prerequisite: `extension.chromeWebStoreId` set,
and the graded config live on prod.

> **Brownfield adopters:** "live on prod" means *after* your cutover ships. If you
> migrated onto standdown via [`ADOPTING.md`](../ADOPTING.md), the library runs
> off-by-default until you flip the cutover flag and publish a Web Store build that
> bundles this config. Until then a `live-verify` correctly fails the SHA match —
> submit at Tier 1 (A) now and upgrade to A+ here once the cutover is live (see
> [Phase 6](../ADOPTING.md#phase-6--showcase-your-grade-optional)).

There are two ways CI can recover your shipped policy set from the crx:

**1. The `standdown.manifest.json` convention (recommended).** Have your build
write a tiny JSON file into your packaged extension declaring the *resolved*
policy set it ships:

```jsonc
// standdown.manifest.json — emitted at build time, next to your bundle
{
  "schemaVersion": 1,
  "policySet": "custom",           // or "allPolicies" / "allPolicies+experimental"
  "policies": [ /* the resolved StanddownPolicy[] you pass to the client */ ],
  "disableHosts": ["ebay.com"],    // whatever you disable unconditionally
  "standdownVersion": "0.2.6"
}
```

CI hashes the `policies` + `disableHosts` from *this file* (never a label), so it
can't be gamed by a version skew. One line in your build step:

```ts
import { writeFileSync } from 'node:fs';
writeFileSync('dist/standdown.manifest.json', JSON.stringify({
  schemaVersion: 1, policySet: 'custom', policies, disableHosts, standdownVersion: '0.2.6',
}, null, 2));
```

**2. Bundle-scan fallback (zero effort, best-effort).** If you ship your policy
array as a JSON asset (e.g. `dist/policies.json`), CI can often recover it by
scanning the crx directly — no manifest needed. Heavily minified/inlined bundles
won't be recoverable this way; add the manifest to guarantee Tier 2.

Then run the live check locally and commit the record it writes:

```sh
SLUG=<your-slug> DATE=2026-07-13 npm run showcase:live-verify
npm run showcase:build        # re-renders the card as A+
```

This fetches your live crx, confirms the match, and writes
`showcase/verifications/<slug>.json`. Add that file (plus the regenerated card +
`SHOWCASE.md`) to your PR.

> **Before you publish — dry-run against your local build.** Point the verifier
> at your built `.crx`/`.zip` to confirm it *will* verify once live, without
> touching the Web Store:
>
> ```sh
> SLUG=<your-slug> CRX_FILE=path/to/your-extension.zip DATE=2026-07-13 npm run showcase:live-verify
> ```
>
> This prints whether the bundle would reach A+ and writes **no** record — so an
> unpublished build can't be passed off as live-verified. Use it to catch a
> missing/mismatched manifest *before* shipping. The [`showcase-live-verify`](../.github/workflows/showcase-live-verify.yml)
job re-downloads the crx and re-derives the SHA on the PR, so a hand-written
record can't unlock A+ — the live extension has to genuinely bundle the config.
(A weekly cron re-checks merged records, so if you later ship a divergent version
the A+ is revisited.)

## Submission schema (`showcase/submissions/<slug>.json`)

| Field | Required | Notes |
| --- | --- | --- |
| `schemaVersion` | ✓ | `1` |
| `slug` | ✓ | kebab-case; must equal the filename stem |
| `extension.name` | ✓ | display name |
| `extension.url` | | homepage / store listing |
| `extension.chromeWebStoreId` | | required for Tier 2 / A+ live-source verification |
| `submittedBy` | ✓ | your GitHub handle or name |
| `policySet` | ✓ | `allPolicies` \| `allPolicies+experimental` \| `custom` |
| `policies` | if custom | inline array of your `StanddownPolicy` objects (validated) |
| `disableHosts` | | hosts you disable unconditionally |
| `grade` | ✓ | `{ letter, score }` — recomputed and enforced by CI |
| `inputsSha256` | ✓ | sha256 of the resolved inputs — recomputed by CI |
| `generatedWith` | ✓ | e.g. `standdown` |
| `date` | ✓ | `YYYY-MM-DD` |

The `submit` tool fills `grade` and `inputsSha256` for you — don’t set them by hand.
