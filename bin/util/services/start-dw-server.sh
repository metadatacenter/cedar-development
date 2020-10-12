#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting CEDAR $1 server
echo - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - 

java \
  -jar $CEDAR_HOME/cedar-$1-server/cedar-$1-server-application/target/cedar-$1-server-application-${CEDAR_VERSION}.jar \
  server \
  "$CEDAR_HOME/cedar-$1-server/cedar-$1-server-application/src/main/resources/config.yml"
echo --------------------------------------------------------------------------------
echo