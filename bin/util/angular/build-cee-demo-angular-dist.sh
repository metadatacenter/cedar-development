#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Building CEDAR Embeddable Editor Demo Angular Distribution
echo --------------------------------------------------------------------------------
echo

cd ${CEDAR_HOME}/cedar-cee-demo-angular
ng build --configuration=production

echo
echo "*******************************************************"
echo "***                                                 ***"
echo "***    Updating cedar-cee-demo-angular-dist repo.   ***"
echo "***         Please commit those changes !!!         ***"
echo "***                                                 ***"
echo "*******************************************************"
echo

cp -a dist/cedar-cee-demo-angular/. ${CEDAR_HOME}/cedar-cee-demo-angular-dist/
