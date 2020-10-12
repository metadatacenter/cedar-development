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
stopschema
stopartifact
stopterminology
stopuser
stopvaluerecommender
stopsubmission
stopworker
stopopenview
stopinternals
