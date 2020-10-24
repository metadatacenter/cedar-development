#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Starting CEDAR infrastructure services
echo --------------------------------------------------------------------------------
echo

shopt -s expand_aliases
source $CEDAR_UTIL_BIN/set-dev-aliases.sh

startmongo
startmysql
startelastic
startkibana
startneo
startredis
startrc
startkk
startnginx
