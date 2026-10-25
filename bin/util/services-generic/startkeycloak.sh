#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting Keycloak Server
echo --------------------------------------------------------------------------------
echo

if [ -z "$CEDAR_KEYCLOAK_HOME" ]; then
  echo "CEDAR_KEYCLOAK_HOME is not defined." >&2
  exit 1
fi

# The CLI captures this script's output. A background JVM must not retain that pipe or the
# command waits forever for EOF and cancellation kills the otherwise healthy Keycloak process.
keycloak_console_log="$CEDAR_KEYCLOAK_HOME/log/cedar-console.log"
mkdir -p "$(dirname "$keycloak_console_log")" || exit 1
nohup "$CEDAR_KEYCLOAK_HOME/bin/kc.sh" start </dev/null >>"$keycloak_console_log" 2>&1 &
echo "Keycloak starting; console log: $keycloak_console_log"
