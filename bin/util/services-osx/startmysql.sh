#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting MySQL
echo --------------------------------------------------------------------------------
echo

source "$(dirname "${BASH_SOURCE[0]}")/../services-generic/wait-for-port.sh"

MYSQL_PORT="${CEDAR_KEYCLOAK_MYSQL_PORT:-3306}"
# A cold mysqld needs a few seconds (InnoDB recovery) before it binds the port.
MYSQL_WAIT_SECONDS=60
# The 8.4 LTS line the images pin and Keycloak supports. The unversioned `mysql` formula follows
# MySQL's Innovation releases across major versions, which the version lock forbids.
MYSQL_FORMULA=mysql@8.4

if cedar_port_is_open "${MYSQL_PORT}"; then
  echo "MySQL is already accepting connections on port ${MYSQL_PORT}."
  exit 0
fi

brew_prefix=$(brew --prefix 2>/dev/null)
if [ ! -x "${brew_prefix}/opt/${MYSQL_FORMULA}/bin/mysqld" ]; then
  echo "ERROR: ${MYSQL_FORMULA} is not installed. An 8.4 server cannot open a newer data directory," >&2
  echo "       so move to it by dump and restore: BACKEND-RUNBOOK.md, \"Dependency and Framework State\"." >&2
  exit 1
fi

brew services start "${MYSQL_FORMULA}"

# Keycloak (startkk) aborts startup on a refused JDBC connection, so this must
# not return until MySQL answers. See wait-for-port.sh for the full story.
cedar_wait_for_port "MySQL" "${MYSQL_PORT}" "${MYSQL_WAIT_SECONDS}" || {
  echo "       MySQL log: /opt/homebrew/var/mysql/*.err" >&2
  exit 1
}
