#!/usr/bin/env bash
# Cut a release: verify, test, pack-check, publish, tag, push.
#
#   npm login        # once, or export NODE_AUTH_TOKEN / write ~/.npmrc
#   bash scripts/release.sh
#
# The tag push triggers .github/workflows/release.yml, which publishes nothing
# (this script already did) and creates the GitHub Release from
# docs/RELEASE-<tag>.md.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "releasing dsh-hermes-facade $VERSION from $BRANCH"

if [ "$BRANCH" != "main" ]; then
  echo "error: release from main, not $BRANCH" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty; commit first" >&2
  exit 1
fi
if [ ! -f "docs/RELEASE-$TAG.md" ]; then
  echo "warning: docs/RELEASE-$TAG.md is missing; the GitHub Release will use generated notes" >&2
fi

echo "--- check"
npm run check
echo "--- test"
npm test
echo "--- pack contents"
npm pack --dry-run 2>&1 | tail -25

if npm view "dsh-hermes-facade@$VERSION" version >/dev/null 2>&1; then
  echo "npm already has $VERSION; skipping publish"
else
  echo "--- publish"
  npm publish --access public
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "tag $TAG already exists"
else
  git tag -a "$TAG" -m "dsh-hermes-facade $VERSION"
fi
git push origin "$TAG"
echo "released $TAG"
