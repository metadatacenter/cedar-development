#!/bin/bash

# Install the canonical macOS frontend virtual hosts. Native development deliberately serves every
# frontend response as no-store: source trees and ng/gulp development servers use stable filenames,
# so allowing the browser to retain them can mix JavaScript from different checkouts.

set -euo pipefail

: "${CEDAR_HOME:?CEDAR_HOME must point to the CEDAR checkout root}"

nginx_root="${CEDAR_LOCAL_NGINX_ROOT:-/opt/homebrew/etc/nginx/cedar}"
mirror_root="${CEDAR_HOME}/cedar-development/os-mirror/development-macos/opt/homebrew/etc/nginx/cedar"
frontends=(cedar workspace designer openview content monitoring bridging)

temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT

for frontend in "${frontends[@]}"; do
  source_conf="${mirror_root}/domains/frontend-${frontend}.inc.conf"
  target_conf="${nginx_root}/domains/frontend-${frontend}.inc.conf"
  rendered_conf="${temporary_directory}/frontend-${frontend}.inc.conf"
  test -f "$source_conf" || { echo "Missing nginx include: $source_conf" >&2; exit 1; }
  test -f "$target_conf" || { echo "Missing installed nginx include: $target_conf" >&2; exit 1; }
  sed "s|/Users/cedar-dev/CEDAR|${CEDAR_HOME}|g" "$source_conf" > "$rendered_conf"
  install -m 0644 "$rendered_conf" "$target_conf"
done

if sudo -n nginx -t >/dev/null 2>&1; then
  sudo -n nginx -s reload
else
  nginx_test_output=$(nginx -t 2>&1 || true)
  printf '%s\n' "$nginx_test_output"
  grep -Fq "syntax is ok" <<< "$nginx_test_output" || {
    echo "nginx configuration validation failed; nginx was not restarted" >&2
    exit 1
  }

  stop_nginx="${CEDAR_HOME}/cedar-development/bin/util/services-osx/stopnginx.sh"
  start_nginx="${CEDAR_HOME}/cedar-development/bin/util/services-osx/startnginx.sh"
  test -x "$stop_nginx" || { echo "Missing nginx stop helper: $stop_nginx" >&2; exit 1; }
  test -x "$start_nginx" || { echo "Missing nginx start helper: $start_nginx" >&2; exit 1; }
  sudo -n "$stop_nginx"
  sudo -n "$start_nginx"
fi

echo "Installed no-store policy for local CEDAR frontend origins."
