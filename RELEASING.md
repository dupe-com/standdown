# Releasing

`standdown` is published to npm by a human — one command does the whole run.

```sh
npm run release          # patch bump (default): 0.2.0 -> 0.2.1
npm run release minor    # 0.2.0 -> 0.3.0
npm run release major    # 0.2.0 -> 1.0.0
```

`scripts/release.sh` refuses to run unless you're on a clean `main` that's in
sync with `origin/main` and logged in to npm, then it:

1. Runs every gate — `typecheck`, `lint`, `test`, `policies-cite-check`.
2. Builds `dist/` (`tsup`).
3. Shows the tarball (`npm publish --dry-run`) — the published files are
   `dist/`, `README.md`, `LICENSE`, `POLICIES.md`.
4. Asks you to confirm the bump.
5. `npm version <bump>` — commits and tags `vX.Y.Z`.
6. `npm publish` — **prompts for your 2FA OTP**.
7. Pushes the commit + tag only after publish succeeds.

Nothing reaches `origin` until the publish works, so a wrong OTP or a registry
error leaves the remote untouched. If `npm publish` fails after the version bump,
the bump + tag are local and unpushed — fix the issue and re-run
`npm publish && git push origin main --follow-tags`, or roll back with
`git reset --hard HEAD~1 && git tag -d vX.Y.Z`.

## Choosing the bump

Pre-1.0, follow semver intent: **patch** for fixes and doc/README changes (the
README ships to npm), **minor** for additive API, **major** for breaking changes.

## Why not CI?

Releases are deliberately human-cut — no token with publish rights lives in CI.
If you later want tag-triggered publishing, add a workflow that runs on `v*` tags
with a granular npm automation token in `NPM_TOKEN`; that is a separate, explicit
decision to move publish rights into CI.
