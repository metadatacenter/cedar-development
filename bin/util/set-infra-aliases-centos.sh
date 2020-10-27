#!/bin/bash

#3rd party server aliases
alias startnginx='sudo $CEDAR_UTIL_BIN/services-centos/startnginx.sh'
alias stopnginx='sudo $CEDAR_UTIL_BIN/services-centos/stopnginx.sh'

alias startmongo='sudo $CEDAR_UTIL_BIN/services-centos/startmongo.sh'
alias stopmongo='sudo $CEDAR_UTIL_BIN/services-centos/stopmongo.sh'

alias startmysql='sudo $CEDAR_UTIL_BIN/services-centos/startmysql.sh'
alias stopmysql='sudo $CEDAR_UTIL_BIN/services-centos/stopmysql.sh'

alias startkibana='sudo $CEDAR_UTIL_BIN/services-centos/startkibana.sh'
alias stopkibana='sudo $CEDAR_UTIL_BIN/services-centos/stopkibana.sh'

alias startelastic='sudo $CEDAR_UTIL_BIN/services-centos/startelastic.sh'
alias stopelastic='sudo $CEDAR_UTIL_BIN/services-centos/stopelastic.sh'

alias startneo='sudo $CEDAR_UTIL_BIN/services-centos/startneo.sh'
alias stopneo='sudo $CEDAR_UTIL_BIN/services-centos/stopneo.sh'

alias startredis='sudo $CEDAR_UTIL_BIN/services-centos/startredis.sh'
alias stopredis='sudo $CEDAR_UTIL_BIN/services-centos/stopredis.sh'

alias startrc='sudo $CEDAR_UTIL_BIN/services-centos/startrediscommander.sh'
alias killrc='sudo $CEDAR_UTIL_BIN/services-centos/killrediscommander.sh'

#CEDAR server aliases
alias starteditor='goeditor && gulp'
alias stopeditor='echo "Frontend served by nginx, no need to kill"'
