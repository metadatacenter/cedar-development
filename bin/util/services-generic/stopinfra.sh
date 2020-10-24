#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Stopping CEDAR infrastructure services
echo --------------------------------------------------------------------------------
echo

shopt -s expand_aliases
source $CEDAR_UTIL_BIN/set-dev-aliases.sh

killkk
stopmongo
stopelastic
stopkibana
stopneo
killrc
stopredis
stopmysql
stopnginx
