#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Starting CEDAR infrastructure services
echo --------------------------------------------------------------------------------
echo

$CEDAR_UTIL_BIN/services/startmongo.sh
$CEDAR_UTIL_BIN/services/startmysql.sh
$CEDAR_UTIL_BIN/services/startelastic.sh
$CEDAR_UTIL_BIN/services/startkibana.sh
$CEDAR_UTIL_BIN/services/startneo.sh
$CEDAR_UTIL_BIN/services/startredis.sh
$CEDAR_UTIL_BIN/services/startrediscommander.sh
$CEDAR_UTIL_BIN/services/startkeycloak.sh
$CEDAR_UTIL_BIN/services/startnginx.sh
