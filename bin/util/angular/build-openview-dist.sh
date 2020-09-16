#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Building CEDAR Openview Distribution
echo --------------------------------------------------------------------------------
echo

cd ${CEDAR_HOME}/cedar-openview
ng build --prod --output-hashing=none

echo Updating cedar-openview-dist repo. Please commit those changes!!!

cp -a dist/cedar-openview/. ${CEDAR_HOME}/cedar-openview-dist/
