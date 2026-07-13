# Releasing

`standdown` publishes from CI. You cut a release by tagging a version; a GitHub
Actions workflow (`.github/workflows/release.yml`) does the actual `npm publish`
using **npm Trusted Publishing (OIDC)** — no npm token or 2FA OTP is involved,
and no publish secret is stored anywhere.

```sh
npm run release          # patch bump (default): 0.2.0 -> 0.2.1
npm run release minor    # 0.2.0 -> 0.3.0
npm run release major    # 0.2.0 -> 1.0.0
```

`scripts/release.sh` refuses to run unless you're on a clean `main` in sync with
`origin/main`, then it:

1. Runs every gate — `typecheck`, `lint`, `test`, `policies-cite-check`.
2. Builds `dist/` (`tsup`).
3. Shows the tarball (`npm pack --dry-run`) — the published files are `dist/`,
   `README.md`, `LICENSE`, `POLICIES.md`, `ADOPTING.md`.
4. Asks you to confirm the bump (set `RELEASE_YES=1` to skip, for unattended runs).
5. `npm version <bump>` — commits and tags `vX.Y.Z`.
6. Pushes the commit + tag to `origin`.

Pushing the `vX.Y.Z` tag triggers the release workflow, which re-runs the gates,
rebuilds, verifies the tag matches `package.json`, and publishes with
`npm publish --provenance` over OIDC. Watch it at
**Actions → Release**. If it fails, the tag is already pushed — fix forward and
re-run the workflow, or delete the tag (`git push origin :vX.Y.Z`) and re-cut.

## One-time setup: the trusted publisher

Publishing over OIDC requires npm to trust this repo's workflow. Do this once, on
the npm website (it can't be scripted):

1. https://www.npmjs.com/package/standdown → **Settings** → **Trusted Publishers**.
2. Add a **GitHub Actions** publisher:
   - Organization / user: `dupe-com`
   - Repository: `standdown`
   - Workflow filename: `release.yml`
   - Environment: *(leave blank)*
3. Save. Optionally, once OIDC is confirmed working, tighten the package's
   publish settings to **disallow token publishing** so releases can *only* come
   from this workflow.

The publishing account may keep 2FA on — trusted publishing is exempt because the
publish is authorized by the workflow's OIDC identity, not a user session.

## Choosing the bump

Pre-1.0, follow semver intent: **patch** for fixes and doc/README changes (the
README ships to npm), **minor** for additive API, **major** for breaking changes.
Note the `audit/` harness and `examples/` are **not** part of the published
package (see the `files` field in `package.json`), so changes there alone are a
docs/tooling patch.
