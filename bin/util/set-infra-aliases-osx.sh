#!/bin/bash

#3rd party server aliases
alias startnginx='sudo $CEDAR_UTIL_BIN/services-osx/startnginx.sh'
alias stopnginx='sudo $CEDAR_UTIL_BIN/services-osx/stopnginx.sh'

alias startmongo='$CEDAR_UTIL_BIN/services-osx/startmongo.sh'
alias stopmongo='$CEDAR_UTIL_BIN/services-osx/stopmongo.sh'

alias startmysql='$CEDAR_UTIL_BIN/services-osx/startmysql.sh'
alias stopmysql='$CEDAR_UTIL_BIN/services-osx/stopmysql.sh'

alias startsearch='$CEDAR_UTIL_BIN/services-osx/startopensearch.sh'
alias stopsearch='$CEDAR_UTIL_BIN/services-osx/stopopensearch.sh'

alias startneo='$CEDAR_UTIL_BIN/services-osx/startneo.sh'
alias stopneo='$CEDAR_UTIL_BIN/services-osx/stopneo.sh'

alias startredis='$CEDAR_UTIL_BIN/services-osx/startredis.sh'
alias stopredis='$CEDAR_UTIL_BIN/services-osx/stopredis.sh'

#CEDAR server aliases
alias starteditor='goeditor && gulp'
alias stopeditor='kill `pgrep gulp`'
