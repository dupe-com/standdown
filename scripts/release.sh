#!/usr/bin/env bash
#
# Cut a release for standdown. Bumps the version, tags it, and pushes — the
# actual npm publish happens in CI via Trusted Publishing (OIDC), see
# .github/workflows/release.yml. No local `npm publish`, no 2FA OTP.
#
#   npm run release            # patch bump (0.2.0 -> 0.2.1) — the default
#   npm run release minor      # 0.2.0 -> 0.3.0
#   npm run release major      # 0.2.0 -> 1.0.0
#
# It refuses to run unless you're on a clean `main` in sync with origin, greens
# every gate, shows the tarball, and asks before it bumps + pushes. Set
# RELEASE_YES=1 to skip the confirmation (for unattended/automated runs).
set -euo pipefail

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "usage: npm run release [patch|minor|major]  (default: patch)"; exit 1 ;;
esac

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# --- Preconditions -----------------------------------------------------------
step "Preconditions"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "not on main — release from main only"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"
git fetch --quiet origin main || die "could not fetch origin/main"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not in sync with origin/main — pull/push first"
echo "  on main, clean, synced"

CURRENT="$(node -p "require('./package.json').version")"

# --- Gates -------------------------------------------------------------------
# The release workflow re-runs these before publishing; running them here too
# means we never tag a build that CI would reject.
step "Checks (typecheck · lint · test · citations)"
npm run typecheck
npm run lint
npm test
npm run policies-cite-check

step "Build"
npm run build

step "Tarball preview (what ships to npm)"
npm pack --dry-run

# --- Confirm -----------------------------------------------------------------
NEXT="$(node -e '
  const [maj, min, pat] = require("./package.json").version.split(".").map(Number);
  const b = process.argv[1];
  const v = b === "major" ? [maj + 1, 0, 0] : b === "minor" ? [maj, min + 1, 0] : [maj, min, pat + 1];
  console.log(v.join("."));
' "$BUMP")"
step "Ready to release"
printf "  %s  ->  %s (%s bump)\n" "$CURRENT" "$NEXT" "$BUMP"
printf "  npm publish runs in CI (Trusted Publishing / OIDC) once the tag is pushed.\n"
if [ "${RELEASE_YES:-}" != "1" ]; then
  read -r -p "  Bump, tag, and push? [y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "aborted — nothing changed"
fi

# --- Bump, tag, push ---------------------------------------------------------
step "Bump + tag"
npm version "$BUMP" -m "release: v%s"
NEW="$(node -p "require('./package.json').version")"

step "Push commit + tag (triggers the release workflow)"
git push origin main --follow-tags

printf '\n\033[1;32m✓ pushed v%s — CI is publishing standdown@%s\033[0m\n' "$NEW" "$NEW"
printf '  watch: https://github.com/dupe-com/standdown/actions/workflows/release.yml\n'
