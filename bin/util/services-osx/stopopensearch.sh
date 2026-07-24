#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping Opensearch
echo --------------------------------------------------------------------------------
echo

OS_PIDFILE="${CEDAR_HOME:-$HOME}/log/opensearch-fallback.pid"

# Stop the brew-managed service (no-op if it was never started that way).
brew services stop opensearch

# Also stop a directly-launched (fallback) instance, if we started one.
if [ -f "${OS_PIDFILE}" ]; then
  OS_PID="$(cat "${OS_PIDFILE}")"
  if [ -n "${OS_PID}" ] && kill -0 "${OS_PID}" 2>/dev/null; then
    echo "Stopping fallback OpenSearch (pid ${OS_PID})."
    kill "${OS_PID}" 2>/dev/null
  fi
  rm -f "${OS_PIDFILE}"
fi
