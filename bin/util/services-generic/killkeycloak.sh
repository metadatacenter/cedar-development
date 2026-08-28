#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping Keycloak Server
echo --------------------------------------------------------------------------------
echo

if [ -z "$CEDAR_KEYCLOAK_HOME" ]; then
  echo "CEDAR_KEYCLOAK_HOME is not defined; refusing to search for processes." >&2
  exit 1
fi

echo CEDAR Keycloak processes:
pids=""
for pid in $(ps ax -o pid=,command= | awk '/[Q]uarkusEntryPoint/ {print $1}'); do
  command=$(ps -p "$pid" -o command= 2>/dev/null)
  case "$command" in
    *"$CEDAR_KEYCLOAK_HOME"*) pids="$pids $pid" ;;
    *) echo "Ignoring unrelated Quarkus process $pid: $command" ;;
  esac
done
if [ -z "$pids" ]; then
  echo "No CEDAR Keycloak process is running."
  exit 0
fi
ps -p $pids -o pid=,stat=,command=

echo Stopping CEDAR Keycloak:
kill $pids
