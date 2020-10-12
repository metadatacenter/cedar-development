#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping Keycloak Server
echo --------------------------------------------------------------------------------
echo

echo Keycloak processes:
ps ax | grep "[k]eycloak/standalone"

echo Kill them all:
kill `ps ax | grep "[k]eycloak/standalone" | awk '{print $1}'`