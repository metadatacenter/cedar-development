#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting Redis
echo --------------------------------------------------------------------------------
echo

source "$(dirname "${BASH_SOURCE[0]}")/../services-generic/wait-for-port.sh"

# One Redis, brew-managed. A second, non-persistent instance was configured for years and never
# started by anything; its configuration resolved to a placeholder in every service and its getter had
# no callers, so it was removed rather than repaired.
REDIS_PORT="${CEDAR_REDIS_PERSISTENT_PORT:-6379}"
REDIS_WAIT_SECONDS=30

if cedar_port_is_open "${REDIS_PORT}"; then
  echo "Redis is already accepting connections on port ${REDIS_PORT}."
  exit 0
fi

brew services start redis

cedar_wait_for_port "Redis" "${REDIS_PORT}" "${REDIS_WAIT_SECONDS}" || {
  echo "       Redis log: /opt/homebrew/var/log/redis.log" >&2
  exit 1
}
