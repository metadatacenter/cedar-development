#!/bin/bash

CEDAR_HOSTS=(
    "auth.metadatacenter.orgx"
    "cedar.metadatacenter.orgx"
    "cert.metadatacenter.orgx"
    "group.metadatacenter.orgx"
    "internals.metadatacenter.orgx"
    "messaging.metadatacenter.orgx"
    "repo.metadatacenter.orgx"
    "resource.metadatacenter.orgx"
    "schema.metadatacenter.orgx"
    "submission.metadatacenter.orgx"
    "artifact.metadatacenter.orgx"
    "terminology.metadatacenter.orgx"
    "user.metadatacenter.orgx"
    "valuerecommender.metadatacenter.orgx"
    "worker.metadatacenter.orgx"
)

counter=0
echo "List of CEDAR hosts:"
for i in "${CEDAR_HOSTS[@]}"
do
  ping -c 1 $i > /dev/null 2>&1

  if [[ $? != 0 ]];
  then
    echo "Host unknown :" $i
    hosts[$counter]=$i
    ((counter++))
  else
    echo "Host known   :" $i
  fi
done

echo

if [[ ${#hosts[@]} == 0 ]];
then
  echo "All CEDAR hosts are known, nothing to do"
else
  echo "Some CEDAR hosts are unknown, we will prompt for your password in order to make modifications to /etc/hosts !"
  echo
  STR="$'\n'$'\n'Added by CEDAR Docker install process on $(date +%Y.%m.%d) [YYYY.mm.dd] from here:$'\n'"
  sudo bash -c "echo ${STR} >> /etc/hosts"
  for i in "${hosts[@]}"
  do
    echo "Host unknown, adding to /etc/hosts:" $i
    STR="127.0.0.1$'\t'$i"
    sudo bash -c "echo ${STR} >> /etc/hosts"
  done
  STR="$'\n'Added by CEDAR Docker install process until here.$'\n'"
  sudo bash -c "echo ${STR} >> /etc/hosts"
fi

echo
