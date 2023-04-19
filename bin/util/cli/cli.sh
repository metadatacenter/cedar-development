#!/bin/bash
CEDAR_CLI_CWD=$PWD
pushd $CEDAR_HOME/cedar-cli > /dev/null
source .venv/bin/activate;
if [ "$1" == 'build' ] && [ "$2" == 'this' ]; then
  python $CEDAR_HOME/cedar-cli/cedar.py "$@" --wd=$CEDAR_CLI_CWD
elif [ "$1" == 'deploy' ] && [ "$2" == 'this' ]; then
  python $CEDAR_HOME/cedar-cli/cedar.py "$@" --wd=$CEDAR_CLI_CWD
else
  python $CEDAR_HOME/cedar-cli/cedar.py "$@"
fi
popd > /dev/null
