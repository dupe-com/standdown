# 🛡️ Graded with standdown

Extensions that ran the [standdown](./README.md) affiliate conformance grader and
proved they stand down instead of hijacking existing attribution.

**Every badge here is reproduced by CI**, and the letter reflects the
**verification tier**:

| Badge | Tier | What CI proved |
| --- | --- | --- |
| **A** | Tier 1 — config-verified | Re-ran `conformanceGrade` on the declared policy inputs and reproduced the grade. |
| **A+** | Tier 2 — live-verified _(planned)_ | Additionally confirmed the **published** extension bundles this policy set (Chrome Web Store source). |

A submission declares only its policy inputs;
[`showcase-verify.yml`](./.github/workflows/showcase-verify.yml) recomputes the
grade + SHA and regenerates the card, rejecting any mismatch — the number can't be
faked and the card can't be hand-edited. The top mark (**A+**) is earned by
proving the *deployed* extension actually uses the graded config, so Tier 1 caps
at **A**. See [`showcase/README.md`](./showcase/README.md) to add yours (one
prompt, one PR).

---

_No submissions yet — be the first: see [showcase/README.md](./showcase/README.md)._
