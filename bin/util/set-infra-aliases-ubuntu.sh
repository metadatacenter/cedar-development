#!/bin/bash

#3rd party server aliases
alias startnginx='sudo $CEDAR_UTIL_BIN/services-ubuntu/startnginx.sh'
alias stopnginx='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopnginx.sh'

alias startmongo='sudo $CEDAR_UTIL_BIN/services-ubuntu/startmongo.sh'
alias stopmongo='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopmongo.sh'

alias startmysql='sudo $CEDAR_UTIL_BIN/services-ubuntu/startmysql.sh'
alias stopmysql='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopmysql.sh'

alias startsearch='sudo $CEDAR_UTIL_BIN/services-ubuntu/startopensearch.sh'
alias stopsearch='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopopensearch.sh'

alias startneo='sudo $CEDAR_UTIL_BIN/services-ubuntu/startneo.sh'
alias stopneo='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopneo.sh'

alias startredis='sudo $CEDAR_UTIL_BIN/services-ubuntu/startredis.sh'
alias stopredis='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopredis.sh'

#CEDAR server aliases
alias starteditor='goeditor && gulp'
alias stopeditor='echo "Frontend served by nginx, no need to kill"'
