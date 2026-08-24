#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping Keycloak Server
echo --------------------------------------------------------------------------------
echo

echo Keycloak processes:
pids=$(ps ax | grep "[Q]uarkusEntryPoint" | awk '{print $1}')
if [ -z "$pids" ]; then
  echo "No Keycloak process is running."
  exit 0
fi
ps -p $pids -o pid=,stat=,command=

echo Kill them all:
kill $pids
