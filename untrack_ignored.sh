#!/usr/bin/env bash
set -euo pipefail

# Run at repo root
echo "==== Tracked files that are now ignored (preview) ===="
git ls-files -ci --exclude-standard

echo
echo "==== Removing them from the index (keeping files on disk) ===="
git ls-files -ci --exclude-standard -z \
  | xargs -0 -r git rm -r --cached --ignore-unmatch

echo
echo "==== Status ===="
git status --porcelain

echo
echo "Next:"
echo "  git commit -m \"chore: stop tracking ignored build artifacts\""
