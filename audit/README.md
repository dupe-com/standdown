# standdown audit harness

A **black-box conformance grader** for browser-extension affiliate stand-down.
Where the root test suite proves the library's decisions in-process, this harness
tests the thing unit tests can't: whether a *real MV3 extension*, loaded into a
real browser against realistic merchant pages, actually respects existing
affiliate attribution instead of hijacking it.

It is **not** part of the `standdown` npm package and is **not** wired into the
required CI check. It's an optional, opt-in tool — run it locally when you want a
grade.

## What it does

- **`fixtures/`** — a local HTTP server (on `127.0.0.1`) that serves synthetic merchant landing
  pages carrying pre-existing attribution for each supported network (landing
  params, first-party cookies, redirect hops, referrer classes), plus clean
  controls.
- **`grade/`** — loads an extension, drives it through every scenario, observes
  whether it introduced competing attribution, and scores the run **F → A+**.
- **`testext/`** — three reference extensions (`good`, `bad`, `inert`) that
  validate the grader itself: `good` should score well, `bad` should be caught
  hijacking, and `inert` must trip the **inert cap** (see below).

### The inert cap

An extension that never activates — even on positive controls where activation
is allowed — hasn't proven it does anything. The rubric caps such a run at a **C**
and flags it, so "disciplined stand-down" can't be faked by shipping dead code.

## Running it

```sh
cd audit
npm install

# In-process self-test: fixtures + library, no browser. Fast sanity check.
npm run fixtures:selftest

# Serve the fixture site (for manual poking or the browser grader).
npm run fixtures:serve

# Build the example MV3 extension for spike/manual runs.
npm run spike:mv3
```

The browser grader uses Playwright; run `npx playwright install chromium` once
before the first browser run.

## Grading your own extension

Point the grader at your unpacked MV3 build directory:

```sh
npx tsx grade/grade.ts /path/to/your/unpacked-extension
```

It reports a scenario-by-scenario pass / MISS / HIJACK breakdown plus an overall
letter grade. The scenarios in `fixtures/scenarios.ts` are derived from the same
policy packs the library ships, so a high grade means your extension stands down
on the attribution `standdown` knows how to detect.

### Grading against your own policy pack

By default the grader uses standdown's bundled packs (`allPolicies`). To grade
against **your own** policy pack — the usual case once you've adopted the library
with custom or overridden policies — point `POLICY_PACK` at a module that exports
your policies:

```sh
POLICY_PACK=./my-packs.ts npx tsx grade/grade.ts /path/to/your/unpacked-extension
```

The module may export the `StanddownPolicy[]` as its default export, or as a
named `policies` / `allPolicies` export. Because the entire scenario matrix and
expected decisions are **derived from the packs**, supplying your policy is all
that's needed — no affiliate identifiers or scenarios are hardcoded on this path.
(The module must be resolvable by `tsx`, i.e. run this from a project where your
pack and its imports resolve — normally your own repo.)

## Grading the decision (no browser, CI-able)

`grade/conformance.ts` grades an adopter's policy set directly against the
deterministic fixture scenario matrix using `StanddownSession`. It needs no
browser or Playwright, so it can run in CI where black-box extension probes are
inconclusive. Use `conformanceGrade({ policies, disableHosts, extraScenarios })`
from TypeScript, or run the repo-clone-only CLI:

```sh
POLICY_PACK=./my-packs.ts DISABLE_HOSTS=ebay.com,homedepot.com npx tsx grade/conformance.ts
```

This grades the decision an adopter owns. It complements, rather than replaces,
the black-box probes that verify a built extension actually obeys that decision.

> **Scope of the activation sensor.** The grader detects an "activation" as a
> request to the fixture's own affiliate endpoint (`/aff/…?actor=`) — the shape
> the reference extensions use. It reliably catches **hijacks** (competing
> attribution introduced against the fixtures) for any extension, but an
> extension that activates only by redirecting to a *third-party* network's own
> redirector won't trip that sensor, so its positive controls may under-report
> and read as inert. For arbitrary real-world extensions, read the grade
> alongside the per-scenario evidence rather than as a single number.
