#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Building CEDAR Embeddable Editor Documentation Angular Distribution
echo --------------------------------------------------------------------------------
echo

cd ${CEDAR_HOME}/cedar-cee-docs-angular
ng build --configuration=production

echo
echo "*******************************************************"
echo "***                                                 ***"
echo "***    Updating cedar-cee-docs-angular-dist repo.   ***"
echo "***         Please commit those changes !!!         ***"
echo "***                                                 ***"
echo "*******************************************************"
echo

cp -a dist/cedar-cee-docs-angular/. ${CEDAR_HOME}/cedar-cee-docs-angular-dist/
