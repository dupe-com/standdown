<!-- Thanks for contributing to standdown! -->

## What

<!-- What does this change do? -->

## Why

<!-- Motivation / linked issue. For policy-pack changes, cite the source. -->

## Checklist

- [ ] `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass
- [ ] New behavior has tests
- [ ] Policy-pack changes have a cited `metadata.sourceUrl` and pass `npm run policies-cite-check`
- [ ] Docs (README/SPEC/POLICIES) updated if behavior or the public API changed
- [ ] No decision path makes a network call (invariant I1) and no user-identity data enters `Signals` (invariant I2)
