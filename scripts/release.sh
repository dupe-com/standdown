#!/usr/bin/env bash
#
# One-command release for standdown. Keeps the human-cut model — you run it, it
# does everything except hand over your 2FA OTP (npm prompts you for that).
#
#   npm run release            # patch bump (0.2.0 -> 0.2.1) — the default
#   npm run release minor      # 0.2.0 -> 0.3.0
#   npm run release major      # 0.2.0 -> 1.0.0
#
# It refuses to run unless you're on a clean `main` that's in sync with origin,
# greens every gate, shows you the tarball, and asks before it bumps or publishes.
# Nothing is pushed until the publish succeeds, so a failed OTP leaves origin
# untouched.
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
npm whoami >/dev/null 2>&1 || die "not logged in to npm — run: npm login"
echo "  on main, clean, synced; npm user: $(npm whoami)"

CURRENT="$(node -p "require('./package.json').version")"

# --- Gates -------------------------------------------------------------------
step "Checks (typecheck · lint · test · citations)"
npm run typecheck
npm run lint
npm test
npm run policies-cite-check

step "Build"
npm run build

step "Tarball preview (what ships to npm)"
# `npm pack --dry-run` lists the files WITHOUT contacting the registry. Do NOT use
# `npm publish --dry-run` here: it validates against the registry and errors out on
# the still-current (already-published) version before we've bumped. The real
# registry check happens at `npm publish` below, after the version bump.
npm pack --dry-run

# --- Confirm -----------------------------------------------------------------
# Compute the next version in Node — `npm version --dry-run` still writes
# package.json on some npm versions, so never use it just to preview.
NEXT="$(node -e '
  const [maj, min, pat] = require("./package.json").version.split(".").map(Number);
  const b = process.argv[1];
  const v = b === "major" ? [maj + 1, 0, 0] : b === "minor" ? [maj, min + 1, 0] : [maj, min, pat + 1];
  console.log(v.join("."));
' "$BUMP")"
step "Ready to release"
printf "  %s  ->  %s (%s bump)\n" "$CURRENT" "$NEXT" "$BUMP"
read -r -p "  Publish this release? [y/N] " ans
[ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "aborted — nothing changed"

# --- Bump, publish, push -----------------------------------------------------
step "Bump + tag"
npm version "$BUMP" -m "release: v%s"
NEW="$(node -p "require('./package.json').version")"

step "Publish v$NEW (enter your 2FA OTP when prompted)"
if ! npm publish; then
  die "publish failed. Your version bump + tag are LOCAL and unpushed. Fix the
     issue, then either re-run 'npm publish && git push origin main --follow-tags',
     or roll back with 'git reset --hard HEAD~1 && git tag -d v$NEW'."
fi

step "Push commit + tag"
git push origin main --follow-tags

printf '\n\033[1;32m✓ published standdown@%s and pushed v%s\033[0m\n' "$NEW" "$NEW"
