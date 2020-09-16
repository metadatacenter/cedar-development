#!/bin/bash
source $CEDAR_UTIL_BIN/include-colors-and-header.sh "Checking all CEDAR repos for changes"
source $CEDAR_UTIL_BIN/include-repo-list.sh

format="\n\nChecking Git repo status ${GREEN}%-32s${NORMAL} : (%-70s)\n"

function checkRepo {
  printf "$format" $1 $CEDAR_HOME/$1
  git -C "$CEDAR_HOME/$1" remote update
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
  checkRepo $i
done