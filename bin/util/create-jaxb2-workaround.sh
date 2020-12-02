#!/bin/bash
echo ---------------------------------------------
echo Creating symlinks for jaxb2-maven-plugin issue
echo see: https://github.com/mojohaus/jaxb2-maven-plugin/issues/115
echo ---------------------------------------------
echo

function createLink {
  DIR=$1
  FILE=$2
  LINKDIR=${CEDAR_HOME}/cedar-project/${CEDAR_HOME}/cedar-cadsr-tools/src/main/resources/xsd/$DIR
  DESTDIR=${CEDAR_HOME}/cedar-cadsr-tools/src/main/resources/xsd/$DIR
  mkdir -p $DESTDIR
  mkdir -p $LINKDIR
  FROM=$LINKDIR/$FILE
  TO=$DESTDIR/$FILE
  echo 'Link from:'$FROM
  echo 'Link to  :'$TO
  ln -s $TO $FROM
  echo '-----------'
}

createLink category ContextCsCsi_0923_modified.xsd
createLink cde DataElement_V5.3.4_modified.xsd
createLink form FormLoaderv17_modified.xsd
