#!/bin/bash

source $CEDAR_UTIL_BIN/include-repo-list.sh

function show_branch {
  cd $CEDAR_HOME/$1
  branch=$(git rev-parse --abbrev-ref HEAD)
  printf "  (%s) %s\n" $branch $1
}

echo $'\n Current Git branches: '
for i in "${CEDAR_REPOS[@]}"
do
  show_branch $i
done
