#!/bin/bash
source $CEDAR_UTIL_BIN/include-colors-and-header.sh "Pulling all CEDAR repos"
source $CEDAR_UTIL_BIN/include-repo-list.sh

format="\n\nPulling Git repo status ${GREEN}%-32s${NORMAL} : (%-70s)\n"

function pullRepo {
  printf "$format" $1 $CEDAR_HOME/$1
  git -C "$CEDAR_HOME/$1" pull
  git -C "$CEDAR_HOME/$1" status
  git -C "$CEDAR_HOME/$1" status | egrep 'Your branch is up to date with|Your branch is up-to-date with'
  if [ $? == 0 ]; then
    echo "${GREEN}Up-to-date with remote :)${NORMAL}"
  else
    echo "${RED}Something to do here!${NORMAL}"
  fi
}

for i in "${CEDAR_REPOS[@]}"
do
   pullRepo $i
done