#!/bin/bash
echo --------------------------------------------------------------------------------
echo Stopping Keycloak Server
echo --------------------------------------------------------------------------------
echo

echo Keycloak processes:
ps ax | grep "QuarkusEntryPoint"

echo Kill them all:
kill `ps ax | grep "QuarkusEntryPoint" | awk '{print $1}'`
