---
description: Migrate an extension's EXISTING affiliate stand-down logic onto standdown, shadow-mode first (no revenue risk).
---

Migrate this extension's **existing** affiliate stand-down / attribution logic
onto the **standdown** library (https://github.com/dupe-com/standdown) without
losing revenue.

Read and follow, end to end, the brownfield playbook at
`${CLAUDE_PLUGIN_ROOT}/ADOPTING.md` — or, if unavailable, fetch
https://raw.githubusercontent.com/dupe-com/standdown/main/ADOPTING.md. Drive its
phases in order: DETECT → MAP → SHADOW → GUARD → VERIFY.

The one non-negotiable: **shadow-observe and reconcile against live behavior
before any cutover — never big-bang-replace revenue-critical stand-down logic.**
Drive every "dangerous-more-permissive" divergence (library activates where the
old path stood down) to zero before a flag goes on. Report the detection
inventory, the mapping/config, the divergence classification, and the baseline
vs. post-migration conformance grade.
