#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting NginX
echo --------------------------------------------------------------------------------
echo

source "$(dirname "${BASH_SOURCE[0]}")/../services-generic/wait-for-port.sh"

NGINX_HTTP_PORT=80
NGINX_HTTPS_PORT=443

# A second nginx cannot bind the ports the first one holds, and its failure would fail the whole
# infrastructure start.
if cedar_port_is_open "${NGINX_HTTP_PORT}" && cedar_port_is_open "${NGINX_HTTPS_PORT}"; then
  echo "NginX is already accepting connections on ports ${NGINX_HTTP_PORT} and ${NGINX_HTTPS_PORT}."
  exit 0
fi

nginx
