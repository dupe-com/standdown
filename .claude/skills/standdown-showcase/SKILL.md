---
name: standdown-showcase
description: Submit an extension to the standdown "Graded with standdown" showcase (wall of fame). Use after the user has integrated standdown and their extension grades A/A+ on the conformance grader, when they want to publish/share their grade card or "add my extension to the showcase". Generates the submission, regenerates the CI-authoritative card, and opens the PR.
---

# standdown-showcase: publish a verified grade card

Thin router. **[`showcase/README.md`](../../../showcase/README.md) in the standdown
repo is the source of truth** for how a submission is generated, verified, and
turned into a PR — follow its "Or by hand" mechanics and "Reach A+ (Tier 2)"
section exactly; don't reconstruct the commands from memory. (If the repo isn't
local, clone `https://github.com/dupe-com/standdown` first.)

The showcase is **CI-verified**: a submission declares only its policy inputs, and
CI re-runs the grader to reproduce the grade and regenerate the card — so only
genuinely passing runs (A-band, zero hijacks, non-inert) get in, and nothing can
be faked.

## What to do

1. **Precondition — it must already grade A/A+** on `conformanceGrade`. If it hasn't
   been graded, run the [`standdown`](../standdown/SKILL.md) skill / `AGENTS.md`
   Step 6 first. A sub-A grade is not eligible — stop and say what to fix.

2. **Derive the submission details** from the extension's standdown integration:
   extension name, `policySet` (`allPolicies` | `allPolicies+experimental` |
   `custom`; for custom, the resolved `policies` array), the hosts it disables, and
   — if published — its Chrome Web Store id. Ask the user only for their **GitHub
   handle** and **today's date** (`YYYY-MM-DD`; the tooling has no clock).

3. **Run the flow from `showcase/README.md`:** `showcase:submit` → `showcase:build`
   → `showcase:verify` (the exact check CI runs — must pass), then open a PR to
   `dupe-com/standdown` with the generated files.

4. **A+ (Tier 2), only if published:** run `showcase:live-verify` and include
   `showcase/verifications/<slug>.json` in the PR. Details in the "Reach A+"
   section. Before publishing, `CRX_FILE=<built .zip> …:live-verify` dry-runs it.

## Rules

- **Never hand-edit** the card SVG, `SHOWCASE.md`, `grade`, `inputsSha256`, or a
  verification record — they're all generated and CI regenerates + diffs them, so
  any hand-edit fails CI.
- **Tier is CI-determined** — never put a `tier`/`verification` field in the
  submission (CI rejects it). The badge caps at **A** for Tier 1; **A+** requires
  the live-verified crx.
- Submit only the user's **own** extension, and only a real passing grade — don't
  massage inputs to clear the bar. Keep the PR to the generated files.

## Related

- [`showcase/README.md`](../../../showcase/README.md) — the submission + Tier 2 playbook (source of truth).
- [`standdown`](../standdown/SKILL.md) / [`AGENTS.md`](../../../AGENTS.md) — integrate + grade first.
