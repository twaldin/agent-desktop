#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?Repository required}"
: "${GITHUB_SHA:?Commit required}"
: "${RELEASE_TAG:?Tag required}"
: "${RELEASE_VERSION:?Version required}"
artifact_directory=${1:?Artifact directory required}
notes=${2:?Release notes required}

if ! gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
  gh release create "$RELEASE_TAG" --target "$GITHUB_SHA" --draft --prerelease \
    --title "Agent Desktop $RELEASE_VERSION" --notes-file "$notes"
fi

# Resolve annotated and lightweight tags through the commits endpoint. An existing
# release is not evidence that it belongs to this commit or has complete assets.
actual_commit=$(gh api "repos/$GH_REPO/commits/$RELEASE_TAG" --jq .sha)
[[ "$actual_commit" == "$GITHUB_SHA" ]] || { echo "Release tag points to another commit." >&2; exit 1; }
existing=$(gh release view "$RELEASE_TAG" --json assets --jq '.assets[].name')
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
shopt -s nullglob
files=("$artifact_directory"/*)
((${#files[@]} > 0)) || { echo "No release artifacts." >&2; exit 1; }
for file in "${files[@]}"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "Invalid release artifact." >&2; exit 1; }
  name=$(basename "$file")
  if grep -Fxq -- "$name" <<< "$existing"; then
    gh release download "$RELEASE_TAG" --pattern "$name" --dir "$temporary"
    cmp "$file" "$temporary/$name" || { echo "Existing asset differs; use a new version, never overwrite." >&2; exit 1; }
  else
    gh release upload "$RELEASE_TAG" "$file"
  fi
done
gh release edit "$RELEASE_TAG" --draft=false --prerelease --latest=false \
  --title "Agent Desktop $RELEASE_VERSION" --notes-file "$notes"
