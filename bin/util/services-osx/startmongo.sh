#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting MongoDB
echo --------------------------------------------------------------------------------
echo

source "$(dirname "${BASH_SOURCE[0]}")/../services-generic/wait-for-port.sh"

MONGO_PORT="${CEDAR_MONGO_PORT:-27017}"
MONGO_WAIT_SECONDS=60

if cedar_port_is_open "${MONGO_PORT}"; then
  echo "MongoDB is already accepting connections on port ${MONGO_PORT}."
  exit 0
fi

brew services start mongodb-community@5.0

# `brew services start` returns as soon as launchd forks mongod -- gate here so
# bring-up order stays safe for anything that connects next.
cedar_wait_for_port "MongoDB" "${MONGO_PORT}" "${MONGO_WAIT_SECONDS}" || {
  echo "       MongoDB log: /opt/homebrew/var/log/mongodb/mongo.log" >&2
  exit 1
}
