#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting MongoDB
echo --------------------------------------------------------------------------------
echo

source "$(dirname "${BASH_SOURCE[0]}")/../services-generic/wait-for-port.sh"

MONGO_PORT="${CEDAR_MONGO_PORT:-27017}"
MONGO_WAIT_SECONDS=60
MONGO_FORMULA=mongodb-community@5.0

if cedar_port_is_open "${MONGO_PORT}"; then
  echo "MongoDB is already accepting connections on port ${MONGO_PORT}."
  exit 0
fi

brew_prefix=$(brew --prefix 2>/dev/null)
mongod_bin="${brew_prefix}/opt/${MONGO_FORMULA}/bin/mongod"
mongod_conf="${brew_prefix}/etc/mongod.conf"

# Start it directly, for when Homebrew will not.
#
# MongoDB removed the end-of-life 5.0 formula from its own tap, so a machine whose tap has updated
# since can no longer resolve a service definition for it: `brew services start` answers "has not
# implemented #plist, #service or provided a locatable service file" while the installed keg -- the
# binaries, the configuration, the data directory and even the plist -- is entirely intact. CEDAR
# pins this version deliberately, so the answer is not to upgrade the server but to start the one
# that is installed. Every developer's machine hits this on its next tap update, and without a
# fallback the whole stack stops at Mongo with an error about Homebrew internals.
start_mongod_directly() {
  if [ ! -x "${mongod_bin}" ]; then
    echo "       No mongod to run at ${mongod_bin}" >&2
    return 1
  fi
  if [ ! -f "${mongod_conf}" ]; then
    echo "       No MongoDB configuration at ${mongod_conf}" >&2
    return 1
  fi
  echo "Homebrew could not start MongoDB; starting the installed server directly."
  "${mongod_bin}" --config "${mongod_conf}" --fork
}

if ! brew_message=$(brew services start "${MONGO_FORMULA}" 2>&1); then
  echo "${brew_message}" | tail -1 >&2
  start_mongod_directly || {
    echo "       MongoDB log: ${brew_prefix}/var/log/mongodb/mongo.log" >&2
    exit 1
  }
else
  echo "${brew_message}"
fi

# `brew services start` returns as soon as launchd forks mongod -- gate here so
# bring-up order stays safe for anything that connects next.
cedar_wait_for_port "MongoDB" "${MONGO_PORT}" "${MONGO_WAIT_SECONDS}" || {
  echo "       MongoDB log: ${brew_prefix}/var/log/mongodb/mongo.log" >&2
  exit 1
}
