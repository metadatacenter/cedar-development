#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping Opensearch
echo --------------------------------------------------------------------------------
echo

OS_PIDFILE="${CEDAR_HOME:-$HOME}/log/opensearch-fallback.pid"
OS_STOP_FAILED=0
OS_PREFIX="$(brew --prefix opensearch 2>/dev/null)"

# Stop the brew-managed service (no-op if it was never started that way).
brew services stop opensearch

# Also stop a directly-launched (fallback) instance, if we started one.
if [ -f "${OS_PIDFILE}" ]; then
  OS_PID="$(cat "${OS_PIDFILE}")"
  if [ -n "${OS_PID}" ] && kill -0 "${OS_PID}" 2>/dev/null; then
    OS_COMMAND="$(ps -p "${OS_PID}" -o command= 2>/dev/null)"
    if [ -z "${OS_PREFIX}" ]; then
      echo "Refusing to stop pid ${OS_PID}; the expected Homebrew OpenSearch path is unknown." >&2
      OS_STOP_FAILED=1
    else
      case "${OS_COMMAND}" in
        *"${OS_PREFIX}"*opensearch*|*"${OS_PREFIX}"*org.opensearch.bootstrap.OpenSearch*)
          echo "Stopping fallback OpenSearch (pid ${OS_PID})."
          kill "${OS_PID}" 2>/dev/null
          ;;
        *)
          echo "Refusing to stop stale pid ${OS_PID}; it is not CEDAR's OpenSearch: ${OS_COMMAND}" >&2
          OS_STOP_FAILED=1
          ;;
      esac
    fi
  fi
  rm -f "${OS_PIDFILE}"
fi
exit "${OS_STOP_FAILED}"
