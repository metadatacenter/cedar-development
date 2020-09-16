#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Building CEDAR Metadata Form - Component used in OpenView
echo --------------------------------------------------------------------------------
echo

cd ${CEDAR_HOME}/cedar-metadata-form
ng build --prod --output-hashing=none
cat dist/cedar-form/{runtime,polyfills,main}.js > custom-elements.js

echo Updating cedar-component-distribution repo. Please commit those changes!!!

mv custom-elements.js ${CEDAR_HOME}/cedar-component-distribution/cedar-form/cedar-form-${CEDAR_VERSION}.js
