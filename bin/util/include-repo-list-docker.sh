#!/bin/bash
CEDAR_DOCKER_REPOS=(
  "cedar-docker-build"
  "cedar-docker-deploy"
)

echo List of CEDAR Docker repos:
for i in "${CEDAR_DOCKER_REPOS[@]}"
do
   echo "   - " $i
done
