---
name: standdown-showcase
description: Submit an extension to the standdown "Graded with standdown" showcase (wall of fame). Use after the user has integrated standdown and their extension grades A/A+ on the conformance grader, when they want to publish/share their grade card or "add my extension to the showcase". Generates the submission, regenerates the CI-authoritative card, and opens the PR.
---

# standdown-showcase: submit a verified grade card

Publish an extension's conformance grade to the [standdown](https://github.com/dupe-com/standdown)
showcase. The showcase is **CI-verified**: a submission declares only its policy
inputs, and CI re-runs the grader to reproduce the grade and regenerate the card —
so only genuinely passing runs (A-band, zero hijacks, non-inert) get in, and cards
can't be faked. Your job is to produce a correct submission and open the PR.

**Set expectations on the badge:** the showcase badge is tier-driven — a Tier 1
(config-verified) entry earns an **A** badge, even at a perfect 100/100
conformance score. **A+** requires Tier 2: CI downloads the live published crx
from the Chrome Web Store and confirms it bundles the graded config (matching
inputs SHA). If the extension is live and its `chromeWebStoreId` is known, offer
the Tier 2 flow (step 4 below) — otherwise the badge is **A**, with the A+ path
open once it's on prod. Tier is CI-determined — never put a `tier` field in the
submission (CI rejects it).

## Preconditions — confirm before starting

1. The extension already integrates standdown and **grades A or A+** on
   `conformanceGrade`. If they haven't graded yet, run the `standdown` skill (or
   `grade/conformance.ts`) first. A sub-A grade is not showcase-eligible — stop
   and tell them what to fix.
2. Collect: extension **name**, **URL** (store listing or homepage), the
   **policy set** they bundle (`allPolicies`, `allPolicies+experimental`, or
   `custom`), any **disableHosts**, their **GitHub handle**, and — if they have
   it — the **Chrome Web Store id** (required for Tier 2 / A+ live-source verify).
3. Ask the user for **today's date** (`YYYY-MM-DD`) — the tooling has no clock.

## Steps

1. **Get the harness.** If not already local, clone the repo and build the lib so
   the grader can import it:
   ```sh
   git clone https://github.com/dupe-com/standdown && cd standdown
   bun install && bun run build
   cd audit && npm install
   ```

2. **Generate the submission.** From `audit/`, run the submit tool. For a custom
   policy set, first write the user's policies to a JSON array file and pass
   `POLICIES_FILE`.
   ```sh
   SLUG=<kebab-slug> NAME="<name>" URL=<url> \
   SUBMITTED_BY=<handle> POLICY_SET=<allPolicies|allPolicies+experimental|custom> \
   DISABLE_HOSTS=<comma,hosts> DATE=<YYYY-MM-DD> \
   npm run showcase:submit
   ```
   This writes `showcase/submissions/<slug>.json` with the recomputed grade + SHA.
   If it warns the grade is below A-band, **stop** — the extension isn't eligible.

3. **Regenerate + self-verify.** Produce the CI-authoritative card and gallery,
   then run the exact check CI runs:
   ```sh
   npm run showcase:build
   npm run showcase:verify   # must pass
   ```

4. **(Optional) Reach A+ — Tier 2 live-verify.** Only if the extension is
   published and you have its `chromeWebStoreId`. This downloads the live crx and
   proves it bundles the graded config. It succeeds when either (a) the packaged
   extension emits a `standdown.manifest.json` (recommended — see
   `showcase/README.md` § "Reach A+"), or (b) the policy array ships as a
   recoverable JSON asset (bundle-scan fallback).
   ```sh
   SLUG=<kebab-slug> DATE=<YYYY-MM-DD> npm run showcase:live-verify
   npm run showcase:build     # re-renders the card as A+
   ```
   On success this writes `showcase/verifications/<slug>.json`. If it reports no
   match, the config isn't live/recoverable yet — stay Tier 1 (A) and tell the
   user how to reach A+ (add the manifest, publish, re-run). Never hand-write the
   verification record — the live-verify CI job re-derives the SHA from the crx.

5. **Open the PR.** Fork if needed, branch, and commit the generated artifacts:
   `showcase/submissions/<slug>.json`, `showcase/cards/<slug>.svg`, the updated
   `SHOWCASE.md`, and — if you did step 4 — `showcase/verifications/<slug>.json`.
   Open a PR to `dupe-com/standdown` titled `showcase: add <name> (<grade>)`. Note
   in the body that CI will re-verify.

## Rules

- **Never hand-edit** the card SVG, `SHOWCASE.md`, `grade`, or `inputsSha256` —
  they're generated, and CI regenerates + diffs them. Editing any of them fails CI.
- Submit only the user's **own** extension, and only a real passing grade — don't
  massage inputs to clear the bar.
- Keep the submission to the three generated files; don't sweep unrelated changes
  into the PR.
