#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting Opensearch
echo --------------------------------------------------------------------------------
echo

# Where we track a directly-launched (fallback) OpenSearch process.
OS_PIDFILE="${CEDAR_HOME:-$HOME}/log/opensearch-fallback.pid"
OS_LOGFILE="${CEDAR_HOME:-$HOME}/log/opensearch-fallback.log"
OS_PORT=9200
# How long to wait for the brew-managed service before giving up on it.
OS_WAIT_SECONDS=30
# A cold OpenSearch JVM can take longer than that to bind the port, so give the
# direct-launch fallback more headroom.
OS_FALLBACK_WAIT_SECONDS=90

# Return 0 once OpenSearch answers on the REST port.
opensearch_is_up() {
  curl -s -o /dev/null "http://localhost:${OS_PORT}" 2>/dev/null
}

wait_for_opensearch() {
  local timeout="${1:-${OS_WAIT_SECONDS}}"
  local waited=0
  while [ "${waited}" -lt "${timeout}" ]; do
    if opensearch_is_up; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# If it is already up (e.g. started by a previous run), do nothing.
if opensearch_is_up; then
  echo "OpenSearch is already running on port ${OS_PORT}."
  exit 0
fi

# Preferred path: let Homebrew manage it via launchd.
echo "Attempting: brew services start opensearch"
brew services start opensearch

echo "Waiting up to ${OS_WAIT_SECONDS}s for OpenSearch on port ${OS_PORT}..."
if wait_for_opensearch; then
  echo "OpenSearch is up (started via brew services)."
  exit 0
fi

echo
echo "brew services did not bring OpenSearch up; falling back to launching the binary directly."

# Resolve the binary without hardcoding a version.
#
# IMPORTANT: prefer the real launcher under libexec/, NOT the "bin/opensearch"
# wrapper Homebrew puts on the PATH. That wrapper hardcodes
# JAVA_HOME=/opt/homebrew/opt/openjdk, which tracks Homebrew's latest openjdk
# (currently Java 26). OpenSearch 2.18 needs the Java Security Manager, which
# newer JDKs no longer allow, so the wrapper crashes on startup. Calling the
# libexec launcher directly lets OpenSearch inherit the ambient (jenv) JDK 17 --
# this is exactly what a manual `.../libexec/bin/opensearch &` launch does.
OS_BIN=""
if command -v brew > /dev/null 2>&1; then
  OS_PREFIX="$(brew --prefix opensearch 2>/dev/null)"
  if [ -n "${OS_PREFIX}" ] && [ -x "${OS_PREFIX}/libexec/bin/opensearch" ]; then
    OS_BIN="${OS_PREFIX}/libexec/bin/opensearch"
  elif [ -n "${OS_PREFIX}" ] && [ -x "${OS_PREFIX}/bin/opensearch" ]; then
    OS_BIN="${OS_PREFIX}/bin/opensearch"
  fi
fi
if [ -z "${OS_BIN}" ] && command -v opensearch > /dev/null 2>&1; then
  OS_BIN="$(command -v opensearch)"
fi

if [ -z "${OS_BIN}" ]; then
  echo "ERROR: could not locate an opensearch binary (tried 'brew --prefix opensearch' and PATH)." >&2
  exit 1
fi

# The libexec launcher does not fall back to the `java` on PATH -- it needs a
# JDK via OPENSEARCH_JAVA_HOME / JAVA_HOME. Resolve one that actually works with
# OpenSearch 2.18 (JDK 17), preferring whatever the caller already set, then the
# active jenv JDK, then a JDK 17 located via java_home.
is_usable_jdk() {
  [ -n "$1" ] && [ -x "$1/bin/java" ]
}

if is_usable_jdk "${OPENSEARCH_JAVA_HOME}"; then
  : # honor an explicit OPENSEARCH_JAVA_HOME
elif is_usable_jdk "${JAVA_HOME}"; then
  export OPENSEARCH_JAVA_HOME="${JAVA_HOME}"
elif command -v jenv > /dev/null 2>&1 && is_usable_jdk "$(jenv javahome 2>/dev/null)"; then
  export OPENSEARCH_JAVA_HOME="$(jenv javahome 2>/dev/null)"
elif [ -x /usr/libexec/java_home ] && is_usable_jdk "$(/usr/libexec/java_home -v 17 2>/dev/null)"; then
  export OPENSEARCH_JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null)"
fi

if is_usable_jdk "${OPENSEARCH_JAVA_HOME}"; then
  echo "Using JDK at ${OPENSEARCH_JAVA_HOME}"
else
  echo "WARNING: no JDK resolved for the fallback; relying on the launcher's own default." >&2
fi

# Make sure the log dir exists, then launch detached so it survives this shell/tab.
mkdir -p "$(dirname "${OS_LOGFILE}")"
echo "Launching ${OS_BIN} (logs: ${OS_LOGFILE})"
nohup "${OS_BIN}" > "${OS_LOGFILE}" 2>&1 &
echo $! > "${OS_PIDFILE}"

echo "Waiting up to ${OS_FALLBACK_WAIT_SECONDS}s for OpenSearch on port ${OS_PORT}..."
if wait_for_opensearch "${OS_FALLBACK_WAIT_SECONDS}"; then
  echo "OpenSearch is up (started directly, pid $(cat "${OS_PIDFILE}"))."
  exit 0
fi

echo "ERROR: OpenSearch did not come up on port ${OS_PORT} via fallback. Check ${OS_LOGFILE}." >&2
exit 1
