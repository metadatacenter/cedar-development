#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Stopping CEDAR infrastructure services
echo --------------------------------------------------------------------------------
echo

$CEDAR_UTIL_BIN/services/killkeycloak.sh
$CEDAR_UTIL_BIN/services//stopmongo.sh
$CEDAR_UTIL_BIN/services/stopelastic.sh
$CEDAR_UTIL_BIN/services/stopkibana.sh
$CEDAR_UTIL_BIN/services/stopneo.sh
$CEDAR_UTIL_BIN/services/killrediscommander.sh
$CEDAR_UTIL_BIN/services/stopredis.sh
$CEDAR_UTIL_BIN/services/stopmysql.sh
$CEDAR_UTIL_BIN/services/stopnginx.sh
