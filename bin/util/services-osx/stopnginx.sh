#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping NginX
echo --------------------------------------------------------------------------------
echo

source "$(dirname "${BASH_SOURCE[0]}")/../services-generic/wait-for-port.sh"

NGINX_HTTP_PORT=80
NGINX_HTTPS_PORT=443

# `nginx -s stop` fails when no nginx is running, and its failure would fail the whole
# infrastructure stop.
if ! cedar_port_is_open "${NGINX_HTTP_PORT}" && ! cedar_port_is_open "${NGINX_HTTPS_PORT}"; then
  echo "NginX is not running."
  exit 0
fi

nginx -s stop
