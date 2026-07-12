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

- **`fixtures/`** — a local HTTPS server that serves synthetic merchant landing
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
