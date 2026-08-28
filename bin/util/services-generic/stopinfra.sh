#!/bin/bash
[ -t 1 ] && clear
echo --------------------------------------------------------------------------------
echo Stopping CEDAR infrastructure services
echo --------------------------------------------------------------------------------
echo

shopt -s expand_aliases
source $CEDAR_UTIL_BIN/set-dev-aliases.sh

# Retire jobs created by the former launchd experiment before invoking the normal native stop
# commands. Submitted KeepAlive jobs otherwise relaunch Keycloak and Neo4j as soon as they exit.
if [ "$(uname -s)" = Darwin ]; then
  for name in keycloak neo4j; do
    label="org.metadatacenter.cedar.native.${name}"
    if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
      launchctl remove "${label}" >/dev/null 2>&1 || true
    fi
  done
fi

if uname -a | grep buntu > /dev/null 2>&1
  then
    source $CEDAR_UTIL_BIN/set-infra-aliases-ubuntu.sh
  else
    source $CEDAR_UTIL_BIN/set-infra-aliases-osx.sh
fi

CEDAR_INFRA_FAILED=0
stopmongo || CEDAR_INFRA_FAILED=1
killkk || CEDAR_INFRA_FAILED=1
stopsearch || CEDAR_INFRA_FAILED=1
stopneo || CEDAR_INFRA_FAILED=1
stopredis || CEDAR_INFRA_FAILED=1
stopmysql || CEDAR_INFRA_FAILED=1
stopnginx || CEDAR_INFRA_FAILED=1
exit "${CEDAR_INFRA_FAILED}"
