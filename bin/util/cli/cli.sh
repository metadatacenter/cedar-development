#!/bin/bash
pushd $CEDAR_HOME/cedar-cli;
source .venv/bin/activate;
python cedar.py "$@"
popd
