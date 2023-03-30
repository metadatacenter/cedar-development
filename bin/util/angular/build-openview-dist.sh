#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Building CEDAR Openview Distribution
echo --------------------------------------------------------------------------------
echo

cd ${CEDAR_HOME}/cedar-openview
ng build --configuration=production

echo
echo "*******************************************************"
echo "***                                                 ***"
echo "***        Updating cedar-openview-dist repo.       ***"
echo "***         Please commit those changes !!!         ***"
echo "***                                                 ***"
echo "*******************************************************"
echo

cp -a dist/cedar-openview/. ${CEDAR_HOME}/cedar-openview-dist/
