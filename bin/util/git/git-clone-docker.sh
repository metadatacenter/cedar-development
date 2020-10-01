#!/bin/bash
source $CEDAR_UTIL_BIN/include-colors-and-header.sh "Cloning CEDAR Docker repos"
source $CEDAR_UTIL_BIN/include-repo-list-docker.sh

format="\n\nCloning Git repo status ${GREEN}%-32s${NORMAL} : (%-70s)\n"

function cloneRepo {
  printf "$format" $1 $CEDAR_DOCKER_HOME/$1
  git -C "$CEDAR_DOCKER_HOME" clone https://github.com/metadatacenter/$1
  git -C "$CEDAR_DOCKER_HOME/$1" status
  git -C "$CEDAR_DOCKER_HOME/$1" status | egrep 'Your branch is up to date with|Your branch is up-to-date with'
  if [ $? == 0 ]; then
    echo "${GREEN}Up-to-date with remote :)${NORMAL}"
  else
    echo "${RED}Something to do here!${NORMAL}"
  fi
}

for i in "${CEDAR_DOCKER_REPOS[@]}"
do
   cloneRepo $i
done
