#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Starting CEDAR infrastructure services
echo --------------------------------------------------------------------------------
echo

shopt -s expand_aliases
source $CEDAR_UTIL_BIN/set-dev-aliases.sh

if uname -a | grep buntu > /dev/null 2>&1
  then
    source $CEDAR_UTIL_BIN/set-infra-aliases-ubuntu.sh
  else
    source $CEDAR_UTIL_BIN/set-infra-aliases-osx.sh
fi

startmongo
startmysql
startneo
startredis
startkk
startnginx
# OpenSearch last: its start script may poll brew for up to 30s before falling
# back to the libexec launcher (see services-osx/startopensearch.sh). Running it
# last lets the fast, well-behaved services come up during that wait instead of
# blocking behind it. Nothing else in infra depends on OpenSearch — only the
# microservices do, and they start later (startmicros).
startsearch
