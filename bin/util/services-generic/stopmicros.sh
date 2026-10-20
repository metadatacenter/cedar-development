#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Stopping Dropwizard enabled CEDAR microservices
echo - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - 

shopt -s expand_aliases
source $CEDAR_UTIL_BIN/set-dev-aliases.sh

stoprepo
stopgroup
stopmessaging
stopresource
stopartifact
stopterminology
stopuser
stopworker
stopopenview
stopmonitor
stopimpex
stopbridge
