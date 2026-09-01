#!/bin/bash

# Install the two local split-frontend leaves and nginx virtual hosts. The
# production-equivalent cedar.metadatacenter.orgx virtual host is not modified.

set -euo pipefail

: "${CEDAR_HOME:?CEDAR_HOME must point to the CEDAR checkout root}"
: "${CEDAR_CA_HOME:?source cedar-development/bin/templates/cedar-profile-native.sh first}"

nginx_root="${CEDAR_LOCAL_NGINX_ROOT:-/opt/homebrew/etc/nginx/cedar}"
mirror_root="${CEDAR_HOME}/cedar-development/os-mirror/development-macos/opt/homebrew/etc/nginx/cedar"
hosts=(workspace.metadatacenter.orgx designer.metadatacenter.orgx)

mkdir -p "${CEDAR_HOME}/log/frontend-workspace" \
  "${CEDAR_HOME}/log/frontend-template-designer"

for host in "${hosts[@]}"; do
  short_name="${host%%.*}"
  source_cert_dir="${CEDAR_CA_HOME}/certs/${host}"
  target_cert_dir="${nginx_root}/ssl/${host}"
  source_conf="${mirror_root}/domains/frontend-${short_name}.inc.conf"
  target_conf="${nginx_root}/domains/frontend-${short_name}.inc.conf"
  cert="${source_cert_dir}/${host}.crt"
  key="${source_cert_dir}/${host}.key"

  test -f "$source_conf" || { echo "Missing nginx include: $source_conf" >&2; exit 1; }
  test -f "$cert" || { echo "Missing certificate: $cert" >&2; exit 1; }
  test -f "$key" || { echo "Missing private key: $key" >&2; exit 1; }
  openssl x509 -checkend 86400 -noout -in "$cert"
  openssl x509 -noout -ext subjectAltName -in "$cert" | grep -Fq "DNS:${host}"
  openssl verify -CAfile "${CEDAR_CA_HOME}/ca.crt" "$cert"

  mkdir -p "$target_cert_dir"
  install -m 0644 "$cert" "${target_cert_dir}/${host}.crt"
  install -m 0600 "$key" "${target_cert_dir}/${host}.key"

  temporary_conf=$(mktemp)
  sed "s|/Users/cedar-dev/CEDAR|${CEDAR_HOME}|g" "$source_conf" > "$temporary_conf"
  install -m 0644 "$temporary_conf" "$target_conf"
  rm -f "$temporary_conf"
done

if sudo -n nginx -t >/dev/null 2>&1; then
  sudo -n nginx -s reload
else
  # The development sudoers profile grants only the scoped CEDAR service
  # helpers. An unprivileged nginx test can still prove that parsing reached
  # "syntax is ok" before it fails while opening the root-owned pid file.
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

echo "Installed local split frontend TLS and nginx routing:"
printf '  https://%s\n' "${hosts[@]}"
