#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Stopping CEDAR infrastructure services
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

stopmongo
killkk
stopelastic
stopkibana
stopneo
killrc
stopredis
stopmysql
stopnginx
