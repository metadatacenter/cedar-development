#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting Neo4j
echo --------------------------------------------------------------------------------
echo

source "$(dirname "${BASH_SOURCE[0]}")/../services-generic/wait-for-port.sh"

# Gate on Bolt -- that is the port the microservices' drivers connect to. The
# browser/REST port (7474) comes up around the same time.
NEO4J_PORT="${CEDAR_NEO4J_BOLT_PORT:-7687}"
# A cold Neo4j is a JVM plus store recovery, so give it more headroom.
NEO4J_WAIT_SECONDS=120

if cedar_port_is_open "${NEO4J_PORT}"; then
  echo "Neo4j is already accepting connections on port ${NEO4J_PORT}."
  exit 0
fi

# `neo4j start` already detaches (it forks the JVM and returns), so the old
# trailing `&` bought nothing and only scrambled console output -- its "Started
# neo4j (pid:...)" line landed in the middle of the NEXT service's log.
${CEDAR_NEO4J_HOME}/bin/neo4j start

cedar_wait_for_port "Neo4j" "${NEO4J_PORT}" "${NEO4J_WAIT_SECONDS}" || {
  echo "       Neo4j log: ${CEDAR_NEO4J_HOME}/logs/neo4j.log" >&2
  exit 1
}
