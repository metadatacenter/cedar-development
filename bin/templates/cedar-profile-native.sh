#!/bin/bash

# The CEDAR environment for a native host, in one version-controlled file.
#
# It takes one input, CEDAR_PROFILE, which is `develop` for a workstation and `server` for a
# staging or production host. Everything else is either derived from CEDAR_HOME and CEDAR_HOST or
# read from this installation's own set-env-external.sh and set-env-internal.sh, which hold the
# host's identity and its credentials and stay outside version control.
#
# Source it directly. A host whose login shell names its own profile file keeps that file, reduced
# to the two lines that set CEDAR_PROFILE and source this one.

CEDAR_PROFILE="${CEDAR_PROFILE:-}"
if [ "$CEDAR_PROFILE" != "develop" ] && [ "$CEDAR_PROFILE" != "server" ]; then
  echo "CEDAR_PROFILE must be set to develop or server before sourcing $BASH_SOURCE" >&2
  return 1 2>/dev/null || exit 1
fi
export CEDAR_PROFILE

#------------------------------------------------------
# CEDAR Development Util home folder
export CEDAR_DEVELOP_HOME=${CEDAR_HOME}/cedar-development

#------------------------------------------------------
# Home folders of software components
export CEDAR_KEYCLOAK_HOME=${CEDAR_HOME}/keycloak/
export CEDAR_NEO4J_HOME=${CEDAR_HOME}/neo4j/

#------------------------------------------------------
# CEDAR network settings
# Set before the installation's own files, which read the gateway: set-env-internal.sh derives
# CEDAR_LOG_MYSQL_HOST from it, and a profile sourced into a clean environment left that empty.
export CEDAR_NET_GATEWAY=127.0.0.1
export CEDAR_NET_SUBNET=127.0.0.0

#------------------------------------------------------
# This installation's own environment: its host, its credentials, its external services
source ${CEDAR_HOME}/set-env-external.sh
source ${CEDAR_HOME}/set-env-internal.sh

#------------------------------------------------------
# CEDAR generic environment variables
source ${CEDAR_DEVELOP_HOME}/bin/util/set-env-generic.sh

#------------------------------------------------------
# CEDAR aliases and colors
# The infrastructure aliases follow the operating system, which the host answers for itself, and
# not the profile: a CentOS staging host and a CentOS workstation want the same ones.
source ${CEDAR_DEVELOP_HOME}/bin/util/set-dev-aliases.sh
if [ "$(uname -s)" = "Darwin" ]; then
  source ${CEDAR_DEVELOP_HOME}/bin/util/set-infra-aliases-osx.sh
elif [ -f /etc/redhat-release ]; then
  source ${CEDAR_DEVELOP_HOME}/bin/util/set-infra-aliases-centos.sh
else
  source ${CEDAR_DEVELOP_HOME}/bin/util/set-infra-aliases-ubuntu.sh
fi

#------------------------------------------------------
# What the profile decides
#
# A workstation serves the frontends from a development build and talks to Keycloak over locally
# issued .orgx leaves that no JVM truststore carries, which is the one thing that needs the
# verification bypass. Certificate and hostname verification stay on everywhere else.
if [ "$CEDAR_PROFILE" = "develop" ]; then
  export CEDAR_KEYCLOAK_ALLOW_INSECURE_TLS=true
  export CEDAR_FRONTEND_BEHAVIOR="develop"
  export CEDAR_FRONTEND_TARGET="local"
  export CEDAR_DEV_USE_PRIVATE_REPOS="true"
  export CEDAR_DEV_BUILD_FRONTENDS="true"
  CEDAR_TEST_USER1_LOGIN="test1@test.com"
  CEDAR_TEST_USER1_PASSWORD="test1"
  CEDAR_TEST_USER1_NAME="Test User 1"
  CEDAR_TEST_USER2_LOGIN="test2@test.com"
  CEDAR_TEST_USER2_PASSWORD="test2"
  CEDAR_TEST_USER2_NAME="Test User 2"
  export CEDAR_TEST_USER1_ID="https://metadatacenter.org/users/11111111-2222-3333-4444-555555555555"
  export CEDAR_TEST_USER2_ID="https://metadatacenter.org/users/66666666-7777-8888-9999-000000000000"
else
  export CEDAR_KEYCLOAK_ALLOW_INSECURE_TLS=false
  export CEDAR_FRONTEND_BEHAVIOR="server"
  export CEDAR_FRONTEND_TARGET="server"
  export CEDAR_DEV_USE_PRIVATE_REPOS="false"
  export CEDAR_DEV_BUILD_FRONTENDS="false"
  # The frontend builds require these to be set and use them for nothing but the Protractor
  # configuration, which a server never runs. They reach no served payload.
  CEDAR_TEST_USER1_LOGIN="-"
  CEDAR_TEST_USER1_PASSWORD="-"
  CEDAR_TEST_USER1_NAME="-"
  CEDAR_TEST_USER2_LOGIN="-"
  CEDAR_TEST_USER2_PASSWORD="-"
  CEDAR_TEST_USER2_NAME="-"
  export CEDAR_TEST_USER1_ID="-"
  export CEDAR_TEST_USER2_ID="-"
fi

#------------------------------------------------------
# Frontend connection settings
# The frontend builds read 'CEDAR_FRONTEND_' + ${CEDAR_FRONTEND_TARGET} + '_...', so the names are
# composed here rather than written out once per profile.
export "CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_UI_HOST=${CEDAR_HOST}"
export "CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_REST_HOST=${CEDAR_HOST}"
export "CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_USER1_LOGIN=${CEDAR_TEST_USER1_LOGIN}"
export "CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_USER1_PASSWORD=${CEDAR_TEST_USER1_PASSWORD}"
export "CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_USER1_NAME=${CEDAR_TEST_USER1_NAME}"
export "CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_USER2_LOGIN=${CEDAR_TEST_USER2_LOGIN}"
export "CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_USER2_PASSWORD=${CEDAR_TEST_USER2_PASSWORD}"
export "CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_USER2_NAME=${CEDAR_TEST_USER2_NAME}"
