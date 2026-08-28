#!/bin/bash

# Build one extracted AngularJS frontend for a native nginx host. The environment-specific Gulp
# build exits in server mode; nginx serves the resulting app tree directly. No Docker is involved.

set -euo pipefail

: "${CEDAR_HOME:?CEDAR_HOME must point to the CEDAR checkout root}"
: "${CEDAR_WORKSPACE_FRONTEND_URL:?set the exact Workspace HTTPS origin}"
: "${CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL:?set the exact Designer HTTPS origin}"

if [[ "${CEDAR_FRONTEND_BEHAVIOR:-}" != "server" ]]; then
  echo "CEDAR_FRONTEND_BEHAVIOR must be server for a native static payload" >&2
  exit 1
fi

case "${1:-}" in
  workspace) repo=cedar-workspace ;;
  designer) repo=cedar-template-designer ;;
  *) echo "Usage: $0 <workspace|designer>" >&2; exit 2 ;;
esac

root="${CEDAR_HOME}/${repo}"
source_commit=$(git -C "$root" rev-parse --verify HEAD)
if [[ -n "$(git -C "$root" status --porcelain --untracked-files=normal)" ]]; then
  echo "$repo checkout is dirty; refusing to generate an acceptance payload" >&2
  exit 1
fi

cd "$root"
npm ci
CEDAR_SOURCE_COMMIT="$source_commit" npx gulp
node "$CEDAR_HOME/cedar-development/ops/write-native-frontend-build-info.mjs" \
  "$1" "$source_commit" false
