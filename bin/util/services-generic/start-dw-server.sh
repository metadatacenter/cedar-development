#!/bin/bash
echo --------------------------------------------------------------------------------
echo Starting CEDAR $1 server
echo - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - 

# CVE-2026-114938 (Java4Shell): keep the Base64 decode intrinsic off, as ops/cedar-services.sh does.
java \
  -XX:-UseBASE64Intrinsics ${CEDAR_JAVA_OPTS:-} \
  -jar $CEDAR_HOME/cedar-$1-server/cedar-$1-server-application/target/cedar-$1-server-application-${CEDAR_VERSION}.jar \
  server \
  "$CEDAR_HOME/cedar-$1-server/cedar-$1-server-application/src/main/resources/config.yml"
echo --------------------------------------------------------------------------------
echo
