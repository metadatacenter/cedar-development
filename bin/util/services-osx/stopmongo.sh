#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping MongoDB
echo --------------------------------------------------------------------------------
echo

MONGO_FORMULA=mongodb-community@5.0

brew services stop "${MONGO_FORMULA}" 2>/dev/null

# Stop one this installation started itself.
#
# startmongo.sh falls back to running mongod directly when Homebrew has no service definition for
# the pinned version, and `brew services stop` knows nothing about that process. Without this the
# stop reports success and leaves the server running, so the next start finds the port already open
# and reports a MongoDB nobody asked for.
pid=$(pgrep -f "${MONGO_FORMULA}/bin/mongod --config" 2>/dev/null | head -1)
if [ -n "${pid}" ]; then
  echo "Stopping the MongoDB this installation started directly (PID ${pid})."
  kill "${pid}" 2>/dev/null
fi
