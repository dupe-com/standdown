---
description: Publish this extension's standdown grade to the "Graded with standdown" showcase (A/A+ wall of fame).
---

Publish this extension's standdown grade to the "Graded with standdown" showcase.
It must already grade **A or A+** on `conformanceGrade` (if it hasn't been graded,
run `/standdown:setup` first).

Follow `${CLAUDE_PLUGIN_ROOT}/showcase/README.md` — or, if unavailable,
https://github.com/dupe-com/standdown/blob/main/showcase/README.md. Derive the
submission details from this extension's standdown integration (name, policy set,
disabled hosts, and — if published — its Chrome Web Store id), generate the
submission with the submit tool, build the CI-authoritative card, and open a PR to
`dupe-com/standdown`. Ask me only for my GitHub handle and today's date.

Before opening the PR, tell me exactly what the submission will disclose — for a
`custom` policy set that's my resolved policies + disabled hosts, published to a
public Dupe-owned repo — and what it will **not** send (no self-click ids, keys,
user data, or source). Then ask whether to **proceed**, **submit as `allPolicies`
to disclose less**, or **stop**; don't publish without my explicit yes.

If my extension is published, also run the Tier 2 live-verify for an A+. Never
hand-edit the generated grade, SHA, card, or `SHOWCASE.md` — CI re-checks all of
it, so a hand-edit just fails the build.
