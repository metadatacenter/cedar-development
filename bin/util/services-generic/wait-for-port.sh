#!/bin/bash
#
# Shared readiness gate for the infrastructure start scripts.
#
# Source this, then call cedar_wait_for_port to block until a service actually
# accepts connections:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/../services-generic/wait-for-port.sh"
#   cedar_wait_for_port "MySQL" 3306 60 || exit 1
#
# WHY THIS EXISTS
# ---------------
# Every launcher we use returns before its service is reachable: `brew services
# start X` returns as soon as launchd forks the daemon, and `neo4j start` returns
# as soon as the JVM is spawned. A start script that returns at that point is
# lying to whatever runs next.
#
# That bit us on 2026-07-31: startinfra.sh runs `startmysql` and then `startkk`,
# and Keycloak fails HARD on a refused JDBC connection (Agroal gives up after
# ~3s, Quarkus aborts with "Failed to obtain JDBC connection"). MySQL needed
# ~4.3s to bind 3306, so Keycloak lost the race by 0.8s. It had worked only
# because startopensearch.sh's up-to-30s brew poll happened to sit between them
# in the start order; reordering the list removed that accidental delay.
#
# So: gate inside each start script, never rely on a later service's own wait to
# provide the delay, and reordering startinfra.sh stays safe by construction.

# Return 0 if something accepts a TCP connection on host:port.
# Prefers nc; falls back to bash's /dev/tcp where nc is absent.
cedar_port_is_open() {
  local port="$1" host="${2:-127.0.0.1}"
  if command -v nc > /dev/null 2>&1; then
    nc -z -w 1 "${host}" "${port}" > /dev/null 2>&1
  else
    (exec 3<> "/dev/tcp/${host}/${port}") > /dev/null 2>&1
  fi
}

# cedar_wait_for_port <label> <port> [timeout_seconds] [host]
#
# Polls once a second until the port answers. Returns 0 as soon as it does, or 1
# on timeout (after printing an error to stderr). Callers decide whether a
# timeout is fatal.
cedar_wait_for_port() {
  local label="$1" port="$2" timeout="${3:-60}" host="${4:-127.0.0.1}"
  local waited=0

  echo "Waiting up to ${timeout}s for ${label} on port ${port}..."
  while [ "${waited}" -lt "${timeout}" ]; do
    if cedar_port_is_open "${port}" "${host}"; then
      echo "${label} is up on port ${port}."
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "ERROR: ${label} did not come up on port ${port} within ${timeout}s." >&2
  echo "       Services depending on it will fail to start -- check its log." >&2
  return 1
}
