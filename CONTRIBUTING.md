# Contributing

`standdown` is designed for compliance-sensitive browser-extension behavior.
Changes should be small, reviewable, and backed by tests.

## Development

```sh
npm run typecheck
npm run lint
npm run test
npm run build
```

Keep runtime dependencies at zero. Development dependencies are acceptable when
they are build, lint, type, or test tooling.

## Policy Changes

Policy changes must cite network documentation.

Every bundled policy rule must preserve:

- `metadata.sourceUrl` pointing at the specific network policy, help article, or
  upstream data file that supports the rule.
- `metadata.lastVerified` in `YYYY-MM-DD` format.
- `metadata.notes` when a rule is low confidence, derived from upstream data
  rather than direct network docs, or intentionally broader than the seed table.

Run:

```sh
npm run policies-cite-check
```

Do not add uncited detection rules. If a source is ambiguous, include that in
`metadata.notes` rather than presenting the rule as fully verified.

## Signed Bundles

Refresh bundles must be data-only signed policy bundles. Do not add remote code,
dynamic script loading, eval, or decision-path network calls.

Remote updates must remain monotone:

- Existing detection rules must survive same-or-broader.
- Durations may only lengthen.
- Activation rules must not change.
- Added overlapping policies are allowed, but runtime decisions union behaviors
  from all matching policies for the advertiser, so they cannot reduce
  suppression.
- Signed bundle regex `DomainRule` patterns must stay simple: avoid
  backreferences, lookaround, nested unbounded quantifiers, and long patterns.

## Pull Requests

Include focused tests for behavior changes. For adapter behavior, use mocked
browser APIs rather than a live extension runtime.
