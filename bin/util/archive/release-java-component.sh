#!/bin/bash
echo --------------------------------------------------------------------------------
echo Release CEDAR java component
echo --------------------------------------------------------------------------------
echo
   
# Update versions of parent and dependencies to release version
git checkout develop
git pull origin develop
mvn versions:update-parent versions:update-child-modules # Update parent POM to release version (recursively)
mvn -DallowSnapshots=false versions:update-properties # Update version properties to point to latest release versions
git commit -a -m "Updated parent POM and dependency versions to release version"
git push origin develop
   
# Prepare a release using the Maven Releases Plugin and tag it
mvn -Darguments="-DskipTests" --batch-mode -Dtag=$CEDAR_RELEASE_TAG -DreleaseVersion=$CEDAR_RELEASE_VERSION -DscmCommentPrefix="[ci skip] " release:clean release:prepare
 
# Perform the release using the Maven Releases Plugin
mvn -Darguments="-DskipTests" release:perform

# Make the master branch reflect the released version
git push origin develop
git checkout master
git pull origin master
git merge -X theirs --no-ff -m "Release $CEDAR_RELEASE_VERSION" $CEDAR_RELEASE_TAG
git push origin master    
mvn -DskipTests=true clean install # install release artifact locally

# Return to develop branch and update to next development version
git checkout develop
git pull origin develop
mvn -DallowSnapshots=true versions:update-parent # Update parent POM to current development version
mvn -DallowSnapshots=true versions:update-properties # Update version properties to point to latest development versions
git commit -a -m "Updated CEDAR component dependencies to point to current development snapshots"
git push origin develop
mvn -DskipTests=true deploy # deploy new development artifact 