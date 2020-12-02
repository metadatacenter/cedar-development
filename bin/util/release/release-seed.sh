#!/bin/bash

echo ---------------------------------------------
echo Downloading newest release script from GitHub
echo ---------------------------------------------
echo

wget https://raw.githubusercontent.com/metadatacenter/cedar-development/develop/bin/util/release/release-all.sh
chmod a+x ./release-all.sh

echo ---------------------------------------------
echo 'Script downloaded. Now execute these lines:'
echo 'export CEDAR_RELEASE_VERSION=<VERSION_HERE>'
echo 'export CEDAR_HOME=`pwd`'
echo './release-all.sh'
echo ---------------------------------------------
echo
