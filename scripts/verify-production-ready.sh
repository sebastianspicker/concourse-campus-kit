#!/usr/bin/env bash
# Runs the complete source-alpha gate and fails closed on public-tree or scanner errors.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node scripts/verify-public-tree.mjs
pnpm test:tools
pnpm check:architecture

if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  pnpm install --frozen-lockfile
fi
pnpm release:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build

if [[ "${SKIP_MARKER_CHECK:-}" != "1" ]]; then
  # Scans tracked and untracked non-ignored files; docs may name the markers.
  set +e
  git grep --untracked -n -w -E 'TODO|FIXME|SKELETON|PLACEHOLDER|TBD' -- \
    ':!docs/**' ':!scripts/verify-production-ready.sh'
  marker_status=$?
  set -e
  if (( marker_status == 0 )); then
    echo
    echo "Found TODO/FIXME/SKELETON/PLACEHOLDER/TBD markers. Resolve or document as \"won't do\"."
    exit 1
  elif (( marker_status != 1 )); then
    echo "Marker scan failed with status ${marker_status}."
    exit "$marker_status"
  fi
fi

echo "OK: source-alpha release gate passed."
