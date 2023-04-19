#!/bin/bash

# Script to release all CEDAR artifacts.
#
# CEDAR_HOME and CEDAR_RELEASE_VERSION varables must be set.
#
# Maven ~/.m2/settings.xml file must be configured to use CEDAR Nexus server:
#
# https://github.com/metadatacenter/cedar-docs/wiki/Configuring-Maven-to-use-the-CEDAR-Nexus-Server
#
# NPM ~/.npmrc file must also be configured to use CEDAR Nexus server:
#
# https://github.com/metadatacenter/cedar-docs/wiki/Configuring-NPM-to-use-the-CEDAR-Nexus-Server
#
# Docker ~/.docker/config.json file must be configured to use CEDAR Nexus server as a DockerHub:
#
# https://github.com/metadatacenter/cedar-conf/wiki/Configuring-Docker-to-use-the-CEDAR-Nexus-DockerHub
#
# Works but needs hardening

if [ -z "$CEDAR_HOME" ]; then
  echo "Need to set CEDAR_HOME"
  exit 1
fi

if [ -z "$CEDAR_RELEASE_VERSION" ]; then
  echo "Need to set CEDAR_RELEASE_VERSION"
  exit 1
fi

# TODO add git check
# TODO add mvn check

if ! [ -x "$(command -v jq)" ]; then
  echo 'Error: jq is not installed. Install using "brew install jq" or other similar method.' >&2
  exit 1
else
  HASH=$(echo '{"foo": "bar"}' | jq '.foo="baz"' | md5)
  if [ "$HASH" != "030dd04334bb7fb124421933f0b42c1a" ]; then
    echo 'Error: jq command is not behaving as expected.' >&2
    exit 1
  fi
fi

if ! [ -x "$(command -v node)" ]; then
  echo 'Error: node is not installed. Install from "https://nodejs.org/".' >&2
  exit 1
fi

if ! [ -x "$(command -v ng)" ]; then
  echo 'Error: ng is not installed. Install using "npm install -g @angular/cli".' >&2
  exit 1
fi

REG=$(npm config get registry)
if [ "$REG" != "https://registry.npmjs.org/" ]; then
  echo 'Error: your npm registry is set incorrectly. Please set it using "npm config set registry https://registry.npmjs.org/".' >&2
  exit 1
fi

export CEDAR_RELEASE_TAG=release-${CEDAR_RELEASE_VERSION}
export CEDAR_NEXT_DEVELOPMENT_VERSION=$(echo $CEDAR_RELEASE_VERSION | awk -F. -v OFS=. 'NF==1{print ++$NF}; NF>1{if(length($NF+1)>length($NF))$NF; $NF=sprintf("%0*d-SNAPSHOT", length($NF), ($NF+1)); print}')

export CEDAR_DOCKER_BUILD_HOME=$1/cedar-docker-build

export CEDAR_DOCKERHUB=cedar-dockerhub.bmir.stanford.edu

CEDAR_PARENT_REPOS=(
  "cedar-parent"
)

CEDAR_LIBRARY_REPOS=(
  "cedar-model-library"
  "cedar-artifact-library"
  "cedar-core-library"
  "cedar-rest-library"
  "cedar-config-library"
  "cedar-model-validation-library"
  "cedar-libraries"
)

CEDAR_SERVER_REPOS=(
  "cedar-model-validation-library"
  "cedar-microservice-libraries"
  "cedar-artifact-library"
  "cedar-keycloak-event-listener"
  "cedar-admin-tool"
  "cedar-user-server"
  "cedar-artifact-server"
  "cedar-repo-server"
  "cedar-schema-server"
  "cedar-resource-server"
  "cedar-terminology-server"
  "cedar-valuerecommender-server"
  "cedar-group-server"
  "cedar-submission-server"
  "cedar-worker-server"
  "cedar-messaging-server"
  "cedar-openview-server"
  "cedar-monitor-server"
  "cedar-cadsr-tools"
  "cedar-impex-server"
)

CEDAR_FRONTEND_OLD_REPOS=(
  "cedar-template-editor"
)

CEDAR_FRONTEND_NEW_REPOS=(
  "cedar-metadata-form"
  "cedar-monitoring"
  "cedar-embeddable-editor"
)

CEDAR_COMPONENT_REPOS=(
  "cedar-component-distribution"
  "cedar-shared-data"
)

CEDAR_UTIL_REPOS=(
  "cedar-util"
)

CEDAR_DOCUMENTATION_REPOS=(
  "cedar-swagger-ui"
  "cedar-mkdocs"
  "cedar-mkdocs-developer"
)

CEDAR_CLIENT_REPOS=(
  #   "cadsr-reader" (See: https://github.com/metadatacenter/cadsr2cedar/issues/2)
  "cedar-archetype-instance-reader"
  "cedar-archetype-instance-writer"
  "cedar-archetype-exporter"
)

CEDAR_PROJECT_REPOS=(
  "cedar-project"
)

CEDAR_DOCKER_BUILD_REPOS=(
  "cedar-docker-build"
)

CEDAR_DOCKER_DEPLOY_REPOS=(
  "cedar-docker-deploy"
)

CEDAR_DEVELOPMENT_REPOS=(
  "cedar-development"
)

CEDAR_ALL_REPOS=(
  "${CEDAR_PARENT_REPOS[@]}"
  "${CEDAR_LIBRARY_REPOS[@]}"
  "${CEDAR_SERVER_REPOS[@]}"
  "${CEDAR_PROJECT_REPOS[@]}"
  "${CEDAR_UTIL_REPOS[@]}"
  "${CEDAR_DOCUMENTATION_REPOS[@]}"
  "${CEDAR_CLIENT_REPOS[@]}"
  "${CEDAR_FRONTEND_OLD_REPOS[@]}"
  "${CEDAR_FRONTEND_NEW_REPOS[@]}"
  "${CEDAR_COMPONENT_REPOS[@]}"
  "${CEDAR_DOCKER_BUILD_REPOS[@]}"
  "${CEDAR_DOCKER_DEPLOY_REPOS[@]}"
  "${CEDAR_DEVELOPMENT_REPOS[@]}"
)

log_progress() {
  STR='CEDAR Release | '$(date +"%Y-%m-%d %H:%M:%S")' | '${1}
  echo "${STR}"
  echo "${STR}" >>${CEDAR_HOME}/cedar-release.log
}

clone_repos_if_needed() {
  log_progress 'Cloning repos'
  pushd "${CEDAR_HOME}" || exit
  for r in "${CEDAR_ALL_REPOS[@]}"; do
    if [[ ! -d $r ]]; then
      log_progress "Cloning repo $r"
      git clone "https://github.com/metadatacenter/$r"
      pushd "$r" || exit
      git checkout develop
      popd || exit
    fi
  done
  popd || exit
}

execute_jaxb2_workaround() {
  log_progress 'Executing JAXB2 workaround script'
  pushd "${CEDAR_HOME}" || exit
  source ./cedar-development/bin/util/create-jaxb2-workaround.sh
  popd || exit
}

prompt_to_continue() {
  read -n 1 -p "Press enter to continue, any other key to quit. " answer
  if [ -z "$answer" ]; then
    return 0
  else
    echo
    return 1
  fi
}

exit_if_error() {
  if [ $? != 0 ]; then
    echo "${RED}Something went wrong here!${NORMAL}"
    #        exit 1
  fi
}

update_repo_parent_to_release() {
  # Update versions of parent and dependencies to release version
  git checkout develop
  git pull
  mvn versions:update-parent versions:update-child-modules # Update parent POM to release version (recursively)
  mvn -DallowSnapshots=false versions:update-properties    # Update version properties to point to latest release versions

  SWAGGER_COUNT="$(find . -name 'swagger.json' | grep /src/ | wc -l)"
  echo "Found $SWAGGER_COUNT swagger.json files"
  if [ "$SWAGGER_COUNT" -eq 1 ]; then
    echo "Replace version in swagger.json"
    SWAGGER_FILE="$(find . -name 'swagger.json' | grep /src/)"
    jq '.info.version="'"${CEDAR_RELEASE_VERSION}"'"' "$SWAGGER_FILE" >"$SWAGGER_FILE.jq" && mv "$SWAGGER_FILE.jq" "$SWAGGER_FILE"
  fi

  git commit -a -m "Updated parent POM and dependency versions to release version"
  git push
}

release_artifact() {
  # Perform a release using the Maven Releases Plugin and tag it
  mvn -Darguments="-DskipTests" --batch-mode -Dtag="$CEDAR_RELEASE_TAG" -DreleaseVersion="$CEDAR_RELEASE_VERSION" -DscmCommentPrefix="[ci skip] " release:clean release:prepare
  mvn -Darguments="-DskipTests -Dmaven.javadoc.skip=true" release:perform
  git push
}

copy_release_to_main() {
  # Make the main branch reflect the released version
  git checkout main
  git pull
  git merge -X theirs --no-ff -m "$CEDAR_RELEASE_VERSION" "$CEDAR_RELEASE_TAG"
  git push
}

install_artifact() {
  mvn -DskipTests=true clean install
}

update_repo_to_next_development_version() {
  # Return to develop branch and update to next development version
  git checkout develop
  git pull
  mvn -DallowSnapshots=true versions:update-parent     # Update parent POM to current development version
  mvn -DallowSnapshots=true versions:update-properties # Update version properties to point to latest development versions

  SWAGGER_COUNT="$(find . -name 'swagger.json' | grep /src/ | wc -l)"
  echo "Found $SWAGGER_COUNT swagger.json files"
  if [ "$SWAGGER_COUNT" -eq 1 ]; then
    echo "Replace version in swagger.json"
    SWAGGER_FILE="$(find . -name 'swagger.json' | grep /src/)"
    jq '.info.version="'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'"' "$SWAGGER_FILE" >"$SWAGGER_FILE.jq" && mv "$SWAGGER_FILE.jq" "$SWAGGER_FILE"
  fi

  git commit -a -m "Updated CEDAR component dependencies to point to current development snapshots"
  git push
  mvn -DskipTests=true deploy # deploy new development artifact
}

tag_repo_with_release_version() {
  # Tag the latest development version
  git checkout develop
  git pull
  git tag "$CEDAR_RELEASE_TAG"
  git push origin "$CEDAR_RELEASE_TAG"
}

release_parent_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit
  git checkout develop
  sed -i '' 's/<cedar.version>.*<\/cedar.version>/<cedar.version>'"${CEDAR_RELEASE_VERSION}"'<\/cedar.version>/g' pom.xml
  git commit -a -m "Updated cedar.version to release version"
  git push

  release_artifact "$1"
  copy_release_to_main "$1"
  install_artifact

  # Return to develop branch and deploy latest development version
  git checkout develop
  sed -i '' 's/<cedar.version>.*<\/cedar.version>/<cedar.version>'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'<\/cedar.version>/g' pom.xml
  git commit -a -m "Updated cedar.version to next development version"
  git push
  mvn clean deploy # deploy development artifact

  popd || exit
}

release_library_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  update_repo_parent_to_release "$1"

  release_artifact "$1"
  copy_release_to_main "$1"
  install_artifact

  update_repo_to_next_development_version "$1"

  popd || exit
}

release_server_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  update_repo_parent_to_release "$1"

  release_artifact "$1"
  copy_release_to_main "$1"
  install_artifact

  update_repo_to_next_development_version "$1"

  popd || exit
}

release_project_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  # Update to next release version
  git checkout develop
  git pull
  mvn versions:set -DnewVersion="$CEDAR_RELEASE_VERSION" -DupdateMatchingVersions=false
  git commit -a -m "Update to next release version"
  git push

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"
  install_artifact

  # Return to develop branch and update to next development version
  git checkout develop
  git pull
  mvn build-helper:parse-version versions:set -DnewVersion=\${parsedVersion.majorVersion}.\${parsedVersion.minorVersion}.\${parsedVersion.nextIncrementalVersion}-SNAPSHOT versions:commit
  git commit -a -m "Update to next development version"
  git push

  popd || exit
}

release_frontend_old_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  git checkout develop
  git pull
  sed -i '' 's/- CEDAR_VERSION\s*=.*\".*\"/- CEDAR_VERSION=\"'"${CEDAR_RELEASE_VERSION}"'\"/g' .travis.yml
  if [ -f "package-lock.json" ]; then
    jq '.version="'"${CEDAR_RELEASE_VERSION}"'"' package-lock.json >jpackage-lock-jqed.json && mv jpackage-lock-jqed.json package-lock.json
    jq '.packages[""].version="'"${CEDAR_RELEASE_VERSION}"'"' package-lock.json >jpackage-lock-jqed.json && mv jpackage-lock-jqed.json package-lock.json
  fi
  if [ -f "package.json" ]; then
    jq '.version="'"${CEDAR_RELEASE_VERSION}"'"' package.json >package-jqed.json && mv package-jqed.json package.json
  fi
  git commit -a -m "Set release version for .travis.yml and package.json"
  git push

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"
  npm publish

  # Return to develop branch
  git checkout develop
  sed -i '' 's/- CEDAR_VERSION\s*=.*\".*\"/- CEDAR_VERSION=\"'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'\"/g' .travis.yml
  if [ -f "package-lock.json" ]; then
    jq '.version="'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'"' package-lock.json >jpackage-lock-jqed.json && mv jpackage-lock-jqed.json package-lock.json
    jq '.packages[""].version="'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'"' package-lock.json >jpackage-lock-jqed.json && mv jpackage-lock-jqed.json package-lock.json
  fi
  if [ -f "package.json" ]; then
    jq '.version="'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'"' package.json >package-jqed.json && mv package-jqed.json package.json
  fi
  git commit -a -m "Updated to next development version"
  git push

  npm publish

  popd || exit
}

release_frontend_new_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  git checkout develop
  git pull

  # cedar-openview / cedar-cee-demo-angular / cedar-cee-docs-angular
  APP_CONFIG_FILE="src/assets/data/appConfig.json"
  if [ -f ${APP_CONFIG_FILE} ]; then
    jq '.apiUrl="'https://open.metadatacenter.org/'"' "${APP_CONFIG_FILE}" >"${APP_CONFIG_FILE}.jq" && mv "${APP_CONFIG_FILE}.jq" "${APP_CONFIG_FILE}"
    jq '.cedarUrl="'https://cedar.metadatacenter.org/'"' "${APP_CONFIG_FILE}" >"${APP_CONFIG_FILE}.jq" && mv "${APP_CONFIG_FILE}.jq" "${APP_CONFIG_FILE}"
    jq '.terminologyUrl="'https://terminology.metadatacenter.org/'"' "${APP_CONFIG_FILE}" >"${APP_CONFIG_FILE}.jq" && mv "${APP_CONFIG_FILE}.jq" "${APP_CONFIG_FILE}"
  fi

  sed -i '' 's/- CEDAR_VERSION\s*=.*\".*\"/- CEDAR_VERSION=\"'"${CEDAR_RELEASE_VERSION}"'\"/g' .travis.yml
  # cedar-openview webcomponent reference
  if [ -f "src/index.html" ]; then
    sed -i '' 's/\/cedar-form-.*\.js/\/cedar-form-'"${CEDAR_RELEASE_VERSION}"'\.js/g' src/index.html
    sed -i '' 's/\/component\.metadatacenter\..*\/cedar-form\//\/component\.metadatacenter\.org\/cedar-form\//g' src/index.html

    sed -i '' 's/\/cedar-embeddable-editor-.*\.js/\/cedar-embeddable-editor-'"${CEDAR_RELEASE_VERSION}"'\.js/g' src/index.html
    sed -i '' 's/\/component\.metadatacenter\..*\/cedar-embeddable-editor\//\/component\.metadatacenter\.org\/cedar-embeddable-editor\//g' src/index.html
  fi
  # all angular repos
  if [ -f "package-lock.json" ]; then
    jq '.version="'"${CEDAR_RELEASE_VERSION}"'"' package-lock.json >jpackage-lock-jqed.json && mv jpackage-lock-jqed.json package-lock.json
    jq '.packages[""].version="'"${CEDAR_RELEASE_VERSION}"'"' package-lock.json >jpackage-lock-jqed.json && mv jpackage-lock-jqed.json package-lock.json
  fi
  if [ -f "package.json" ]; then
    jq '.version="'"${CEDAR_RELEASE_VERSION}"'"' package.json >package-jqed.json && mv package-jqed.json package.json
  fi
  npm install
  git commit -a -m "Set release version for .travis.yml and package.json"
  git push

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"
  npm publish

  # Return to develop branch
  git checkout develop
  sed -i '' 's/- CEDAR_VERSION\s*=.*\".*\"/- CEDAR_VERSION=\"'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'\"/g' .travis.yml
  # cedar-openview webcomponent reference
  if [ -f "src/index.html" ]; then
    sed -i '' 's/\/cedar-form-.*\.js/\/cedar-form-'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'\.js/g' src/index.html
    sed -i '' 's/\/component\.metadatacenter\..*\/cedar-form\//\/component\.metadatacenter\.org\/cedar-form\//g' src/index.html

    sed -i '' 's/\/cedar-embeddable-editor-.*\.js/\/cedar-embeddable-editor-'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'\.js/g' src/index.html
    sed -i '' 's/\/component\.metadatacenter\..*\/cedar-embeddable-editor\//\/component\.metadatacenter\.org\/cedar-embeddable-editor\//g' src/index.html
  fi
  # all angular repos
  if [ -f "package-lock.json" ]; then
    jq '.version="'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'"' package-lock.json >jpackage-lock-jqed.json && mv jpackage-lock-jqed.json package-lock.json
    jq '.packages[""].version="'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'"' package-lock.json >jpackage-lock-jqed.json && mv jpackage-lock-jqed.json package-lock.json
  fi
  if [ -f "package.json" ]; then
    jq '.version="'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'"' package.json >package-jqed.json && mv package-jqed.json package.json
  fi
  npm install
  git commit -a -m "Updated to next development version"
  git push

  npm publish

  popd || exit
}

release_docker_build_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  # Tag the latest development version
  git checkout develop
  git pull origin develop
  find . -name Dockerfile -exec sed -i '' 's/^FROM metadatacenter\/cedar-microservice:.*$/FROM metadatacenter\/cedar-microservice:'"${CEDAR_RELEASE_VERSION}"'/' {} \; -print
  find . -name Dockerfile -exec sed -i '' 's/^FROM metadatacenter\/cedar-java:.*$/FROM metadatacenter\/cedar-java:'"${CEDAR_RELEASE_VERSION}"'/' {} \; -print
  find . -name Dockerfile -exec sed -i '' 's/^ENV CEDAR_VERSION=.*$/ENV CEDAR_VERSION='"${CEDAR_RELEASE_VERSION}"'/' {} \; -print
  sed -i '' 's/^export IMAGE_VERSION=.*$/export IMAGE_VERSION='"${CEDAR_RELEASE_VERSION}"'/' ./bin/cedar-images-base.sh
  git commit -a -m "Set the release version in the Dockerfiles"
  git push origin develop

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"

  # Return to develop branch
  git checkout develop
  find . -name Dockerfile -exec sed -i '' 's/^FROM metadatacenter\/cedar-microservice:.*$/FROM metadatacenter\/cedar-microservice:'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'/' {} \; -print
  find . -name Dockerfile -exec sed -i '' 's/^FROM metadatacenter\/cedar-java:.*$/FROM metadatacenter\/cedar-java:'"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'/' {} \; -print
  find . -name Dockerfile -exec sed -i '' 's/^ENV CEDAR_VERSION=.*$/ENV CEDAR_VERSION='"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'/' {} \; -print
  sed -i '' 's/^export IMAGE_VERSION=.*$/export IMAGE_VERSION='"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'/' ./bin/cedar-images-base.sh
  git commit -a -m "Updated to next development version"
  git push origin develop

  popd || exit
}

release_docker_deploy_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  # Tag the latest development version
  git checkout develop
  git pull origin develop
  find . -name .env -exec sed -i '' 's/^CEDAR_DOCKER_VERSION=.*$/CEDAR_DOCKER_VERSION='"${CEDAR_RELEASE_VERSION}"'/' {} \; -print
  git commit -a -m "Set the release version in the Dockerfiles"
  git push origin develop

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"

  # Return to develop branch
  git checkout develop
  find . -name .env -exec sed -i '' 's/CEDAR_DOCKER_VERSION=.*$/CEDAR_DOCKER_VERSION='"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'/' {} \; -print
  git commit -a -m "Updated to next development version"
  git push origin develop

  popd || exit
}

release_development_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  # Tag the latest development version
  git checkout develop
  git pull origin develop
  sed -i '' 's/^export CEDAR_VERSION=.*$/export CEDAR_VERSION='"${CEDAR_RELEASE_VERSION}"'/' ./bin/util/set-env-generic.sh
  git commit -a -m "Set the release version in the shell scripts"
  git push origin develop

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"

  # Return to develop branch
  git checkout develop
  sed -i '' 's/^export CEDAR_VERSION=.*$/export CEDAR_VERSION='"${CEDAR_NEXT_DEVELOPMENT_VERSION}"'/' ./bin/util/set-env-generic.sh
  git commit -a -m "Updated to next development version"
  git push origin develop

  popd || exit
}

release_mavenless_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"
  git checkout develop

  popd || exit
}

release_client_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  update_repo_parent_to_release "$1"

  release_artifact "$1"
  copy_release_to_main "$1"
  install_artifact

  update_repo_to_next_development_version "$1"

  popd || exit
}

build_metadata_form_component() {
  RELEASE_VERSION=$1
  BRANCH=$2
  pushd "${CEDAR_HOME}/cedar-metadata-form" || exit
  git checkout "${BRANCH}"
  git pull

  npm install
  ng build --configuration=production
  cat dist/cedar-form/{runtime,polyfills,main}.js >"${CEDAR_HOME}/cedar-component-distribution/cedar-form/cedar-form-${RELEASE_VERSION}.js"

  popd || exit
}

build_embeddable_editor_component() {
  RELEASE_VERSION=$1
  BRANCH=$2
  pushd "${CEDAR_HOME}/cedar-embeddable-editor" || exit
  git checkout "${BRANCH}"
  git pull

  npm install
  ng build --configuration=production
  cat dist/cedar-embeddable-editor/{runtime,polyfills,main}.js >"${CEDAR_HOME}/cedar-component-distribution/cedar-embeddable-editor/cedar-embeddable-editor-${RELEASE_VERSION}.js"

  popd || exit
}


release_component_distribution_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  # Tag the latest development version
  git checkout develop
  git pull origin develop

  rm -f cedar-form/cedar-form-*.js
  build_metadata_form_component "${CEDAR_RELEASE_VERSION}" main
  git add "cedar-form/cedar-form-${CEDAR_RELEASE_VERSION}.js"

  rm -f cedar-embeddable-editor/cedar-embeddable-editor-*.js
  build_embeddable_editor_component "${CEDAR_RELEASE_VERSION}" main
  git add "cedar-embeddable-editor/cedar-embeddable-editor-${CEDAR_RELEASE_VERSION}.js"

  git commit -a -m "Produce release version of component"
  git push origin develop

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"

  # Return to develop branch
  git checkout develop

  rm -f cedar-form/cedar-form-*.js
  build_metadata_form_component "${CEDAR_NEXT_DEVELOPMENT_VERSION}" develop
  git add "cedar-form/cedar-form-${CEDAR_NEXT_DEVELOPMENT_VERSION}.js"

  rm -f cedar-embeddable-editor/cedar-embeddable-editor-*.js
  build_embeddable_editor_component "${CEDAR_NEXT_DEVELOPMENT_VERSION}" develop
  git add "cedar-embeddable-editor/cedar-embeddable-editor-${CEDAR_NEXT_DEVELOPMENT_VERSION}.js"

  git commit -a -m "Updated to next development version"
  git push origin develop

  popd || exit
}

release_shared_data_repo() {
  log_progress "Releasing repo $1"
  pushd "$CEDAR_HOME/$1" || exit

  # Tag the latest development version
  git checkout develop
  git pull origin develop

  git add .

  git commit -a -m "Produce release version of component"
  git push origin develop

  tag_repo_with_release_version "$1"
  copy_release_to_main "$1"

  # Return to develop branch
  git checkout develop

  git add .

  git commit -a -m "Updated to next development version"
  git push origin develop

  popd || exit
}

update_cedar_parent_version() {
  git checkout develop
  sed -i '' 's/<cedar.version>.*<\/cedar.version>/<cedar.version>'"${CEDAR_RELEASE_VERSION}"'<\/cedar.version>/g' pom.xml
  git commit -a -m "Updated cedar.version to release version"
  git push
}

git_pull_branch() {
  log_progress "Pulling repo $1"
  git -C "$CEDAR_HOME/$1" checkout "$2"
  git -C "$CEDAR_HOME/$1" pull
}

git_pull_all_repos() {
  log_progress "Pulling all CEDAR repos"
  for r in "${CEDAR_ALL_REPOS[@]}"; do
    git_pull_branch "$r" develop
  done
}

empty_user_maven_cache() {
  log_progress "Removing CEDAR artifacts from local Maven cache"
  rm -rf ~/.m2/repository/org/metadatacenter
}

build_repo() {
  log_progress "Building $1"
  pushd "$CEDAR_HOME/$1" || exit
  mvn -DskipTests clean install
  popd || exit
}

release_all_parent_repos() {
  # Release parent repos
  log_progress 'Releasing parent repos...'
  for r in "${CEDAR_PARENT_REPOS[@]}"; do
    release_parent_repo "$r"
  done
}

release_all_server_repos() {
  log_progress "Releasing server repos..."
  for r in "${CEDAR_SERVER_REPOS[@]}"; do
    release_server_repo "$r"
  done
}

release_all_library_repos() {
  log_progress "Releasing library repos..."
  for r in "${CEDAR_LIBRARY_REPOS[@]}"; do
    release_library_repo "$r"
  done
}

release_all_project_repos() {
  log_progress "Releasing project repos..."
  for r in "${CEDAR_PROJECT_REPOS[@]}"; do
    release_project_repo "$r"
  done
}

release_all_frontend_old_repos() {
  log_progress "Releasing frontend old repos..."
  for r in "${CEDAR_FRONTEND_OLD_REPOS[@]}"; do
    release_frontend_old_repo "$r"
  done
}

release_all_frontend_new_repos() {
  log_progress "Releasing frontend new repos..."
  for r in "${CEDAR_FRONTEND_NEW_REPOS[@]}"; do
    release_frontend_new_repo "$r"
  done
}

release_all_component_repos() {
  log_progress "Releasing component repos..."
  for r in "${CEDAR_COMPONENT_REPOS[@]}"; do
    if [ "$r" = "cedar-component-distribution" ]; then
      release_component_distribution_repo "$r"
    fi
    if [ "$r" = "cedar-shared-data" ]; then
      release_shared_data_repo "$r"
    fi
  done
}

release_all_configuration_repos() {
  log_progress "Releasing configuration repos..."
  for r in "${CEDAR_CONFIGURATION_REPOS[@]}"; do
    release_mavenless_repo "$r"
  done
}

release_all_documentation_repos() {
  log_progress "Releasing documentation repos..."
  for r in "${CEDAR_DOCUMENTATION_REPOS[@]}"; do
    release_mavenless_repo "$r"
  done
}

release_all_client_repos() {
  log_progress "Releasing client repos..."
  for r in "${CEDAR_CLIENT_REPOS[@]}"; do
    release_client_repo "$r"
  done
}

release_all_docker_build_repos() {
  log_progress "Releasing Docker build repos..."
  for r in "${CEDAR_DOCKER_BUILD_REPOS[@]}"; do
    release_docker_build_repo "$r"
  done
}

release_all_docker_deploy_repos() {
  log_progress "Releasing Docker deploy repos..."
  for r in "${CEDAR_DOCKER_DEPLOY_REPOS[@]}"; do
    release_docker_deploy_repo "$r"
  done
}

release_all_development_repos() {
  log_progress "Releasing development repos..."
  for r in "${CEDAR_DEVELOPMENT_REPOS[@]}"; do
    release_development_repo "$r"
  done
}

build_all_parent_repos() {
  log_progress 'Building parent repos'
  for r in "${CEDAR_PARENT_REPOS[@]}"; do
    build_repo "$r"
  done
}

build_all_library_repos() {
  log_progress 'Building library repos'
  for r in "${CEDAR_LIBRARY_REPOS[@]}"; do
    build_repo "$r"
  done
}

build_all_project_repos() {
  log_progress 'Building project repos'
  for r in "${CEDAR_PROJECT_REPOS[@]}"; do
    build_repo "$r"
  done
}

log_progress 'Release process START'
log_progress "Release version ${CEDAR_RELEASE_VERSION}"

clone_repos_if_needed
git_pull_all_repos

empty_user_maven_cache

execute_jaxb2_workaround

build_all_parent_repos
build_all_library_repos
build_all_project_repos

release_all_parent_repos
release_all_library_repos
release_all_server_repos
release_all_project_repos
release_all_util_repos

release_all_client_repos

release_all_frontend_old_repos
release_all_frontend_new_repos

release_all_component_repos

release_all_documentation_repos

release_all_docker_build_repos
release_all_docker_deploy_repos

release_all_development_repos

log_progress 'Release process DONE'
#TODO check that main release version builds locally and that the next snapshot builds locally.
