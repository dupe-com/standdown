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

## Preconditions — confirm before starting

1. The extension already integrates standdown and **grades A or A+** on
   `conformanceGrade`. If they haven't graded yet, run the `standdown` skill (or
   `grade/conformance.ts`) first. A sub-A grade is not showcase-eligible — stop
   and tell them what to fix.
2. Collect: extension **name**, **URL** (store listing or homepage), the
   **policy set** they bundle (`allPolicies`, `allPolicies+experimental`, or
   `custom`), any **disableHosts**, their **GitHub handle**, and — if they have
   it — the **Chrome Web Store id** (records it for future live-source verify).
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

4. **Open the PR.** Fork if needed, branch, and commit exactly three artifacts:
   `showcase/submissions/<slug>.json`, `showcase/cards/<slug>.svg`, and the updated
   `SHOWCASE.md`. Open a PR to `dupe-com/standdown` titled
   `showcase: add <name> (<grade>)`. Note in the body that CI will re-verify.

## Rules

- **Never hand-edit** the card SVG, `SHOWCASE.md`, `grade`, or `inputsSha256` —
  they're generated, and CI regenerates + diffs them. Editing any of them fails CI.
- Submit only the user's **own** extension, and only a real passing grade — don't
  massage inputs to clear the bar.
- Keep the submission to the three generated files; don't sweep unrelated changes
  into the PR.
