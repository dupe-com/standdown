<p align="center">
  <img src="https://raw.githubusercontent.com/dupe-com/standdown/main/assets/logo.png" alt="standdown — affiliate stand-down, done right" width="620">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-alpha-E5484D?labelColor=1C1917" alt="project status: alpha">
  <a href="https://www.npmjs.com/package/standdown"><img src="https://img.shields.io/npm/v/standdown?color=F5A623&label=npm&labelColor=1C1917" alt="npm version"></a>
  <a href="https://github.com/dupe-com/standdown/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dupe-com/standdown/ci.yml?branch=main&label=CI&labelColor=1C1917" alt="CI status"></a>
  <img src="https://img.shields.io/badge/dependencies-0-2ea043?labelColor=1C1917" alt="zero runtime dependencies">
  <img src="https://img.shields.io/badge/types-included-3178C6?labelColor=1C1917" alt="TypeScript types included">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/standdown?color=8A8175&labelColor=1C1917" alt="MIT license"></a>
  <a href="https://affiliatecoc.org"><img src="https://img.shields.io/badge/aligned-Affiliate%20CoC-F5A623?labelColor=1C1917" alt="aligned with the Affiliate Code of Conduct"></a>
</p>

> [!WARNING]
> **Alpha — expect bugs and breaking changes.** standdown is pre-1.0 and under
> active development: the API may shift between minor versions and edge cases are
> still being found. Because it makes revenue-affecting decisions, pin your
> version, verify it against your own integration with the
> [conformance grader](#how-its-graded), and please
> [report anything that misbehaves](https://github.com/dupe-com/standdown/issues).

> **Your extension shouldn't steal the sale.** `standdown` detects existing
> affiliate attribution, suppresses competing activation, and proves the
> decision was made locally — never on a server.

`standdown` is a zero-runtime-dependency TypeScript library for extension
developers who need to detect existing affiliate attribution, suppress competing
activation, and prove that suppression decisions were made locally and
deterministically. Built and maintained by [Dupe](https://dupe.com).

## What makes it different

Affiliate stand-down is easy to claim and hard to prove. `standdown` is built so
the guarantees are structural — enforced by the type system and the architecture,
not by a promise in a blog post.

- 🔒 **Decisions never leave the device.** No network call participates in a
  stand-down decision, ever. The decision path is a pure function of local
  signals and bundled policies.
- 🛡️ **User data can't leak into a decision — by construction.** `Signals` is a
  closed type: identity, accounts, balances, email, and login state are
  structurally unable to enter it.
- ⚖️ **Fails toward standing down.** Ambiguity, storage errors, or a malformed
  policy all resolve to *suppress*. The library never hijacks a sale by accident.
- 🎯 **Detects attribution the way networks actually set it.** Landing params,
  redirect-chain hops, first-party cookie *names* (never values), and
  referrer/initiator classification — across eight verified network packs.
- 🅰️ **It grades itself, F→A+**, and hands you a [shareable
  card](#prove-it-and-show-it-off) when you pass — with an inert-code guard so
  "disciplined" can't be faked by shipping nothing.
- 📦 **Zero runtime dependencies.** Ships ESM + CJS + types. MV3, with a
  content-script path for Safari and reduced-permission contexts.

## How it works

standdown answers one question, locally: *does someone already own the affiliate
attribution on this page, so my extension should stay quiet?* It returns a
`Decision` — it never redirects, blocks, or fires anything itself. **You own the
side effects; you gate them on `decision.standDown`.**

For each navigation it inspects **local signals only** and matches them against
bundled, per-network **policy packs**:

- **Landing params** — the query params networks stamp on a click-through
  (`cjevent`, `irgwc`, `ranSiteID`, `awc`, `sscid`, eBay's `mkcid`/`campid`, …).
- **Redirect-chain hops** — tracker domains a click passed through (LinkSynergy,
  `prf.hn`, `awin1.com`, the universal fingerprint set), when the adapter can
  see them.
- **First-party cookie names** — attribution cookies a prior click dropped
  (`lsclick_mid`, `sscid`, `im_ref`, …). **Names only, never values.**
- **Referrer / initiator** — whether the navigation came from *your own* site (a
  self-owned click) or a third party.

A small state machine turns those into a decision: if a competitor's attribution
is present, it stands down for the policy's duration; if the signal is *yours* (a
declared self-param), it doesn't stand you down against your own click. Every
decision is deterministic, appended to a local audit log, and made without a
network call.

**Two integration shapes:**

| | When | Playbook |
| --- | --- | --- |
| **Greenfield** | Your extension has no stand-down logic yet | Gate each affiliate firing point on `decision.standDown`. Follow [`AGENTS.md`](./AGENTS.md). |
| **Brownfield** | Your extension already has homegrown attribution/stand-down logic (params, cookies, a disable list) | Migrate that decision path onto standdown **in shadow mode first** — run both in parallel and prove they agree before cutover, so no live commission is risked. Follow [`ADOPTING.md`](./ADOPTING.md). |

## Works across the major affiliate networks

Each bundled pack implements a network's *stand-down* expectations — the
detection signals it sets, the suppression behavior it asks for, and how long it
lasts — so you don't have to reverse-engineer them. Eight **verified** packs ship
enabled by default: seven named networks, plus a universal redirect-fingerprint
set.

<p align="center">
  <a href="https://www.cj.com/legal/software-policy"><img src="https://img.shields.io/badge/CJ%20Affiliate-00857C?style=for-the-badge&logoColor=white" alt="CJ Affiliate"></a>
  <a href="https://impact.com/stand-down-policy.ihtml"><img src="https://img.shields.io/badge/Impact-0E1C36?style=for-the-badge&logoColor=white" alt="Impact"></a>
  <a href="https://github.com/rakutenrewards/PublisherStandown-SDK"><img src="https://img.shields.io/badge/Rakuten%20Advertising-BF0000?style=for-the-badge&logo=rakuten&logoColor=white" alt="Rakuten Advertising"></a>
  <a href="https://success.awin.com/s/article/Downloadable-Software-Guidelines"><img src="https://img.shields.io/badge/Awin-E4097E?style=for-the-badge&logoColor=white" alt="Awin"></a>
  <a href="https://success.awin.com/s/article/Downloadable-Software-Guidelines"><img src="https://img.shields.io/badge/ShareASale-1F6FB2?style=for-the-badge&logoColor=white" alt="ShareASale"></a>
  <a href="https://partnernetwork.ebay.com/browser-extension-policy"><img src="https://img.shields.io/badge/eBay%20Partner%20Network-E53238?style=for-the-badge&logo=ebay&logoColor=white" alt="eBay Partner Network"></a>
  <a href="https://affiliate-program.amazon.com/help/operating/policies"><img src="https://img.shields.io/badge/Amazon%20Associates-FF9900?style=for-the-badge&logoColor=white" alt="Amazon Associates"></a>
</p>

The eighth verified pack is a **universal** set of publisher-contributed redirect
fingerprints ([piedotorg/standdown-domains](https://github.com/piedotorg/standdown-domains)).
Two more **experimental** packs (Sovrn/Skimlinks, Partnerize) are inferred from
domain knowledge and stay opt-in until you verify them. See the full pack table
and citations in [POLICIES.md](./POLICIES.md).

> Network names and logos identify the stand-down policies each pack implements.
> They don't imply endorsement, partnership, or certification by these networks.

## Set it up with an AI agent

**The fastest path — and the recommended one — is to hand the whole integration
to your coding agent.** It reads your extension, finds every place attribution
fires, gates each behind the decision, bundles, and grades the result. Copy this
prompt into Claude Code, Cursor, Copilot, etc., pointed at your extension's repo:

```text
Integrate the `standdown` npm library into this browser extension so it stops
hijacking affiliate attribution when a partner already owns the sale. Follow the
official guide at https://raw.githubusercontent.com/dupe-com/standdown/main/AGENTS.md.

First check whether this extension ALREADY has its own affiliate stand-down /
attribution-detection logic. If it does, STOP and use the brownfield migration
prompt at https://raw.githubusercontent.com/dupe-com/standdown/main/ADOPTING.md
instead — it moves the existing decision path onto the library in shadow mode,
proving parity before cutover so no live commission is put at risk. Only if this
is a greenfield install (no existing stand-down logic), do the full loop:
1. `npm install standdown`.
2. Pick the adapter by permissions: `standdown/webext` if the extension holds
   `webNavigation`/`webRequest`, otherwise `standdown/content` (Safari,
   content-script-only, or any MV3 build without those permissions).
3. Find every place this extension fires affiliate attribution (redirects, link
   rewrites, cookie writes) and gate each behind the stand-down decision — do
   nothing when `decision.standDown` is true.
4. Bundle per examples/mv3-extension (webext) or examples/content-extension
   (content); subpath imports don't resolve raw in extension contexts.
5. Grade it: git clone https://github.com/dupe-com/standdown && cd standdown/audit
   && npm install && DISABLE_HOSTS="<your disable hosts>" npx tsx grade/conformance.ts
   Report the letter grade and fix anything below A.

Preserve the invariants: decisions stay local and synchronous (no network in the
decision path), no user identity in signals, and fail toward standing down.
```

> **Use a capable model.** This integration reasons about revenue-affecting
> control flow across an unfamiliar codebase — run it on a frontier coding model
> (Claude Opus, GPT-5.5, or equivalent). Smaller/faster models miss firing points
> and mis-handle the `degraded` gate. If you must use a lighter model, review its
> gating diff by hand and always run the grader.

**Claude Code users** can skip the prompt: this repo ships two skills in
[`.claude/skills/standdown`](./.claude/skills/standdown) (greenfield) and
[`skills/adopt-standdown`](./skills/adopt-standdown) (brownfield). Copy the one
you want into `.claude/skills/` (or `~/.claude/skills/`) and run `/standdown` (or
`/adopt-standdown`). Agents that read [`AGENTS.md`](./AGENTS.md) or
[`llms.txt`](./llms.txt) get the same playbook automatically.

**Prefer to wire it by hand?** The full manual walkthrough and complete API
reference — adapters, quickstarts, self-exemption, per-host disable, signed
refresh, interop — live in **[INSTALL.md](./INSTALL.md)**. The four published
surfaces:

| Import | Purpose |
| --- | --- |
| `standdown` | Pure core: detection, session state machine, activation guard, policy validation, signed bundle verification |
| `standdown/policies` | Bundled policy packs and helpers |
| `standdown/webext` | Manifest V3 background/service-worker adapter |
| `standdown/content` | Content-script signal collector and evaluator |

## How it's graded

Unit tests prove the library's decisions in isolation. The [`audit/`](./audit)
harness proves the thing they can't: whether a *real integration* actually stands
down instead of hijacking existing attribution. Two graders:

- **`conformanceGrade` (start here)** — deterministic and browser-free. It drives
  the policy set your extension bundles through the real decision engine over
  every network's attribution and control scenarios and scores F→A+. This is the
  number to report, and the correct sensor for any real host extension.

  ```sh
  cd audit && npm install
  DISABLE_HOSTS="ebay.com,homedepot.com" npx tsx grade/conformance.ts
  #   standdown conformance grade: A+  (100/100)
  ```

- **`grade.ts` (in-browser)** — loads an unpacked extension into a real browser
  and watches for the testexts' `/aff/:net?actor=` redirect. A real host
  extension that activates by painting UI usually scores **C (inert)** here —
  that means "wrong sensor," not "dead code." Adapt
  [`grade/host-extension-probe.ts`](./audit/docs/grading-your-own-extension.md)
  to sense your extension's own surface.

The rubric has an **inert cap**: an extension that never activates even when
activation is *allowed* can't score above a C, so "disciplined stand-down" can't
be faked with dead code. The harness is opt-in — not part of the npm package, not
on the required CI path. See [`audit/README.md`](./audit/README.md).

### Prove it, and show it off

On a passing grade, both graders print a **shareable card** — a terminal card, a
copy-paste social snippet, and a self-contained `standdown-grade.svg` written to
your working directory that you can post anywhere:

<p align="center">
  <img src="https://raw.githubusercontent.com/dupe-com/standdown/main/assets/sample-grade-card.svg" alt="Sample standdown conformance grade card: A+, 100/100" width="640">
</p>

Graded A/A+? **Add your extension to the [showcase](./SHOWCASE.md)** — a wall of
fame where every badge is *reproduced by CI* (a submission declares its policy
inputs; CI re-runs the grader and regenerates the card, so nothing can be faked).
The badge is tiered: a config-verified entry earns an **A**, and verifying the
live published extension unlocks **A+**. One prompt opens the PR — see
[`showcase/README.md`](./showcase/README.md).

## Public commitments

<details>
<summary>The seven invariants standdown holds — the structural guarantees behind the pitch.</summary>

- **I1: Client-side decisions only.** No network call participates in a
  stand-down decision. Refresh may update the already-applied local policy bundle
  asynchronously, but decisions use local state synchronously.
- **I2: No user profiling.** Signals are a closed type and exclude user identity,
  accounts, balances, emails, login state, and tester-differentiating data.
- **I3: Fail toward standing down.** Unknown, ambiguous, malformed, or storage
  error states suppress activation.
- **I4: Monotone remote updates.** Signed refresh bundles may only broaden
  detection or lengthen durations and may not edit activation rules.
- **I5: Audit log on by default.** Decisions and refresh outcomes are locally
  auditable.
- **I6: No remote code.** Policies are data. No eval, remote scripts, or dynamic
  code loading.
- **I7: Deterministic and loggable.** Given the same local signals, policies,
  state, and clock, decisions are reproducible.

</details>

## Documentation

| Doc | What's in it |
| --- | --- |
| [INSTALL.md](./INSTALL.md) | Manual install + full API: adapters, quickstarts, self-exemption, per-host disable, signed refresh, interop |
| [AGENTS.md](./AGENTS.md) | The consumer playbook an AI agent follows (greenfield) |
| [ADOPTING.md](./ADOPTING.md) | Brownfield migration: move existing stand-down logic onto the library in shadow mode |
| [POLICIES.md](./POLICIES.md) | Every network pack, its signals, and citations |
| [SPEC.md](./SPEC.md) | The behavioral spec and invariants |
| [audit/](./audit) | The conformance graders |
| [SHOWCASE.md](./SHOWCASE.md) · [showcase/](./showcase) | "Graded with standdown" wall of fame + how to add yours (CI-verified) |
| [examples/mv3-extension](./examples/mv3-extension) · [examples/content-extension](./examples/content-extension) | Minimal working integrations |

## Releasing

Releases are cut by tagging a version with `npm run release`; CI then publishes
over npm Trusted Publishing (OIDC), with no stored token. See
[RELEASING.md](./RELEASING.md).

## License

[MIT](./LICENSE) — a project by [Dupe.com](https://dupe.com).
