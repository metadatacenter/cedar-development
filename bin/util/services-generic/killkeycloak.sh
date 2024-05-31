#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping Keycloak Server
echo --------------------------------------------------------------------------------
echo

echo Keycloak processes:
ps ax | grep "[Q]uarkusEntryPoint"

echo Kill them all:
kill `ps ax | grep "[Q]uarkusEntryPoint" | awk '{print $1}'`
