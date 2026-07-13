# Showcase — “Graded with standdown”

A wall of fame for extensions that ran the [conformance grader](../audit) and
proved they stand down instead of hijacking existing affiliate attribution. The
gallery lives at [`SHOWCASE.md`](../SHOWCASE.md).

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

> **Scope of the guarantee.** This proves *your policy configuration decides
> correctly*. It does not by itself prove your *shipped* extension uses that
> configuration. Verifying against the live Chrome Web Store source is a planned
> second tier (provide `chromeWebStoreId` now to be ready for it).

Only genuinely passing runs are eligible: **A-band, zero hijacks, non-inert.**

## Add yours — one prompt

After you’ve integrated standdown and your extension grades A/A+, hand this to
your coding agent (Claude Code users: run `/standdown-showcase`):

```text
Add my extension to the standdown showcase. Clone https://github.com/dupe-com/standdown,
then in audit/ run the submit tool with my details:

  SLUG=<kebab-slug> NAME="<extension name>" URL=<url> \
  SUBMITTED_BY=<my github handle> POLICY_SET=<allPolicies|allPolicies+experimental|custom> \
  DISABLE_HOSTS=<comma,separated,hosts> DATE=<today YYYY-MM-DD> \
  npm run showcase:submit

If POLICY_SET=custom, also pass POLICIES_FILE=<path to a JSON array of my policies>.
Then run `npm run showcase:build`, and open a PR to dupe-com/standdown adding
showcase/submissions/<slug>.json plus the generated card and SHOWCASE.md.
CI will re-verify the grade from scratch.
```

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

## Submission schema (`showcase/submissions/<slug>.json`)

| Field | Required | Notes |
| --- | --- | --- |
| `schemaVersion` | ✓ | `1` |
| `slug` | ✓ | kebab-case; must equal the filename stem |
| `extension.name` | ✓ | display name |
| `extension.url` | | homepage / store listing |
| `extension.chromeWebStoreId` | | enables future live-source verification |
| `submittedBy` | ✓ | your GitHub handle or name |
| `policySet` | ✓ | `allPolicies` \| `allPolicies+experimental` \| `custom` |
| `policies` | if custom | inline array of your `StanddownPolicy` objects (validated) |
| `disableHosts` | | hosts you disable unconditionally |
| `grade` | ✓ | `{ letter, score }` — recomputed and enforced by CI |
| `inputsSha256` | ✓ | sha256 of the resolved inputs — recomputed by CI |
| `generatedWith` | ✓ | e.g. `standdown` |
| `date` | ✓ | `YYYY-MM-DD` |

The `submit` tool fills `grade` and `inputsSha256` for you — don’t set them by hand.
