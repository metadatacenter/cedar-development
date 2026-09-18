#!/bin/bash

# Build one frontend's served payload for a native nginx host. The environment-specific frontend
# build exits in server mode; nginx serves the resulting app tree directly. No Docker is involved.
#
# Covers the monolith as well as the two split applications. The monolith was built by hand on every
# deploy -- `npm ci`, `npx gulp`, then a `touch` of version.js -- for no reason other than that
# nothing here accepted it, which also left it the one served payload with no build-info identity.

set -euo pipefail

: "${CEDAR_HOME:?CEDAR_HOME must point to the CEDAR checkout root}"

if [[ "${CEDAR_FRONTEND_BEHAVIOR:-}" != "server" ]]; then
  echo "CEDAR_FRONTEND_BEHAVIOR must be server for a native static payload" >&2
  exit 1
fi

case "${1:-}" in
  workspace) repo=cedar-workspace ;;
  designer) repo=cedar-template-designer ;;
  editor) repo=cedar-template-editor ;;
  *) echo "Usage: $0 <workspace|designer|editor>" >&2; exit 2 ;;
esac

# These two origins are compiled into the Workspace and Designer payloads. The monolith consumes
# neither, so requiring them for every target would block the build that cannot use them.
if [[ "$1" != editor ]]; then
  : "${CEDAR_WORKSPACE_FRONTEND_URL:?set the exact Workspace HTTPS origin}"
  : "${CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL:?set the exact Designer HTTPS origin}"
fi

root="${CEDAR_HOME}/${repo}"
source_commit=$(git -C "$root" rev-parse --verify HEAD)
if [[ -n "$(git -C "$root" status --porcelain --untracked-files=normal)" ]]; then
  echo "$repo checkout is dirty; refusing to generate an acceptance payload" >&2
  exit 1
fi

cd "$root"
npm ci
if [[ "$1" == workspace ]]; then
  CEDAR_SOURCE_COMMIT="$source_commit" npm run build:deployment
else
  CEDAR_SOURCE_COMMIT="$source_commit" npx gulp
fi

# Gulp preserves the mtime of app/config/version.js, so a client that already holds it revalidates
# and is answered 304 -- it keeps the previous bundle however clean the build was. The version
# modifier exists to defeat that, and cannot while the file looks unchanged to a conditional
# request. Doing it here is what stops it being a step somebody has to remember.
version_js="$root/app/config/version.js"
if [[ -f "$version_js" ]]; then
  touch "$version_js"
fi

node "$CEDAR_HOME/cedar-development/ops/write-native-frontend-build-info.mjs" \
  "$1" "$source_commit" false
