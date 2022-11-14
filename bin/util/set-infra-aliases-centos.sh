#!/bin/bash

#3rd party server aliases
# We do not use sudo here, because we should not know the 
# password for 'cedar' user.
# We will need to 'sudo su -' to stop the infra services
alias startnginx='$CEDAR_UTIL_BIN/services-centos/startnginx.sh'
alias stopnginx='$CEDAR_UTIL_BIN/services-centos/stopnginx.sh'

alias startmongo='$CEDAR_UTIL_BIN/services-centos/startmongo.sh'
alias stopmongo='$CEDAR_UTIL_BIN/services-centos/stopmongo.sh'

alias startmysql='$CEDAR_UTIL_BIN/services-centos/startmysql.sh'
alias stopmysql='$CEDAR_UTIL_BIN/services-centos/stopmysql.sh'

alias startkibana='$CEDAR_UTIL_BIN/services-centos/startkibana.sh'
alias stopkibana='$CEDAR_UTIL_BIN/services-centos/stopkibana.sh'

alias startsearch='$CEDAR_UTIL_BIN/services-centos/startelastic.sh'
alias stopsearch='$CEDAR_UTIL_BIN/services-centos/stopelastic.sh'

alias startneo='$CEDAR_UTIL_BIN/services-centos/startneo.sh'
alias stopneo='$CEDAR_UTIL_BIN/services-centos/stopneo.sh'

alias startredis='$CEDAR_UTIL_BIN/services-centos/startredis.sh'
alias stopredis='$CEDAR_UTIL_BIN/services-centos/stopredis.sh'

alias startrc='$CEDAR_UTIL_BIN/services-centos/startrediscommander.sh'
alias killrc='$CEDAR_UTIL_BIN/services-centos/killrediscommander.sh'

#CEDAR server aliases
alias starteditor='goeditor && gulp'
alias stopeditor='echo "Frontend served by nginx, no need to kill"'
