---
name: adopt-standdown
description: Migrate an extension that ALREADY has homegrown stand-down / affiliate-suppression logic onto the `standdown` library without losing revenue. Use when the target already suppresses activation on prior affiliate attribution (has disable_domains, ignore_param, cookie/param stand-down checks, a FALLBACK_POLICY, or "stand down"/"suppress" code) and the user wants that logic moved onto `standdown` safely. For an extension with NO stand-down today, use the greenfield "install standdown" skill instead.
---

# adopt-standdown: brownfield migration onto `standdown`

`ADOPTING.md` at the repo root is the source of truth. This skill is a thin
router that walks the agent through its five phases and enforces the one
non-negotiable: **shadow-observe and reconcile before you cut over — never
big-bang-replace revenue-critical stand-down logic.**

First, confirm this is a **brownfield** case: the target already stands down
today (Phase 1 grep will show `disable_domains`, `ignore_param`, cookie/param
checks, a fetched/fallback policy, or "stand down"/"suppress" code). If it has
none, stop and use the greenfield skill instead.

Then **read `ADOPTING.md`** and drive its phases in order. Do not summarize from
memory — the detail (grep table, mapping table, invariant constraints, worked
Dupe example) lives there.

1. **DETECT** — grep the whole repo (background worker, content scripts, and any
   policy-serving server) and build the detection inventory: one row per rule
   with network/merchant, exact current behavior, file:line, and any TTL.
2. **MAP** — translate each row to exactly one `standdown` concept via the
   mapping table (params→`landingParams`, cookies→`cookiePatterns` **name-only**,
   merchant blocks→`disableHosts`, own attribution→`selfPatterns` +
   `selfExemptionScope`). Match **current fleet behavior**, not the full library.
3. **SHADOW** — baseline grade → observe-only beside the real path (namespaced
   shadow key / analytics, no action taken) → reconcile every divergence
   (safe-stricter / dangerous-more-permissive / needs-human-decision) → flagged
   cutover (off-by-default) → delete old code **last**.
4. **GUARD** — hold the invariants as hard constraints: no network call in the
   decision path (I1), fail toward standing down (I3), monotone/never lift an
   active stand-down (I4), cookie NAMES only (I2).
5. **VERIFY** — characterization tests, audit grade ≥ baseline, no-fail-open
   assertions, flag off by default, old code retained as rollback.

## Guardrails (do not violate)

- **Shadow before cutover is mandatory.** Compute decisions in observe-only mode
  and reconcile on live traffic first. Drive **dangerous-more-permissive**
  divergences (library activates where the old path stood down → hijacks a sale)
  to **zero** before any flag goes on.
- **Do not delete or rewrite the existing decision path** until the flag has
  soaked at 100% in production. It is the rollback.
- **Any new integration is off-by-default and observer-only** until Phase 5
  passes. The migrated path must never fail open and must never make a network
  call in the decision path.
- **needs-human-decision divergences are escalated, never silently chosen**
  (e.g. the CJ self-click lift gap, Amazon/Wayfair scope). Match current behavior
  by default.

Report at the end: detection inventory, the mapping/config, the divergence
classification, the baseline vs. post-migration grade, and any human decisions
still open.
