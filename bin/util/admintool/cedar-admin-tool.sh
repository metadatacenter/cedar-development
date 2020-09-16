#!/bin/sh
echo ----------------------------------------------
echo Launching CEDAR Admin Tool ${CEDAR_VERSION}
echo ----------------------------------------------
echo

java -jar $CEDAR_HOME/cedar-admin-tool/target/cedar-admin-tool-${CEDAR_VERSION}.jar "$@"
