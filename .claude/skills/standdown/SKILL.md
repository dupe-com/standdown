---
name: standdown
description: Integrate the `standdown` affiliate stand-down library into a browser extension and grade its conformance F→A+. Use when the user wants their extension to stop hijacking existing affiliate attribution (stand down when a partner already owns the sale), when they ask to "add standdown" / "install standdown", or when they want to grade/verify an extension's stand-down behavior.
---

# standdown: install → integrate → grade

Thin router. **[`AGENTS.md`](../../../AGENTS.md) at the repo root is the source of
truth** for the greenfield integration loop — install, pick the adapter, gate every
attribution firing point on `decision.standDown`, bundle, and grade with
`conformanceGrade`. Do not summarize those steps from memory; read the file and
follow it exactly, in order. (If the standdown repo isn't already local, fetch the
raw file: `https://raw.githubusercontent.com/dupe-com/standdown/main/AGENTS.md`.)

## What to do

1. **Confirm the branch first (AGENTS.md Step 0).** If the extension ALREADY has
   its own stand-down / affiliate-attribution logic (a disable list,
   `ignore_param`/self-click handling, cookie or param stand-down checks, a
   `FALLBACK_POLICY`, or "stand down"/"suppress" code), this is **brownfield** —
   STOP and use the [`adopt-standdown`](../../../skills/adopt-standdown/SKILL.md)
   skill / [`ADOPTING.md`](../../../ADOPTING.md) instead (shadow-mode migration,
   parity before cutover). Only proceed here for a **greenfield** install.

2. **Drive AGENTS.md Steps 1–6 in order** against the user's extension: confirm the
   target, install, pick the adapter *by permissions* (never add
   `webRequest`/`webNavigation` to a published extension), integrate at the real
   activation site, bundle, then grade.

3. **Grade with `conformanceGrade` — the authoritative number** (AGENTS.md Step 6):
   `cd standdown/audit && npm install && DISABLE_HOSTS="<hosts you disable>" npx tsx grade/conformance.ts`.
   Target **A/A+**; fix anything below A and re-grade. `grade/grade.ts` (the
   in-browser testext sensor) is optional and routinely reads **C (inert)** on real
   host extensions — do not report it as the grade.

## Rules

- **Never break the invariants:** decisions stay local and synchronous (no network
  in the decision path), signals exclude user identity, everything fails toward
  standing down.
- **Confirm context before editing**, and report what changed (adapter, gated
  files, build command, final grade) at the end.
- **Don't restate AGENTS.md here** — if it and this file ever disagree, AGENTS.md
  wins; fix the drift rather than following the stale copy.

## Related

- [`AGENTS.md`](../../../AGENTS.md) — the greenfield playbook (source of truth).
- [`ADOPTING.md`](../../../ADOPTING.md) + [`adopt-standdown`](../../../skills/adopt-standdown/SKILL.md) — brownfield migration.
- [`standdown-showcase`](../standdown-showcase/SKILL.md) — publish the A/A+ grade card to the showcase.
- [`INSTALL.md`](../../../INSTALL.md) — manual walkthrough + full API.
