#!/bin/bash

#3rd party server aliases
alias startnginx='sudo $CEDAR_UTIL_BIN/services-ubuntu/startnginx.sh'
alias stopnginx='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopnginx.sh'

alias startmongo='sudo $CEDAR_UTIL_BIN/services-ubuntu/startmongo.sh'
alias stopmongo='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopmongo.sh'

alias startmysql='sudo $CEDAR_UTIL_BIN/services-ubuntu/startmysql.sh'
alias stopmysql='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopmysql.sh'

alias startkibana='sudo $CEDAR_UTIL_BIN/services-ubuntu/startkibana.sh'
alias stopkibana='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopkibana.sh'

alias startsearch='sudo $CEDAR_UTIL_BIN/services-ubuntu/startelastic.sh'
alias stopsearch='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopelastic.sh'

alias startneo='sudo $CEDAR_UTIL_BIN/services-ubuntu/startneo.sh'
alias stopneo='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopneo.sh'

alias startredis='sudo $CEDAR_UTIL_BIN/services-ubuntu/startredis.sh'
alias stopredis='sudo $CEDAR_UTIL_BIN/services-ubuntu/stopredis.sh'

alias startrc='sudo $CEDAR_UTIL_BIN/services-ubuntu/startrediscommander.sh'
alias killrc='sudo $CEDAR_UTIL_BIN/services-ubuntu/killrediscommander.sh'

#CEDAR server aliases
alias starteditor='goeditor && gulp'
alias stopeditor='echo "Frontend served by nginx, no need to kill"'
