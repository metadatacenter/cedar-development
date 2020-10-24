#!/bin/bash

#3rd party server aliases
alias startnginx='$CEDAR_UTIL_BIN/services-osx/startnginx.sh'
alias stopnginx='$CEDAR_UTIL_BIN/services-osx/stopnginx.sh'

alias startkk='$CEDAR_UTIL_BIN/services-osx/startkeycloak.sh'
alias killkk='$CEDAR_UTIL_BIN/services-osx/killkeycloak.sh'

alias startmongo='$CEDAR_UTIL_BIN/services-osx/startmongo.sh'
alias stopmongo='$CEDAR_UTIL_BIN/services-osx/stopmongo.sh'

alias startmysql='$CEDAR_UTIL_BIN/services-osx/startmysql.sh'
alias stopmysql='$CEDAR_UTIL_BIN/services-osx/stopmysql.sh'

alias startkibana='$CEDAR_UTIL_BIN/services-osx/startkibana.sh'
alias stopkibana='$CEDAR_UTIL_BIN/services-osx/stopkibana.sh'

alias startelastic='$CEDAR_UTIL_BIN/services-osx/startelastic.sh'
alias stopelastic='$CEDAR_UTIL_BIN/services-osx/stopelastic.sh'

alias startneo='$CEDAR_UTIL_BIN/services-osx/startneo.sh'
alias stopneo='$CEDAR_UTIL_BIN/services-osx/stopneo.sh'

alias startredis='$CEDAR_UTIL_BIN/services-osx/startredis.sh'
alias stopredis='$CEDAR_UTIL_BIN/services-osx/stopredis.sh'

alias startrc='$CEDAR_UTIL_BIN/services-osx/startrediscommander.sh'
alias killrc='$CEDAR_UTIL_BIN/services-osx/killrediscommander.sh'

#CEDAR server aliases
alias starteditor='goeditor && gulp &'
alias stopeditor='kill `pgrep gulp`'
