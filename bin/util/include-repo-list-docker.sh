#!/bin/bash
CEDAR_REPOS=(
  "cedar-docker-build"
  "cedar-docker-deploy"
)

echo List of CEDAR repos:
for i in "${CEDAR_REPOS[@]}"
do
   echo "   - " $i
done
