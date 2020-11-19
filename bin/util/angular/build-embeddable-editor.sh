#!/bin/bash
clear
echo --------------------------------------------------------------------------------
echo Building CEDAR Embeddable Editor
echo --------------------------------------------------------------------------------
echo

cd ${CEDAR_HOME}/cedar-embeddable-editor
ng build --prod --output-hashing=none
cat dist/cedar-embeddable-editor/{runtime,polyfills,main}.js > custom-elements.js

echo
echo "*******************************************************"
echo "***                                                 ***"
echo "***   Updating cedar-component-distribution repo.   ***"
echo "***         Please commit those changes !!!         ***"
echo "***                                                 ***"
echo "*******************************************************"
echo

mv custom-elements.js ${CEDAR_HOME}/cedar-component-distribution/cedar-embeddable-editor/cedar-embeddable-editor-${CEDAR_VERSION}.js
