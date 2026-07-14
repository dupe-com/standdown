# Adopting `standdown` in an extension that already stands down

This is the **brownfield** migration guide. It is for an extension that *already*
has homegrown stand-down / affiliate-suppression logic and wants to move that
logic onto the [`standdown`](https://www.npmjs.com/package/standdown) library
without ever losing revenue in the switch.

> If you are adding stand-down to an extension that has **none** today, you want
> the greenfield "install standdown" skill instead — that is a clean install.
> This guide is the harder case: there is a working, revenue-critical decision
> path in production, and the job is to replace it *provably* rather than *hopefully*.

It is tool-agnostic. Point any coding agent (Claude Code, Cursor, Copilot, etc.)
at it. The one rule that overrides everything below: **you are migrating logic
that decides whether a partner keeps a commission. A wrong "activate" hijacks a
sale that someone else already earned. Treat every step as revenue-critical and
default to the existing behavior whenever the new behavior is uncertain.**

The migration runs in five phases:

1. **DETECT** — find the existing stand-down logic.
2. **MAP** — translate each homegrown construct to a `standdown` API concept.
3. **SHADOW** — run `standdown` in observe-only mode beside the real path, reconcile every divergence, *then* cut over behind a flag.
4. **GUARD** — hold the library's invariants as hard constraints the whole way.
5. **VERIFY** — characterization tests, the audit grade, and no-fail-open assertions before you delete anything.

Throughout, the worked example is a real migration: a browser
extension whose server-driven stand-down policy covered CJ, Rakuten, Impact,
eBay, and a handful of merchant blocks (Home Depot, AliExpress, Shein), with
`ignore_param` self-exemption and a whole-cookie-string matcher.

---

## Phase 1 — DETECT the existing stand-down logic

You cannot migrate what you have not found. Stand-down logic is rarely in one
file called `standdown.ts`; it hides in redirect gates, cookie sniffers,
"disable on these domains" lists, and param allowlists. Sweep the codebase for
all of it before mapping anything.

**Grep for these signals** (case-insensitive, whole repo, including the
background worker, content scripts, and any server that ships policy to the
extension):

| What you're looking for | Grep patterns |
| --- | --- |
| Affiliate **click-id params** | `cjevent`, `cjdata`, `irclickid`, `irgwc`, `awc`, `ranSiteID`, `ranEAID`, `ranMID`, `sscid`, `clickid`, `afsrc` |
| **Network redirect domains** | `linksynergy`, `anrdoezrs`, `dpbolvw`, `jdoqocy`, `kqzyfj`, `qksrv`, `awin1`, `shareasale`, `commission-junction` |
| **Cookie checks** | `document.cookie`, `lsclick_mid`, `linkshare`, `cje`, `cjevent_dc`, `im_ref`, cookie-name/`includes(` scans |
| **Self-exemption / own attribution** | `ignore_param`, `ignore-stand-down`, `self`, your own `PID=`, `SID=`, `siteID`, publisher-owned click ids |
| **Merchant / host blocks** | `disable_domains`, `disableHosts`, `blocklist`, `safari_popup_disable_domains`, allowlist/denylist of hosts |
| **The decision itself** | `stand down`, `standdown`, `stand-down`, `suppress`, `shouldActivate`, `shouldStandDown`, `allowlist`, `redirect` gates around cookie writes |

**Produce a detection inventory** — one row per distinct rule, capturing:

- the **network or merchant** it concerns,
- the **exact current behavior** (what makes it fire, what it does when it fires),
- **where** it lives (file:line), and
- any **TTL / persistence** (session flag? cookie duration? nothing?).

Worked example (an adopting extension): the sweep surfaced a server-fetched policy plus a
hand-copied `FALLBACK_POLICY` in the background worker, a `standDownHelper.ts`
that lowercased the **entire** `document.cookie` string and did `.includes()`,
an `ignore_param` self-exemption per network, a `standDownCookieDuration` of 60
minutes for CJ, and `disable_domains` lists for eBay, Home Depot, AliExpress,
and Shein. Note especially the two things that are easy to miss: the **cookie
matcher looked at values, not just names**, and `disable_domains` used
**substring** `includes()` (so `'ebay.'` also matched `rebay.com`).

Do not skip anything as "obviously equivalent." The divergences that cost
revenue are exactly the ones that look equivalent at a glance.

---

## Phase 2 — MAP homegrown constructs to the `standdown` API

`standdown` is a **data-driven policy engine**: you describe each network as a
`StanddownPolicy` (detection rules + stand-down behavior), hand the array to an
adapter, and it returns a `Decision`. Your job here is a translation table, not
new logic. Map each inventory row to exactly one library concept.

### The mapping table

| Homegrown construct | `standdown` concept | Notes |
| --- | --- | --- |
| Affiliate params that trigger stand-down (`cjevent`, `ranSiteID`, …) | `detection.landingParams` | Grouped `anyOf` / `allOf`; `{ name }` alone = presence, add `value` + `match:'equals'` for value checks. |
| Network redirect/rotator hostnames (`linksynergy`, `anrdoezrs`) | `detection.redirectDomains` | `{ pattern, kind:'suffix' }`. Observed only by the webext adapter's `webRequest` plane. |
| Cookie checks | `detection.cookiePatterns` | **NAME-ONLY.** `{ name, match:'exact'\|'substring' }`. Values are never inspected — see the divergence note below. |
| Your **own** attribution params (`ignore_param`) | `selfPatterns` + `selfExemptionScope` | `{ name, value?, match?, networkId }`. Scope controls how long the exemption sticks — this is the highest-risk mapping. |
| "Never operate on this host" merchant blocks (`disable_domains`) | `detection.disableHosts` | `{ pattern, kind:'suffix'\|'regex' }`. Unconditional, strongest match, **not liftable** by any self-exemption. |
| Per-network minimum stand-down window (`standDownCookieDuration`) | `standdown.minDurationMs` with `sessionRule:'session-or-min'` | Calibrate to the production number. |
| Session vs persisted stand-down | adapter `storage: 'session'` \| `'local-ttl'` | `local-ttl` survives a `sessionStorage` clear within a sliding 24h envelope. |

### Worked example: an adopting extension's config

The inventory mapped cleanly onto the bundled packs plus one custom
merchant-block policy:

```ts
import { createContentStanddown } from 'standdown/content';
import { cjPolicy, impactPolicy, rakutenPolicy, ebayEpnPolicy } from 'standdown/policies';

// disable_domains -> a custom policy carrying ONLY detection.disableHosts.
// (...id, network, standdown, activation, metadata omitted for brevity...)
const hostMerchantBlocks = {
  // id: 'host-merchant-blocks', network: {...}, standdown: {...}, activation: {...}, metadata: {...},
  detection: {
    disableHosts: [
      { pattern: '(^|\\.)ebay\\.[a-z.]+$', kind: 'regex' }, // replaces disable_domains ['ebay.com','ebay.']
      { pattern: 'homedepot.com', kind: 'suffix' },
      { pattern: 'aliexpress.com', kind: 'suffix' },
      { pattern: 'aliexpress.co.uk', kind: 'suffix' },
      { pattern: 'shein.com', kind: 'suffix' },   // suffix also covers m.shein.com
      { pattern: 'shein.co.uk', kind: 'suffix' }, // and m.shein.co.uk
    ],
  },
} as const;

const standdown = createContentStanddown({
  policies: [cjPolicy, impactPolicy, rakutenPolicy, ebayEpnPolicy, hostMerchantBlocks],
  selfPatterns: [
    { name: 'ranSiteID', value: 'EXAMPLESITEID', match: 'contains', networkId: 'rakuten' },
    { name: 'cp', value: '_examplebrand', match: 'contains', networkId: 'cj' },
    { name: 'PID', value: 'CJ0000000001', match: 'equals', networkId: 'cj' },
    { name: 'PID', value: 'CJ0000000002', match: 'equals', networkId: 'cj' },
  ],
  selfExemptionScope: 'policy', // per-navigation, faithful to the adopter's ignore_param — NEVER 'session' here
  publisherSites: ['example.com'],
  storage: 'session',           // or 'local-ttl' to honor CJ's 60-minute minDurationMs across a sessionStorage clear
  auditLog: true,
  onDecision: (d) => {/* namespaced shadow key / analytics only — see Phase 3 */},
});
```

Notes that generalize to any migration:

- **`disable_domains` is not a network** — do not invent a policy pack for it.
  Merchant blocks are `detection.disableHosts` on a custom policy. Home Depot,
  AliExpress, and Shein each become a `suffix` rule; a suffix rule already
  matches subdomains, so `shein.com` covers `m.shein.com` with no extra entry.
- **`ignore_param` maps to `selfPatterns`, and the scope is the whole ballgame.**
  The adopter's `ignore_param` was *per-navigation*, so `selfExemptionScope: 'policy'`
  (the default) is faithful. `'session'` would add self-click stickiness the adopter
  never had and could let the extension **activate** on a later param-less visit
  where the adopter stood down — a more-permissive change that hijacks a sale. Only use
  `'session'` if the homegrown code actually persisted the exemption.
- **Match the current fleet, not the "complete" library.** The bundled
  `amazonPolicy` always stands down on Amazon; if the extension currently stays
  *active* on Amazon (`ALLOW_AMAZON=true`), **exclude** it. Same for any host the
  extension deliberately still operates on (an adopter's retired Wayfair block): omit
  the `disableHosts` entry until the business decides to reinstate it. Broader
  bundled packs (`universal`, `awin`, `shareasale`) are safe-stricter but will
  disagree with current behavior a lot — keep them **opt-in** for the first cut.

---

## Phase 3 — SHADOW mode before cutover (this is the whole point)

**Never big-bang-replace revenue logic.** The existing decision path is the
ground truth for money that is already being earned; the new one is a hypothesis
until proven. A direct swap bets real commissions on that hypothesis being
correct on the first try, across every network, merchant, and edge case you
found in Phase 1 — and the failure mode is silent (a hijacked sale looks like a
normal activation). So you run the new engine in the dark first and only promote
it once it agrees with reality on purpose.

### The protocol

1. **Baseline grade.** Run the audit grader against the *current* extension and
   record its letter grade. This is the bar the migration must **meet or beat** —
   never regress it.

2. **Shadow observe.** Wire `standdown` in alongside the existing path, computing
   a `Decision` for every navigation but **taking no action on it**. The real
   path still decides. Emit each shadow decision to a **namespaced** shadow key /
   analytics channel (via `onDecision` or your own logging) next to what the real
   path did. Nothing the user experiences changes.

3. **Reconcile divergences.** Compare shadow vs. real on live traffic and triage
   every disagreement into one of:
   - **safe-stricter** — `standdown` stands down where the old path activated.
     No revenue risk (you can only *lose a competing activation*, never hijack).
     Accept, or note as expected.
   - **dangerous-more-permissive** — `standdown` would activate where the old
     path stood down. **This is the failure class that hijacks sales. It must be
     driven to zero before cutover**, usually by adding a `disableHosts` entry or
     tightening a `selfPattern`.
   - **needs-human-decision** — a genuine behavior change with a business
     tradeoff (see the adopter cases below). Escalate; do not silently pick.

4. **Flagged cutover.** Only once dangerous-more-permissive divergences are zero
   and the grade is ≥ baseline: move the real decision behind an
   **off-by-default flag** that swaps the old path for `standdown`. Roll it
   forward gradually. Keep the shadow comparison running so a regression is
   visible immediately.

5. **Delete old code — last.** Only after the flag has been fully on in
   production and stable do you remove the homegrown logic. Until then it stays
   as the instant rollback.

### Worked example: the divergences an adopter had to reconcile

- **Cookie name-vs-value (safe-stricter, accepted).** The old matcher hit on a
  cookie **name or value**; `standdown` matches **names only**. Both live adopter
  tokens (`lsclick_mid`, `linkshare`) are real cookie *names*, so name-only still
  catches them — name-only merely drops the old code's value-substring
  over-matches. No fix.
- **eBay unconditional block (dangerous-more-permissive, MUST FIX).** The old
  `disable_domains ['ebay.com','ebay.']` stood down on *every* eBay host;
  `ebayEpnPolicy` alone only stands down on eBay tracking params/referrers, so a
  param-less eBay page would **activate**. Fix: add the eBay `disableHosts` regex
  shown in Phase 2. That restores the unconditional block and makes it unliftable.
- **`ignore_param` scope (dangerous-more-permissive if mis-set).** Covered above:
  pin `selfExemptionScope: 'policy'`.
- **Self-click lift gap (needs-human-decision).** The old `ignore_param` actively
  *cleared* an already-active CJ 60-minute stand-down so an adopter self-click could
  re-win attribution. `standdown` is **monotone** — it never lifts an active
  stand-down (Invariant, Phase 4). This is safe for never-hijacking but costs
  adopter self-attribution in the CJ overlap window. Config cannot close it; a human
  must accept the loss or build an out-of-library special case.
- **Amazon / Wayfair (needs-human-decision).** Both resolved by *matching current
  behavior*: exclude `amazonPolicy`, omit the Wayfair block.

---

## Phase 4 — GUARD the invariants (agent constraints)

These are the library's public commitments. In a migration they double as **hard
constraints on you, the agent**. If any change you are about to make would
violate one, stop and flag it instead.

- **No network call in the decision path (I1).** The decision must be local and
  synchronous. The old code may have *fetched* its policy (the adopter fetched
  `/api/stand-down-policy`); the migrated path takes a **statically imported**
  `policies` array. Any policy freshness mechanism (signed refresh, a separate
  shadow fetch) must run **outside** the decision path and must never edit the
  live decision inline. Adding `webRequest`/`declarativeNetRequest` capture is a
  manifest change requiring separate sign-off — do not slip it in.
- **Fail toward standing down (I3).** Unknown, ambiguous, malformed, or storage-
  error states must **suppress activation**, never activate. This is the opposite
  of the old code's fail-**open** to a stale `FALLBACK_POLICY`. **Read `degraded`
  carefully — it means different things per adapter, and getting this wrong is the
  single most common way to ship dead code.** In the full `webext` adapter,
  `degraded: true` is an *exception* (a plane like `webRequest` went missing), so
  folding it into stand-down (`decision.standDown || decision.degraded`) correctly
  fails closed. In the `content` / `url` adapter it is the **normal steady state**:
  those adapters see only the page/URL (no redirect chain), so *every* clean-page
  non-stand-down decision carries `degraded: true` by design. Gating on
  `standDown || degraded` there stands down on **every clean page** → the extension
  never activates → the grader's **C-inert cap**. For a content/url adapter, gate
  on **`decision.standDown` alone**; the fail-closed behavior you need already
  lives in the decision itself (a malformed URL or any collection error resolves to
  `standDown: true` without your help).
- **Monotone updates only (I4).** Stand-downs only broaden/lengthen; an active
  stand-down is never lifted, and policy refresh may not edit activation rules.
  Do not reintroduce "clear the stand-down" behavior to match old self-click code
  — that is the human-decision gap above, not a bug to patch.
- **Cookie NAMES only (I2).** Never port a rule that depends on a cookie *value*.
  If a genuine signal lives *only* in a value and never a name, `standdown`
  cannot express it — flag it; do not try to smuggle the value into `Signals`.
- **No user profiling / no remote code (I2, I6).** Signals exclude user identity;
  policies are data, never `eval`'d or fetched-and-executed.

---

## Phase 5 — VERIFY before you delete

Do not remove the homegrown path on faith. Prove equivalence-or-better first.

- [ ] **Characterization tests.** Before touching anything, write tests that pin
  the *current* extension's decision on a representative URL/cookie/referrer for
  every network and merchant in the Phase 1 inventory. These are the executable
  spec of "what we do today." The migrated path must pass them (or the delta must
  be a signed-off human decision, not an accident).
- [ ] **Shadow divergence report is clean.** Zero **dangerous-more-permissive**
  divergences on live traffic. Every remaining disagreement is classified
  safe-stricter or an approved human decision.
- [ ] **Audit grade ≥ baseline.** Run the deterministic `conformanceGrade` on
  **your migrated policy set** and confirm the letter grade meets or beats the
  Phase-3 baseline — this is the number to report. The grader lives in the repo
  (it is *not* in the npm package), so set it up once — cloning the tag that
  matches your installed `standdown` version, and building the lib the grader
  imports:

  ```sh
  git clone https://github.com/dupe-com/standdown && cd standdown
  git checkout v0.2.6            # the standdown version you installed — keep them in lockstep
  bun install && bun run build   # build the lib the grader imports
  cd audit && npm install
  ```

  Then grade **your own** policies by pointing `POLICY_PACK` at the module you
  actually ship — the same array you pass the adapter, so the grade reflects
  production rather than the bundled default — and passing the hosts you disable:

  ```sh
  POLICY_PACK=/abs/path/to/your/extension/policies.ts \
    DISABLE_HOSTS="<hosts you disable>" npx tsx grade/conformance.ts
  ```

  **Without `POLICY_PACK` the grader scores standdown's bundled `allPolicies`, not
  your set** — the number would be meaningless for your migration. (Your policies
  module must resolve its imports from here; if it only imports from `standdown` /
  `standdown/policies` it resolves against the built clone. See `audit/README.md`
  if it pulls in your own path aliases.) An **A / A+** means it respects existing
  attribution on every tested network *and* still activates when allowed. A **C
  (inert cap)** means it stopped activating at all — over-suppression, safe for
  revenue but you've shipped dead code; investigate (the most common cause is the
  `|| degraded` mistake in Phase 4/I3 above). An **F** means it hijacked
  attribution somewhere — the flag must not go on. (The in-browser `grade/grade.ts`
  is an optional extra sensor and reads **C (inert)** on most real host extensions
  — don't use it for the grade.)
- [ ] **No fail-open assertions.** Add tests asserting that malformed input,
  storage errors, and unknown networks resolve to `standDown: true` (or a
  suppressed activation). The migration must not have reintroduced any fail-open
  path. On the `webext` adapter, also assert a `degraded` decision is treated as
  stand-down; on a `content`/`url` adapter do **not** — `degraded` is the normal
  clean-page state there, and gating on it makes the extension inert (Phase 4/I3).
- [ ] **Flag is off by default** and the old code still present as rollback until
  the flag has been fully on and stable in production.

Only when every box is checked and the flag has soaked at 100% do you return to
Phase 3, step 5 and delete the homegrown logic.

---

## Phase 6 — Showcase your grade (optional)

Once you have a passing `conformanceGrade`, you can publish it to the public
["Graded with standdown" wall of fame](./showcase/README.md) — a CI-verified
gallery where the grade is reproduced from your declared inputs, so it can't be
faked. Run [`/standdown:showcase`](./showcase/README.md#add-yours--one-prompt) (or
follow the by-hand steps) to open a PR to `dupe-com/standdown`.

**Read this before you submit — the badge is not your grade letter.** The
showcase badge reflects a **verification tier**, not the raw score, and the two
scales collide at "A+":

- **Tier 1 (config-verified) caps the badge at A.** CI re-runs the grade on your
  declared policy inputs and reproduces it. Your true conformance score (e.g.
  `A+ 100/100`) is shown *alongside* the A badge — an A badge with a 100/100 score
  just means "proven config, not yet proven on prod."
- **Tier 2 (live-verified) earns the A+ badge.** CI additionally downloads your
  **published** Chrome Web Store crx and confirms it bundles this exact policy set
  (matching inputs SHA).

**For a brownfield adopter this ordering is structural, not optional.** Until you
have completed the flagged cutover (Phase 3, step 4) *and shipped a Web Store
build that carries this config*, your deployed extension does **not** bundle the
migrated policy set — the flag is off by default. So:

- **Submitting during shadow / off-by-default → Tier 1 (A).** This is honest and
  reproducible; a `live-verify` right now would correctly *fail* the SHA match
  because prod doesn't ship this config yet. Don't try to force A+ before cutover.
- **Upgrading to A+ is a deliberate post-cutover step.** After the flag has soaked
  at 100% and the new Web Store build is live, run `showcase:live-verify` against
  the deployed crx, rebuild the card, and the badge flips A → A+ on the same
  showcase entry (see [Reach A+ (Tier 2)](./showcase/README.md#reach-a-tier-2)).
  A weekly cron re-checks merged records, so if you later ship a divergent version
  the A+ is revisited.

The zero-effort alternative to a public submission is the shareable SVG card the
grader already emits on every passing run — drop it in your PR or internal docs.
It shows the full-strength conformance grade (A+) without any tier gating, because
it isn't making a verification claim about prod.

---

## Reference

- `README.md` — full API: `selfPatterns` / `selfExemptionScope`,
  `detection.disableHosts`, `landingParams` / `redirectDomains` /
  `cookiePatterns`, degraded decisions, signed policy refresh, and the public
  invariants (I1–I7).
- `POLICIES.md` — bundled network packs and citations. `allPolicies` is the
  verified set; `experimentalPolicies` are opt-in.
- `audit/README.md` — the conformance graders (`conformanceGrade` is the letter
  grade used in Phase 5).
- `AGENTS.md` — the greenfield playbook, for extensions with **no** existing
  stand-down logic (the `setup` skill / `/standdown:setup` drives it).
