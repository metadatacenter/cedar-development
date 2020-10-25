#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting Keycloak Server
echo --------------------------------------------------------------------------------
echo

${CEDAR_KEYCLOAK_HOME}/bin/standalone.sh &
