#!/bin/bash

CEDAR_HOSTS=(
    "artifact"
    "artifacts"
    "bridge"
    "auth"
    "cedar"
    "component"
    "group"
    "impex"
    "monitor"
    "monitoring"
    "messaging"
    "open"
    "openview"
    "repo"
    "resource"
    "schema"
    "submission"
    "terminology"
    "user"
    "valuerecommender"
    "worker"
    "demo.cee"
    "demo-dist.cee"
    "docs.cee"
    "docs-dist.cee"
    "api-php.cee"
)

counter=0
echo "Testing the list of CEDAR hosts:"
for i in "${CEDAR_HOSTS[@]}"
do
  HOST=$i.${CEDAR_HOST}
  ping -c 1 ${HOST} > /dev/null 2>&1

  if [[ $? != 0 ]];
  then
    echo "Host unknown :" ${HOST}
    hosts[$counter]=${HOST}
    ((counter++))
  else
    echo "Host known   :" ${HOST}
  fi
done

echo

if [[ ${#hosts[@]} == 0 ]];
then
  echo "All CEDAR hosts are known, nothing to do"
else
  echo "Some CEDAR hosts are unknown, we will prompt for your password in order to make modifications to /etc/hosts !"
  echo
  STR="$'\n'$'\n'# Added by CEDAR install process on $(date +%Y-%m-%d) [YYYY-mm-dd] from here:$'\n'"
  sudo bash -c "echo ${STR} >> /etc/hosts"
  for i in "${hosts[@]}"
  do
    echo "Host unknown, adding to /etc/hosts:" $i
    STR="127.0.0.1$'\t'$i"
    sudo bash -c "echo ${STR} >> /etc/hosts"
  done
  STR="$'\n'# Added by CEDAR install process until here.$'\n'"
  sudo bash -c "echo ${STR} >> /etc/hosts"
fi

echo
